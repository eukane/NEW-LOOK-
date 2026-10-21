# Cloudflare 배포 (한 번만 하면 됩니다)

서버를 Cloudflare에 올리면 컴퓨터를 켜 둘 필요 없이 **고정 주소**가 생깁니다.
방장은 사이트에서 방을 만들고 `초대 링크 복사`를 눌러 친구에게 보내면 됩니다.
(무료 플랜으로 충분합니다. 이 폴더 안에 `../assembly.html` 도 같이 번들됩니다.)

## 처음 배포
1. Cloudflare 계정 만들기 (무료): https://dash.cloudflare.com/sign-up
2. Node.js 22 이상(LTS 권장, https://nodejs.org) 설치 후 이 폴더(`prototype/cloudflare`)에서:
   ```
   npm install
   npx wrangler login      # 브라우저가 열리면 허용
   npx wrangler deploy
   ```
3. 끝나면 `https://marionette-theatre.<내계정>.workers.dev` 주소가 출력됩니다. 이게 게임 주소입니다.

## 업데이트(신기능 반영)
`assembly.html` 을 고친 뒤 이 폴더에서 `npx wrangler deploy` 한 번이면 끝입니다. 몇 초 걸립니다.

## 로컬 테스트
`npx wrangler dev` → http://localhost:8787 (실제 배포와 같은 구조로 돌아갑니다)

## 구조
- Worker가 `/` 로 게임 페이지를, `/ws` 로 WebSocket을 처리합니다.
- 방 1개 = Durable Object 1개. 방장 브라우저가 게임을 계산하고 서버는 중계만 합니다 (`../server.js` 와 같은 프로토콜).
- 방은 비어 있으면 자동으로 사라집니다. 방장이 나가면 방이 닫힙니다.

자동 배포: GitHub Actions(.github/workflows/deploy-cloudflare.yml)가 이 폴더나 assembly.html 변경 푸시 시 실행됩니다. 시크릿 CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID 필요.
