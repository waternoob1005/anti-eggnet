const { Authflow } = require('prismarine-auth')

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

function xblHeader(userHash, xstsToken, contractVersion = '107') {
    return {
        Authorization: `XBL3.0 x=${userHash};${xstsToken}`,
        'x-xbl-contract-version': contractVersion,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    }
}

async function getFriends(auth) {
    const res = await fetch(
        'https://peoplehub.xboxlive.com/users/me/people/social/decoration/presenceDetail,multiplayerSummary',
        {
            headers: xblHeader(auth.xblUserHash, auth.xblXstsToken, '5'),
            signal: AbortSignal.timeout(60000),
        }
    )

    if (!res.ok) throw new Error(`People API 실패: ${res.status}`)

    return (await res.json()).people || []
}

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

async function getSessionDetail(auth, scid, templateName, sessionName) {
    try {
        const url = `https://sessiondirectory.xboxlive.com/serviceconfigs/${scid}/sessiontemplates/${templateName}/sessions/${sessionName}`;
        const res = await fetch(url, {
            headers: xblHeader(auth.xblUserHash, auth.xblXstsToken, '107'),
            signal: AbortSignal.timeout(60000),
        })

        if (!res.ok) return null

        const text = await res.text()

        if (!text?.trim()) return null

        return JSON.parse(text)
    } catch (e) {
        return null
    }
}

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

function classifyServer(custom) {
    if (custom.RealmId) return 'realm'

    const b = custom.BroadcastSetting ?? 0

    if (b === 3) return 'public'
    if (b === 2) return 'invite'

    return 'local'
}

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
        worldName: custom.worldName || session.name,
        worldType: custom.worldType || null,
        version: custom.version || null,
        currentPlayers: custom.MemberCount ?? memberList.length,
        maxPlayers: custom.MaxMemberCount ?? null,
        broadcastSetting: custom.BroadcastSetting ?? null,
        serverType: classifyServer(custom),
        realmId: custom.RealmId || null,
        ipConn:    connections.find(c => c.connectionType === 1 || c.connectionType === 2) || null,
        nnConn:    connections.find(c => c.connectionType === 6 || c.connectionType === 7) || null,
        realmConn: connections.find(c => c.connectionType === 3) || null,
        members: memberList,
    }
}

async function main() {
    console.log('Xbox Live verification started')
    const auth = await getAuthInfo()
    console.log(`Verification success`)

    console.log('Getting server info')
    const friends = await getFriends(auth)
    const friendMap = {}
    for (const f of friends) { if (f.xuid) friendMap[f.xuid] = f.gamertag; }

    const xuids = friends.map(f => f.xuid).filter(Boolean)
    const mcbePresence = await getMcbeOnlineFriends(auth, xuids)

    const serverByHostXuid = new Map()
    const allXuids = new Set([auth.xuid])
    const total = mcbePresence.length

    if (total > 0) {
        for (let i = 0; i < total; i++) {
            const presence = mcbePresence[i]
            const gamertag = friendMap[presence.xuid] || presence.xuid

            const handles = await getActivityHandles(auth, presence.xuid)

            for (const handle of handles) {
                const { scid, templateName, name } = handle.sessionRef
                const session = await getSessionDetail(auth, scid, templateName, name)
                if (!session) continue

                const parsed = parseSession(session, handle)
                const key = parsed.hostXuid || parsed.handleId
                if (serverByHostXuid.has(key)) continue

                serverByHostXuid.set(key, parsed)
                parsed.members.forEach(m => { if (m.xuid) allXuids.add(m.xuid); })
                if (parsed.hostXuid) allXuids.add(parsed.hostXuid)
            }
        }
    }

    const profiles = await getProfiles(auth, [...allXuids])
    const profileMap = buildProfileMap(profiles)

    const publicServers = [...serverByHostXuid.values()].filter(s => s.serverType === 'public')

    console.log(`Now server count is ${publicServers.length}`)
    console.log('━'.repeat(60))

    for (const server of publicServers) {
        const hostProfile = profileMap[server.hostXuid];
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
        });
        console.log('━'.repeat(60))
    }
}

main().catch(err => {
    process.stdout.write('\x1B[?25h')
    console.error(err)
})
