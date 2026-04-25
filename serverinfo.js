const { Authflow } = require('prismarine-auth')

// ── 인증 정보 가져오기 ──
async function getAuthInfo() {
    const flow = new Authflow('', './auth-cache')
    const xblToken = await flow.getXboxToken('http://xboxlive.com')
    const mcbeToken = await flow.getXboxToken('https://multiplayer.minecraft.net/')
    return {
        xuid: xblToken.userXUID,
        xblXstsToken: xblToken.XSTSToken,
        xblUserHash: xblToken.userHash,
        mcbeXstsToken: mcbeToken.XSTSToken,
        mcbeUserHash: mcbeToken.userHash,
    }
}

// ── Xbox Live API 요청 헤더 생성 ──
function xblHeader(userHash, xstsToken, contractVersion = '107') {
    return {
        Authorization: `XBL3.0 x=${userHash};${xstsToken}`,
        'x-xbl-contract-version': contractVersion,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    }
}

// ── social(맞팔) + following(내가 추가) 합치기 ──
async function getAllPeople(auth) {
    const [socialRes, followingRes] = await Promise.all([
        fetch('https://peoplehub.xboxlive.com/users/me/people/social', {
            headers: xblHeader(auth.xblUserHash, auth.xblXstsToken, '5'),
            signal: AbortSignal.timeout(60000),
        }),
        fetch('https://peoplehub.xboxlive.com/users/me/people/following', {
            headers: xblHeader(auth.xblUserHash, auth.xblXstsToken, '5'),
            signal: AbortSignal.timeout(60000),
        }),
    ])

    const socialPeople = socialRes.ok ? (await socialRes.json()).people || [] : []
    const followingPeople = followingRes.ok ? (await followingRes.json()).people || [] : []

    // xuid 기준 중복 제거
    const map = new Map()
    for (const p of [...socialPeople, ...followingPeople]) {
        if (p.xuid) map.set(p.xuid, p)
    }
    return [...map.values()]
}

// ── MCBE 접속 중인 사람 필터링 (presence 배치 조회) ──
async function getMcbeOnlineFriends(auth, xuids) {
    const MCBE_TITLE_IDS = new Set(['1739947436', '896928775', '1810924247', '2044456598', '1828326430'])
    const res = await fetch('https://userpresence.xboxlive.com/users/batch', {
        method: 'POST',
        headers: xblHeader(auth.xblUserHash, auth.xblXstsToken, '3'),
        body: JSON.stringify({
            users: xuids,
            onlineOnly: true,
            deviceTypes: ['XboxOne', 'WindowsOneCore', 'Android', 'iOS', 'Nintendo'],
        }),
        signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) return []
    const data = await res.json()
    return data.filter(p =>
        p.devices?.some(d => d.titles?.some(t => MCBE_TITLE_IDS.has(String(t.id))))
    )
}

// ── 특정 xuid의 activity handle 목록 조회 ──
// customProperties가 포함된 핸들을 반환함
async function getActivityHandles(auth, xuid) {
    try {
        const res = await fetch(
            'https://sessiondirectory.xboxlive.com/handles/query?include=relatedInfo,customProperties',
            {
                method: 'POST',
                headers: xblHeader(auth.xblUserHash, auth.xblXstsToken, '107'),
                body: JSON.stringify({
                    type: 'activity',
                    scid: '4fc10100-5f7a-4470-899b-280835760c07',
                    owners: { people: { moniker: 'people', monikerXuid: xuid } }
                }),
                signal: AbortSignal.timeout(60000),
            }
        )
        if (!res.ok) return []
        return (await res.json()).results || []
    } catch (e) {
        return []
    }
}

// ── 세션 상세 정보 조회 (xbl → mcbe 순으로 시도) ──
async function getSessionDetail(auth, scid, templateName, sessionName) {
    const url = `https://sessiondirectory.xboxlive.com/serviceconfigs/${scid}/sessiontemplates/${templateName}/sessions/${sessionName.toLowerCase()}`
    try {
        const res = await fetch(url, {
            headers: xblHeader(auth.xblUserHash, auth.xblXstsToken, '107'),
            signal: AbortSignal.timeout(60000),
        })
        if (res.ok) {
            const text = await res.text()
            if (!text?.trim()) return null
            return JSON.parse(text)
        }
        // 403이면 mcbe 토큰으로 재시도
        if (res.status === 403) {
            const res2 = await fetch(url, {
                headers: xblHeader(auth.mcbeUserHash, auth.mcbeXstsToken, '107'),
                signal: AbortSignal.timeout(60000),
            })
            if (res2.ok) {
                const text2 = await res2.text()
                if (!text2?.trim()) return null
                return JSON.parse(text2)
            }
        }
        return null
    } catch (e) {
        return null
    }
}

// ── 프로필 일괄 조회 (100명씩 청크) ──
async function getProfiles(auth, xuids) {
    if (!xuids.length) return []
    const chunks = []
    for (let i = 0; i < xuids.length; i += 100) chunks.push(xuids.slice(i, i + 100))
    const profiles = []
    for (const chunk of chunks) {
        try {
            const res = await fetch('https://profile.xboxlive.com/users/batch/profile/settings', {
                method: 'POST',
                headers: xblHeader(auth.xblUserHash, auth.xblXstsToken, '2'),
                body: JSON.stringify({
                    userIds: chunk,
                    settings: ['GameDisplayName', 'GameDisplayPicRaw', 'Gamerscore',
                               'XboxOneRep', 'Bio', 'ModernGamertag', 'UniqueModernGamertag'],
                }),
                signal: AbortSignal.timeout(60000),
            })
            if (!res.ok) continue
            profiles.push(...(await res.json()).profileUsers || [])
        } catch (e) {
            continue
        }
    }
    return profiles
}

// ── 프로필 배열을 xuid → 프로필 객체 맵으로 변환 ──
function buildProfileMap(profiles) {
    const map = {}
    for (const user of profiles) {
        const s = {}
        for (const item of user.settings || []) s[item.id] = item.value
        map[user.id] = {
            xuid: user.id,
            gamertag: s['ModernGamertag'] || s['GameDisplayName'] || '알 수 없음',
            uniqueGamertag: s['UniqueModernGamertag'] || null,
            profilePicUrl: s['GameDisplayPicRaw'] || null,
            gamerscore: s['Gamerscore'] || '0',
            reputation: s['XboxOneRep'] || null,
            bio: s['Bio'] || null,
        }
    }
    return map
}

// ── 서버 공개 범위 분류 ──
// BroadcastSetting 3 또는 2+joinable_by_friends = 마크에 뜨는 서버
// BroadcastSetting 1 또는 invite_only = 비공개
// RealmId 있으면 Realm
function classifyServer(custom) {
    if (custom.RealmId) return 'realm'
    const b = custom.BroadcastSetting ?? 0
    const joinability = custom.Joinability || ''
    if (b === 3) return 'public'
    if (b === 2 && joinability === 'joinable_by_friends') return 'public'
    return 'local'
}

// ── 핸들의 customProperties에서 서버 정보 파싱 ──
// 세션 직접 조회 없이 핸들만으로 서버 정보 추출
function parseHandle(handle) {
    const custom = handle?.customProperties || {}
    if (!custom || Object.keys(custom).length === 0) return null
    if (!custom.worldName) return null

    const connections = (custom.SupportedConnections || []).map(conn => ({
        connectionType: conn.ConnectionType,
        host: conn.HostIpAddress || null,
        port: conn.HostPort || null,
        netherNetId: conn.NetherNetId || null,
        pmsgId: conn.PmsgId || null,
    }))

    return {
        handleId: handle.id || null,
        ownerXuid: handle.ownerXuid || null,
        hostXuid: custom.ownerId || handle.ownerXuid || null,
        hostName: custom.hostName || null,
        worldName: custom.worldName || null,
        worldType: custom.worldType || null,
        version: custom.version || null,
        currentPlayers: custom.MemberCount ?? null,
        maxPlayers: custom.MaxMemberCount ?? null,
        broadcastSetting: custom.BroadcastSetting ?? null,
        serverType: classifyServer(custom),
        realmId: custom.RealmId || null,
        levelId: custom.levelId || null,
        ipConn:    connections.find(c => c.connectionType === 1 || c.connectionType === 2) || null,
        nnConn:    connections.find(c => c.connectionType === 6 || c.connectionType === 7) || null,
        realmConn: connections.find(c => c.connectionType === 3) || null,
        members: [],
    }
}

// ── 세션 상세에서 서버 정보 파싱 ──
function parseSession(session, handle) {
    const custom = session?.properties?.custom || {}
    const members = session?.members || {}
    const memberList = Object.entries(members).map(([, m]) => ({
        xuid: m.constants?.system?.xuid || null,
        gamertag: m.constants?.system?.gamertag || null,
    }))
    const connections = (custom.SupportedConnections || []).map(conn => ({
        connectionType: conn.ConnectionType,
        host: conn.HostIpAddress || null,
        port: conn.HostPort || null,
        netherNetId: conn.NetherNetId || null,
        pmsgId: conn.PmsgId || null,
    }))
    return {
        handleId: handle?.id || null,
        ownerXuid: handle?.ownerXuid || null,
        hostXuid: custom.ownerId || null,
        hostName: custom.hostName || null,
        worldName: custom.worldName || null,
        worldType: custom.worldType || null,
        version: custom.version || null,
        currentPlayers: custom.MemberCount ?? memberList.length,
        maxPlayers: custom.MaxMemberCount ?? null,
        broadcastSetting: custom.BroadcastSetting ?? null,
        serverType: classifyServer(custom),
        realmId: custom.RealmId || null,
        levelId: custom.levelId || null,
        ipConn:    connections.find(c => c.connectionType === 1 || c.connectionType === 2) || null,
        nnConn:    connections.find(c => c.connectionType === 6 || c.connectionType === 7) || null,
        realmConn: connections.find(c => c.connectionType === 3) || null,
        members: memberList,
    }
}

// ── 서버 중복 제거용 키 생성 ──
// levelId > hostXuid+worldName > handleId 순으로 사용
function getServerKey(parsed) {
    if (parsed.levelId) return parsed.levelId
    if (parsed.hostXuid && parsed.worldName) return `${parsed.hostXuid}:${parsed.worldName}`
    return parsed.handleId
}

// ── 핸들 목록을 serverMap에 추가 ──
// 핸들에서 바로 파싱하고, 정보 없으면 세션 직접 조회
async function processHandles(auth, handles, serverMap, allXuids) {
    for (const handle of handles) {
        // 1차: customProperties에서 바로 파싱
        const fromHandle = parseHandle(handle)
        if (fromHandle) {
            const key = getServerKey(fromHandle)
            if (!serverMap.has(key)) {
                serverMap.set(key, fromHandle)
                if (fromHandle.hostXuid) allXuids.add(fromHandle.hostXuid)
            }
            continue
        }

        // 2차: customProperties 없으면 세션 직접 조회
        const { scid, templateName, name } = handle.sessionRef
        const session = await getSessionDetail(auth, scid, templateName, name)
        if (!session) continue

        const parsed = parseSession(session, handle)
        if (!parsed.worldName) continue

        const key = getServerKey(parsed)
        if (serverMap.has(key)) continue

        serverMap.set(key, parsed)
        parsed.members?.forEach(m => { if (m.xuid) allXuids.add(m.xuid) })
        if (parsed.hostXuid) allXuids.add(parsed.hostXuid)
    }
}

async function main() {
    console.log('Xbox Live verification started')
    const auth = await getAuthInfo()
    console.log('Verification success')

    console.log('Getting server info')

    // social + following 전체 목록
    const friends = await getAllPeople(auth)
    const friendMap = {}
    for (const f of friends) { if (f.xuid) friendMap[f.xuid] = f.gamertag }

    const xuids = friends.map(f => f.xuid).filter(Boolean)

    // MCBE 접속 중인 사람 필터
    const mcbePresence = await getMcbeOnlineFriends(auth, xuids)

    const serverMap = new Map()
    const allXuids = new Set([auth.xuid])

    // ── 1단계: MCBE 접속 중인 사람의 handles 조회 ──
    for (const presence of mcbePresence) {
        const handles = await getActivityHandles(auth, presence.xuid)
        await processHandles(auth, handles, serverMap, allXuids)
    }

    // ── 2단계: handles의 customProperties.ownerId에서 호스트 XUID 수집 ──
    // 호스트가 오프라인이어도 참가자를 통해 서버를 발견할 수 있음
    // 이미 찾은 서버들의 hostXuid로 추가 handles 조회
    const discoveredHostXuids = new Set(
        [...serverMap.values()]
            .map(s => s.hostXuid)
            .filter(Boolean)
    )

    // 핸들에서 발견한 ownerXuid도 수집 (호스트가 오프라인인 경우 대비)
    for (const presence of mcbePresence) {
        const handles = await getActivityHandles(auth, presence.xuid)
        for (const handle of handles) {
            const ownerId = handle.customProperties?.ownerId
            if (ownerId && !discoveredHostXuids.has(ownerId)) {
                discoveredHostXuids.add(ownerId)
                // 이 호스트의 handles도 추가로 조회
                const hostHandles = await getActivityHandles(auth, ownerId)
                await processHandles(auth, hostHandles, serverMap, allXuids)
            }
        }
    }

    // 프로필 조회
    const profiles = await getProfiles(auth, [...allXuids])
    const profileMap = buildProfileMap(profiles)

    // public 서버만 출력
    const publicServers = [...serverMap.values()].filter(s => s.serverType === 'public')

    console.log(`Now server count is ${publicServers.length}`)
    console.log('━'.repeat(60))

    for (const server of publicServers) {
        const hostProfile = profileMap[server.hostXuid]
        console.log({
            worldName:     server.worldName,
            hostName:      hostProfile?.gamertag ?? server.hostName,
            gameMode:      server.worldType,
            handleId:      server.handleId,
            version:       server.version,
            currentPlayer: server.currentPlayers,
            maxPlayers:    server.maxPlayers,
            xuid:          server.hostXuid,
            image:         hostProfile?.profilePicUrl ?? null,
        })
        console.log('━'.repeat(60))
    }
}

main().catch(err => {
    process.stdout.write('\x1B[?25h')
    console.error(err)
})
