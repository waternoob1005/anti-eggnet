const { Authflow } = require('prismarine-auth')

// ── 인증 정보 가져오기 (serverinfo.js와 동일한 auth-cache 공유) ──
async function getAuthInfo() {
    const flow = new Authflow('', './auth-cache')
    const xblToken = await flow.getXboxToken('http://xboxlive.com')
    return {
        xuid: xblToken.userXUID,
        xblXstsToken: xblToken.XSTSToken,
        xblUserHash: xblToken.userHash,
    }
}

// ── Xbox Live API 요청 헤더 생성 ──
function xblHeader(userHash, xstsToken, contractVersion = '2') {
    return {
        Authorization: `XBL3.0 x=${userHash};${xstsToken}`,
        'x-xbl-contract-version': contractVersion,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Language': 'en-US',
    }
}

// ── 게이머태그로 유저 검색 → XUID 반환 ──
// peoplehub search API: 실제 Xbox 앱이 사용하는 검색 엔드포인트
async function resolveGamertag(auth, gamertag) {
    const url = `https://peoplehub.xboxlive.com/users/me/people/search/decoration/detail,preferredColor?q=${encodeURIComponent(gamertag)}&maxItems=25`
    const res = await fetch(url, {
        headers: xblHeader(auth.xblUserHash, auth.xblXstsToken, '5'),
        signal: AbortSignal.timeout(60000),
    })

    if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`검색 API 실패 (HTTP ${res.status}): ${body}`)
    }

    const data = await res.json()
    const people = data.people || []

    if (people.length === 0) {
        throw new Error(`"${gamertag}" 에 해당하는 유저를 찾을 수 없습니다.`)
    }

    // 검색 결과 중 게이머태그가 정확히 일치하는 유저 우선
    // (대소문자 무시, ModernGamertag와 기존 Gamertag 모두 체크)
    const normalized = gamertag.toLowerCase()
    const exact = people.find(p =>
        (p.modernGamertag?.toLowerCase() === normalized) ||
        (p.gamertag?.toLowerCase() === normalized)
    )
    const target = exact ?? people[0]

    return {
        xuid: target.xuid,
        gamertag: target.modernGamertag || target.gamertag,
        displayName: target.displayName || null,
        profilePicUrl: target.displayPicRaw || null,
        isFollowing: target.isFollowing ?? false,
        isFollowedBy: target.isFollowedBy ?? false,
    }
}

// ── XUID로 친구 추가 (follow) ──
// social.xboxlive.com PUT /users/me/people/xuid({xuid})
async function addFriend(auth, xuid) {
    const url = `https://social.xboxlive.com/users/me/people/xuid(${xuid})`
    const res = await fetch(url, {
        method: 'PUT',
        headers: xblHeader(auth.xblUserHash, auth.xblXstsToken, '2'),
        signal: AbortSignal.timeout(60000),
    })

    // 204 No Content = 성공, 200도 성공으로 처리
    if (res.ok || res.status === 204) return { success: true }

    const body = await res.text().catch(() => '')
    throw new Error(`친구 추가 실패 (HTTP ${res.status}): ${body}`)
}

// ── CLI 인수 파싱 ──
function parseArgs() {
    const args = process.argv.slice(2)
    if (args.length === 0) {
        console.error('사용법: node portal.js <게이머태그> [게이머태그2 ...]')
        console.error('예시:  node portal.js ExamplePlayer')
        console.error('       node portal.js Player1 Player2 Player3')
        process.exit(1)
    }
    return args
}

async function main() {
    const gamertags = parseArgs()

    console.log('Xbox Live 인증 중...')
    const auth = await getAuthInfo()
    console.log(`인증 완료 (내 XUID: ${auth.xuid})`)
    console.log('━'.repeat(60))

    let successCount = 0
    let failCount = 0

    for (const gamertag of gamertags) {
        console.log(`\n▶ 처리 중: ${gamertag}`)

        try {
            // 1단계: 게이머태그 → XUID 검색
            console.log(`  [1/2] 유저 검색 중...`)
            const user = await resolveGamertag(auth, gamertag)
            console.log(`  ✓ 발견: ${user.gamertag} (XUID: ${user.xuid})`)

            if (user.xuid === auth.xuid) {
                console.log(`  ✗ 건너뜀: 자기 자신은 추가할 수 없습니다.`)
                failCount++
                continue
            }

            if (user.isFollowing) {
                console.log(`  ✓ 이미 팔로우 중입니다. (건너뜀)`)
                successCount++
                continue
            }

            // 2단계: 친구 추가
            console.log(`  [2/2] 친구 추가 요청 중...`)
            await addFriend(auth, user.xuid)
            console.log(`  ✓ 친구 추가 완료!${user.isFollowedBy ? ' (상대방도 나를 팔로우 중 → 맞팔 성립)' : ''}`)
            successCount++

        } catch (err) {
            console.error(`  ✗ 실패: ${err.message}`)
            failCount++
        }
    }

    console.log('\n' + '━'.repeat(60))
    console.log(`완료: 성공 ${successCount}명, 실패 ${failCount}명`)
}

main().catch(err => {
    console.error('예기치 못한 오류:', err)
    process.exit(1)
})