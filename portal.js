const { BedrockPortal, Joinability, Modules } = require('bedrock-portal')

const main = async () => {
    const portal = new BedrockPortal({
        ip: '<ip>',
        port: 19132,
        joinability: Joinability.FriendsOfFriends,
        world: {
            hostName: 'AntiEggnet', // 미리보기 텍스트 설정
            name: 'AntiEggnet을 환영하세요! (URL 적기)'
        }
    })

    portal.use(Modules.AutoFriendAdd, { inviteOnAdd: false })

    await portal.start()
    console.log('포탈이 열렸습니다!')
}

main()