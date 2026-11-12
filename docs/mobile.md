# 휴대폰 대시보드

PC에서 도는 에이전트를 휴대폰 브라우저로 보고 답한다. 원격 데스크톱, 휴대폰 앱, 내 도메인이 없어도 된다.

| 할 수 있는 것 | 방법 |
|---|---|
| 모든 프로젝트 상태 보기 | 목록. `응답 필요`가 맨 위, 헤더에 개수 |
| 승인 질문에 답하기 | 프로젝트를 누르면 질문과 선택지 버튼이 위에 뜬다 (PC 카드의 버튼과 같은 키를 보낸다) |
| 지시 보내기 | 아래 입력창 → `보내기`. 선택지가 열려 있으면 먼저 답해야 한다 |
| 작업 중지 | `중지`를 두 번 누른다 (Esc 전송) |
| 결과 확인 | `답변` 탭: 내 지시, 진행 단계, AI 답변. `CLI 화면` 탭: 터미널 원문 |

셸 카드는 보이지 않는다. 에이전트 카드만 다룬다.

## 구조

```text
휴대폰 ──▶ https://mygdeck.asone26g.workers.dev   (Cloudflare Worker: 화면 + 하루 1회 비밀번호)
               │ /api/* 를 Workers VPC 바인딩 PC 로 중계
               ▼
           이름 있는 터널 "mygdeck"   (공개 주소 없음 · 도메인 불필요 · PC에서 밖으로만 연결)
               ▼
           이 PC 127.0.0.1:7781   (세션 데몬)
```

- 세션 데몬이 대시보드를 켜면 `cloudflared tunnel run`으로 이름 있는 터널을 띄운다. 덱이 꺼지면(데몬 종료) 터널도 내려간다.
- 터널에는 공개 주소가 없다. 이 터널로 PC에 닿을 수 있는 건 VPC 서비스 `mygdeck-pc`를 바인딩한 내 Worker뿐이다.
- 문은 두 겹이다. 휴대폰은 **비밀번호**(24시간 유지 쿠키)로 Worker를 통과한다. Worker는 **대시보드 토큰**을 붙여 PC로 중계하고, 데몬은 토큰이 없으면 거절한다. 휴대폰은 토큰을 모른다.
- 휴대폰은 1초마다 새 출력만 받아 간다(`/api/screen?from=`).

## Cloudflare에 만든 것

| 이름 | 종류 | 용도 |
|---|---|---|
| `mygdeck` | Worker (`cloud/worker.js`) | 화면, 로그인, 중계 |
| `mygdeck` | Tunnel `527387b1-…` | PC 연결 (공개 hostname 없음) |
| `mygdeck-pc` | VPC Service `01a1ce28-…` | 터널 → `127.0.0.1:7781` |
| `mygdeck-relay` | KV | 로그인 실패 횟수 |
| Worker 비밀값 | `DASH_PASSWORD`, `SESSION_SECRET`, `DASH_TOKEN` | 비밀번호, 쿠키 서명, 대시보드 토큰 |

PC 쪽: `~/.mygdeck/mobile.json`에 포트, 대시보드 토큰, Worker 주소, 터널 실행 토큰이 있다.

## 평소 사용

- 덱을 열면 터널이 연결된다. 확인: `mygdeck-cli mobile` → `터널: 연결됨`.
- 휴대폰에서 `https://mygdeck.asone26g.workers.dev` → 비밀번호 → 목록. **홈 화면에 추가**로 앱처럼 쓴다.
- 비밀번호를 10번 틀리면 그 주소는 15분간 막힌다.
- 덱이 꺼져 있으면 휴대폰에는 "PC에 연결할 수 없습니다"가 뜬다.

## 바꾸기

명령은 `cloud/` 폴더에서 실행한다. Worker 비밀값은 바로 반영된다(다시 배포 불필요).

| 하고 싶은 일 | 방법 |
|---|---|
| 비밀번호 변경 | `npx wrangler secret put DASH_PASSWORD` |
| 모든 휴대폰 로그아웃 | `SESSION_SECRET`을 새 무작위 값으로 |
| 휴대폰 화면 수정 반영 | `node build.mjs && npx wrangler deploy` |
| 대시보드 끄기 | `mygdeck-cli mobile off` (터널도 내려감). 다시 `on`하면 대시보드 토큰과 터널 토큰이 지워진 상태라 아래 처음 설정의 3~4단계를 다시 한다 |

## 처음 설정 (기록용, 이미 해 둠)

```bash
winget install --id Cloudflare.cloudflared            # macOS: brew install cloudflared
cd cloud
npx wrangler tunnel create mygdeck                     # 터널 ID
npx wrangler vpc service create mygdeck-pc --type http --tunnel-id <터널 ID> --ipv4 127.0.0.1 --http-port 7781
npx wrangler kv namespace create mygdeck-relay         # wrangler.toml에 KV id, VPC service_id
mygdeck-cli mobile on --url https://mygdeck.<계정>.workers.dev
<터널 실행 토큰> | mygdeck-cli mobile tunnel-token     # Cloudflare API cfd_tunnel/<ID>/token 으로 받는다
node build.mjs && npx wrangler deploy
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put SESSION_SECRET
mygdeck-cli mobile token | npx wrangler secret put DASH_TOKEN
npx wrangler secret put DASH_PASSWORD
```

## 제약

- **Workers VPC는 베타다.** 지금은 무료지만 정식 출시 뒤의 요금은 아직 공개되지 않았고, 기능이 바뀔 수 있다.
- Workers 무료 한도는 하루 10만 요청이다. 상세 화면을 열어 두면 1초에 한 번 조회하므로, 쉬지 않고 열어 둬도 하루 약 20시간 분량이다.
- HTTPS는 Cloudflare에서 풀리므로 이론상 Cloudflare는 트래픽을 볼 수 있다.
- 휴대폰 알림(푸시)은 아직 없다. 페이지가 열려 있을 때만 상태가 갱신되고, Android에서는 새 승인 대기에 진동한다.
- `mygdeck-cli mobile` 상태가 "이전 버전입니다"면 지금 도는 데몬이 이 기능 이전 빌드다. `mygdeck-cli daemon stop`(모든 세션 종료) 후 덱을 다시 연다.
