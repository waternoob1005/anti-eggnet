const { Authflow } = require('prismarine-auth');

async function getAuthInfo() {
    const flow = new Authflow('', './auth-cache');
    const xblToken = await flow.getXboxToken('http://xboxlive.com');
    const mcbeToken = await flow.getXboxToken('https://multiplayer.minecraft.net/');
    return {
        xuid: xblToken.userXUID,
        xblXstsToken: xblToken.XSTSToken,
        xblUserHash: xblToken.userHash,
        mcbeXstsToken: mcbeToken.XSTSToken,
        mcbeUserHash: mcbeToken.userHash,
    };
}

function xblHeader(userHash, xstsToken, contractVersion = '107') {
    return {
        Authorization: `XBL3.0 x=${userHash};${xstsToken}`,
        'x-xbl-contract-version': contractVersion,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };
}

async function getFriends(auth) {
    const res = await fetch(
        'https://peoplehub.xboxlive.com/users/me/people/social/decoration/presenceDetail,multiplayerSummary',
        { headers: xblHeader(auth.xblUserHash, auth.xblXstsToken, '5') }
    );
    if (!res.ok) throw new Error(`People API 실패: ${res.status}`);
    return (await res.json()).people || [];
}

async function getPresenceBatch(auth, xuids) {
    const chunks = [];
    for (let i = 0; i < xuids.length; i += 200) chunks.push(xuids.slice(i, i + 200));
    const results = [];
    for (const chunk of chunks) {
        const res = await fetch('https://userpresence.xboxlive.com/users/batch', {
            method: 'POST',
            headers: xblHeader(auth.xblUserHash, auth.xblXstsToken, '3'),
            body: JSON.stringify({
                users: chunk,
                onlineOnly: false,
                deviceTypes: ['XboxOne', 'WindowsOneCore', 'Android', 'iOS', 'Nintendo'],
            }),
        });
        if (!res.ok) continue;
        results.push(...await res.json());
    }
    return results;
}

async function getActivityHandles(auth, xuid) {
    const res = await fetch(
        'https://sessiondirectory.xboxlive.com/handles/query?include=relatedInfo,customProperties',
        {
            method: 'POST',
            headers: xblHeader(auth.xblUserHash, auth.xblXstsToken, '107'),
            body: JSON.stringify({
                type: 'activity',
                scid: '4fc10100-5f7a-4470-899b-280835760c07',
                owners: {
                    people: {
                        moniker: 'people',
                        monikerXuid: xuid,
                    }
                }
            }),
        }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
}

async function getSessionDetail(auth, scid, templateName, sessionName) {
    const url = `https://sessiondirectory.xboxlive.com/serviceconfigs/${scid}/sessiontemplates/${templateName}/sessions/${sessionName}`;
    const res = await fetch(url, {
        headers: xblHeader(auth.xblUserHash, auth.xblXstsToken, '107'),
    });
    if (!res.ok) return null;
    return res.json();
}

function getHostXuidFromSession(session) {
    const members = session?.members || {};
    const hostDeviceToken = session?.properties?.system?.host;

    for (const [, m] of Object.entries(members)) {
        if (hostDeviceToken && m.constants?.system?.deviceToken === hostDeviceToken) {
            return m.constants?.system?.xuid || null;
        }
    }

    // fallback: 첫 번째 멤버
    const first = Object.values(members)[0];
    return first?.constants?.system?.xuid || null;
}

// ─────────────────────────────────────────
// 세션 파싱
// ─────────────────────────────────────────
function parseSession(session, handle) {
    const custom = session?.properties?.custom || {};
    const members = session?.members || {};

    const serverHost =
        custom.hostName || custom.serverHost || custom.address ||
        custom.externalIP || custom.BroadcastAddress || null;
    const serverPort = parseInt(custom.port || custom.serverPort || custom.BroadcastPort || 19132);

    // 세션 이름 (MCBE는 levelId나 worldName을 custom에 넣기도 함)
    const serverName =
        custom.worldName || custom.levelId || custom.serverName ||
        custom.hostName || session.name;

    const memberList = Object.entries(members).map(([key, m]) => ({
        index: key,
        xuid: m.constants?.system?.xuid || null,
        gamertag: m.constants?.system?.gamertag || null,
        deviceToken: m.constants?.system?.deviceToken || null,
        isActive: m.properties?.system?.active ?? false,
    }));

    const hostXuid = getHostXuidFromSession(session);

    return {
        handleId: handle?.id || null,
        sessionName: session.name,
        serverName,
        scid: handle?.sessionRef?.scid,
        templateName: handle?.sessionRef?.templateName,
        handleOwnerXuid: handle?.ownerXuid || null,
        hostXuid,                                  
        serverHost,
        serverPort,
        memberCount: memberList.length,
        members: memberList,
        rawCustom: custom,
    };
}

async function getProfiles(auth, xuids) {
    if (!xuids.length) return [];
    const chunks = [];
    for (let i = 0; i < xuids.length; i += 100) chunks.push(xuids.slice(i, i + 100));
    const profiles = [];
    for (const chunk of chunks) {
        const res = await fetch('https://profile.xboxlive.com/users/batch/profile/settings', {
            method: 'POST',
            headers: xblHeader(auth.xblUserHash, auth.xblXstsToken, '2'),
            body: JSON.stringify({
                userIds: chunk,
                settings: [
                    'GameDisplayName',
                    'GameDisplayPicRaw',
                    'Gamerscore',
                    'XboxOneRep',
                    'Bio',
                    'Location',
                    'ModernGamertag',
                    'UniqueModernGamertag',
                ],
            }),
        });
        if (!res.ok) continue;
        const data = await res.json();
        profiles.push(...(data.profileUsers || []));
    }
    return profiles;
}

function buildProfileMap(profiles) {
    const map = {};
    for (const user of profiles) {
        const s = {};
        for (const item of user.settings || []) s[item.id] = item.value;
        map[user.id] = {
            xuid: user.id,
            gamertag: s['ModernGamertag'] || s['GameDisplayName'] || '알 수 없음',
            uniqueGamertag: s['UniqueModernGamertag'] || null,
            profilePicUrl: s['GameDisplayPicRaw'] || null,
            gamerscore: s['Gamerscore'] || '0',
            reputation: s['XboxOneRep'] || null,
            bio: s['Bio'] || null,
            location: s['Location'] || null,
        };
    }
    return map;
}

let hosts = []

async function main() {
    hosts = []
    console.log('🔐 인증 중...')
    const auth = await getAuthInfo()
    console.log(`✅ XUID: ${auth.xuid}\n`)

    const friends = await getFriends(auth)
    const friendMap = {};
    for (const f of friends) { if (f.xuid) friendMap[f.xuid] = f.gamertag; }

    const xuids = friends.map(f => f.xuid).filter(Boolean);
    const presenceList = await getPresenceBatch(auth, xuids);

    const MCBE_TITLE_IDS = new Set(['1810924247', '896928775', '2044456598', '1828326430', '1739947436']);
    const mcbePresence = presenceList.filter(p =>
        p.devices?.some(d => d.titles?.some(t => MCBE_TITLE_IDS.has(String(t.id))))
    );
    console.log(`🎮 MCBE 친구 수: ${mcbePresence.length}/${friends.length}명\n`)

    const serverMap = new Map();
    const allXuids = new Set([auth.xuid]);

    let count = 0

    console.log(`서버 추적 시작...`)

    for (const presence of mcbePresence) {
        const gamertag = friendMap[presence.xuid] || presence.xuid;
        count += 1
        console.log(`${(count / mcbePresence.length) * 100}% 조회됨`)

        const handles = await getActivityHandles(auth, presence.xuid);
        if (!handles.length) {
            continue;
        }

        for (const handle of handles) {
            const { scid, templateName, name } = handle.sessionRef;

            if (serverMap.has(name)) {
                continue;
            }

            const session = await getSessionDetail(auth, scid, templateName, name);
            if (!session) continue;

            const parsed = parseSession(session, handle);

            const isHost = parsed.hostXuid === presence.xuid;
            parsed.isHostFriend = isHost;
            parsed.friendGamertag = gamertag;
            parsed.friendXuid = presence.xuid;

            serverMap.set(name, parsed);
            parsed.members.forEach(m => { if (m.xuid) allXuids.add(m.xuid); });
        }
    }

    const profiles = await getProfiles(auth, [...allXuids]);
    const profileMap = buildProfileMap(profiles);

    const hostedServers = [...serverMap.values()].filter(s => s.isHostFriend);
    const joinedServers = [...serverMap.values()].filter(s => !s.isHostFriend);

    console.log(`👣 서버 수: ${joinedServers.length}개`)

    console.log(`${'═'.repeat(55)}`);

    for (const server of [...hostedServers, ...joinedServers]) {
        const hostProfile = profileMap[server.hostXuid];

        if (!hosts.includes(hostProfile?.gamertag)) {
            console.log(`🔑 핸들 ID   : ${server.handleId}`);
            console.log(`🎮 서버 이름 : ${server.serverName || '(없음)'}`);
            console.log(`🏠 호스트    : ${hostProfile?.gamertag ?? server.hostXuid}`);
            console.log(`👥 멤버 수   : ${server.memberCount}명`);
            console.log(`🖼  프로필 사진: ${hostProfile.profilePicUrl}`);
            console.log(`${'═'.repeat(55)}`);

            hosts.push(hostProfile?.gamertag ?? server.hostXuid)
        }
    }
}

main().catch(console.error);