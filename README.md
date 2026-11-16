# MYG Deck

여러 프로젝트의 코딩 에이전트 CLI(Claude Code, Codex, Gemini CLI…)를 한 창에서 나란히 굴리는 바이브 코딩용 IDE.
창을 닫아도 에이전트는 계속 돌고, 다시 열면 하던 화면 그대로 이어 붙는다. 기획 문서는 [master.md](master.md).

## 실행

**`mygdeck.vbs`를 더블클릭**하면 콘솔 창 없이 바로 열린다(`mygdeck.bat`도 되지만 콘솔 창이 잠깐 보인다). 처음 한 번은 자동으로 빌드한다(몇 분). `mygdeck.vbs`는 이미 빌드된 앱을 그대로 열므로, 코드를 고친 뒤에는 `mygdeck.bat`으로 연다(실행할 때마다 바뀐 부분만 다시 빌드, 몇 초). 다시 빌드할 때 열려 있던 창은 닫히지만 에이전트 세션은 데몬에서 계속 돈다.
**어디서든 실행**: `bin\install.cmd`(macOS는 `bin/install.sh`)를 한 번 실행하면 `bin` 폴더가 PATH에 들어가고, 새 터미널 어디서든 `mygdeck`으로 연다. `mygdeck .`은 지금 폴더를 열고(상대 경로 가능), `mygdeck rebuild`는 다시 빌드한 뒤 열며(`--daemon`을 붙이면 세션 데몬까지 내린 뒤 재시작), `mygdeck status|send|daemon|mobile`은 `mygdeck-cli`로 넘어간다.
바탕화면 아이콘(Windows)은 `wscript.exe "<저장소>\mygdeck.vbs"`를 대상으로 하는 바로가기다(아이콘은 `src-tauri\icons\icon.ico`).

프로젝트는 빈 화면의 `+ 프로젝트 폴더 추가`(또는 `Ctrl+'`)로 폴더를 골라 추가한다.

**macOS**: `mygdeck.command`를 더블클릭한다(`mygdeck.bat`과 같은 일을 한다. 폴더를 넘기려면 터미널에서 `./mygdeck.command ~/work/a`). 처음 한 번은 Xcode 명령줄 도구(`xcode-select --install`), Rust, Node가 있어야 한다. Finder에서 연 앱도 로그인 셸(`$SHELL`)의 PATH를 읽어 오므로 Homebrew·npm으로 설치한 `claude`·`codex`·`git`을 찾는다. 빌드한 앱은 `src-tauri/target/debug/bundle/macos/mygdeck.app`에 생기고, Dock에 고정해 두고 열어도 된다.

개발용 명령:

```bash
npm install
npm run tauri dev                 # 개발 실행 (mygdeck.json의 프로젝트를 연다)
npm run tauri dev -- -- C:/work/a C:/work/b   # 프로젝트 경로를 직접 넘기기
npx tauri build --no-bundle       # 실행 파일 빌드 (src-tauri/target/release/mygdeck.exe, mygdeck-cli.exe)
npx tauri build --bundles app     # macOS: src-tauri/target/release/bundle/macos/mygdeck.app
```

프로젝트 목록은 `mygdeck.json`(현재 폴더, 없으면 홈 폴더)에 저장되어 다음 실행 때 그대로 열린다.

```json
{
  "projects": [
    { "path": "C:/work/mygstat", "agent": "claude-code", "model": "opus", "effort": "medium", "spec_file": "MASTER_SPEC.md" },
    { "path": "C:/work/api", "command": "ssh -t myserver claude" },
    { "path": "C:/work/web", "resume": false }
  ]
}
```

`model`과 `effort`는 카드 입력창에서 바꾸면 자동으로 저장되어 다음 실행에도 유지된다. `resume: false`는 재부팅 뒤 덱을 열 때 이전 대화 대신 새 대화로 시작한다(아래 [세션 유지](#세션-유지) 참고). 서버 쪽 세션까지 유지하려면 [docs/remote.md](docs/remote.md)의 tmux 설정을 쓴다.

## 단축키

덱 단축키는 모두 `Ctrl` 조합이다. 나머지 키는 CLI로 그대로 간다.

**macOS**에서는 `Ctrl` 대신 `⌘`를 쓴다(`⌘1~9`, `⌘P`, `⌘.` …). `⌃` 조합은 모두 CLI로 간다. 다만 macOS가 `⌘`로 먼저 가져가는 네 가지는 `⌃`로 남는다: `⌃Space`(다음 대기), `⌃Tab`(포커스 이동), `` ⌃` ``(셸), `⌃Q`(중지). `⌃Space`가 입력 소스 전환에 걸려 있으면 시스템 설정 → 키보드 → 키보드 단축키 → 입력 소스에서 바꾼다. 화면의 단축키 안내도 macOS에서는 `⌘`로 표시된다. `⌘W`는 창을 닫는다(세션은 데몬에서 계속 돈다). 카드 닫기는 탭의 `×`나 `⌘F4`(`fn` 키와 함께).

| 키 | 동작 |
|---|---|
| `Ctrl+1~9` / `Ctrl+PageUp·PageDown` | 프로젝트 이동 |
| `Ctrl+Space` | 입력을 기다리는 다음 프로젝트로 (승인 대기 → 실패 → 완료 순) |
| `Ctrl+0` | 전체 보기 |
| `Ctrl+K` | 커맨드 팔레트 (프로젝트 이동 · 카드 액션 · 설정 검색) |
| `Ctrl+=` / `Ctrl+-` | 카드 크기 (Full · Compact · Mini) |
| `Ctrl+Tab` | 카드 안 포커스 이동 (파일 · CLI · 입력창) |
| `Ctrl+P` | 파일 빠른 열기 (터미널(CLI·셸)에 포커스가 없을 때. macOS `⌘P`는 언제나) |
| `Ctrl+I` | 선택한 내용을 입력창에 넣기: 코드 뷰어 선택은 `@파일 L줄`, 터미널 선택은 코드 블록 |
| `Ctrl+;` | 스펙 패널 열기/닫기 |
| `` Ctrl+` `` | 사용자 셸 열기/닫기 |
| `Ctrl+Q` | 에이전트 작업 중지 (입력창 옆 `중지` 버튼과 같음). 중지한 지시는 이미지 미리보기와 함께 입력창에 되돌아온다 |
| `Ctrl+.` | GUI 화면 ↔ 원본 CLI |
| `Ctrl+'` / `Ctrl+F4` | 프로젝트 추가 / 닫기 |

## 테마

상단 오른쪽의 해·달 버튼으로 다크 → 밝게 → 시스템 설정 따라가기를 돌아가며 고른다. 기본은 다크다. 고른 값은 이 PC에 저장되어 다음 실행에도 유지된다. 밝은 테마에서는 터미널도 밝아지고, CLI가 어두운 화면을 가정하고 칠한 글자는 대비 4.5:1 이상으로 자동 보정된다.

## 세션 유지

에이전트와 셸은 앱 창이 아니라 **세션 데몬**(`mygdeck --daemon`, 메모리 9~15 MB)이 실행한다.

- 창을 닫거나 새로고침해도 에이전트는 하던 일을 계속한다. 다시 열면 최근 출력(세션당 256 KB)을 되살려 이어 붙는다.
- 카드를 닫으면(`Ctrl+F4`) 그 프로젝트의 에이전트와 셸이 끝난다. 창도 세션도 없는 상태가 30초 이어지면 데몬도 스스로 끝난다.
- 재부팅처럼 데몬까지 꺼진 뒤에는 어댑터의 `resume_args`로 프로젝트의 마지막 대화를 다시 연다(Claude Code는 `--continue`). 이어갈 대화가 없으면 새로 시작한다(창이 CLI의 응답 전에 닫혔다가 다시 열려도 같다). Claude Code로 확인했다([확인 상태](docs/adapters.md#확인-상태)).
- 창이 뒤에 있을 때 프로젝트가 승인을 기다리거나 작업을 마치면 시스템 알림과 작업 표시줄 깜빡임(macOS는 Dock 아이콘 튀기기)으로 알린다. 창으로 돌아오면 그 프로젝트로 바로 이동한다.

### 터미널에서 다루기 (`mygdeck-cli`)

```bash
mygdeck-cli status            # 프로젝트별 상태: working · waiting · done · idle
mygdeck-cli status --json     # 스크립트용
mygdeck-cli send api "테스트 돌리고 실패한 것만 고쳐줘"   # 폴더 이름 또는 전체 경로
mygdeck-cli daemon stop       # 데몬과 모든 세션 종료
mygdeck-cli mobile on         # 휴대폰 대시보드 연결 켜기 (off로 끄기, docs/mobile.md)
```

`send`는 hooks로 상태를 받는 에이전트(Claude Code)가 승인을 기다리는 중이면 거절한다. 그때 입력하면 승인 메뉴의 선택지가 눌리기 때문이다. 다른 에이전트와 원격 카드는 막지 않고, `status`에도 승인 대기가 나오지 않는다(working·idle만 표시). 이런 카드에는 창에서 화면을 확인한 뒤 보낸다. 폴더 이름이 여러 프로젝트에 걸리면 전체 경로를 쓰라고 거절한다.

## 카드 기능

- **GUI 화면**: hooks를 지원하는 에이전트(Claude Code, Antigravity)는 요청·진행 단계·답변을 정리해 보여 준다. 답변이 질문으로 끝나면 선택지(`1번으로 진행해줘` 등)나 네/아니요를 버튼으로 낸다.
- **모델 · Effort 선택 및 유지**: 입력창의 `[모델]`·`[Effort]` 드롭다운으로 모델과 추론 강도를 바꿀 수 있다(어댑터 전환 시 기본값이 자동 선택되며, 마지막으로 고른 값은 `mygdeck.json`에 저장되어 재실행 후에도 유지된다).
- **변경 배지**: 헤더의 `+12 −3`은 마지막 커밋 이후 바뀐 줄 수다. 누르면 변경 파일 목록과 첫 파일의 변경 화면이 열린다.
- **변경 검토**: 파일 패널의 `변경된 파일`에서 파일을 누르면 마지막 커밋과 비교한 화면(지운 줄 빨강, 추가한 줄 초록, 옛·새 줄 번호)이 열린다. `변경 | 코드`로 파일 전체와 오가고, `‹ ›` 또는 `[` `]`로 다음 변경 파일로 넘어간다. diff 줄 옆 `+` 버튼으로 리뷰 코멘트를 여러 곳에 달아 두고 `리뷰 N건 보내기`로 한 번에 입력창에 넣을 수 있다. `되돌리기`는 두 번 눌러야 실행되며 그 파일을 마지막 커밋 상태로 되돌린다(새 파일이면 `새 파일 삭제`로 지운다). 다 봤으면 파일 패널의 `커밋`으로 남긴다.
- **동시 작업 충돌 경고**: 같은 저장소나 worktree(`-wtN`)에서 여러 카드를 동시에 돌릴 때 서로 같은 파일을 수정하면 카드 헤더에 `충돌 주의 N` 배지와 파일 목록의 `중복` 표시로 미리 알려 준다.
- **권한 승인 모드**: 헤더의 `확인` 버튼을 누르면 `자동허용`으로 바뀌어 권한 승인 요청을 자동으로 허용한다(선택형 질문은 수동 유지).
- **하단 셸 오류 고치기**: 하단 터미널(`` Ctrl+` ``)의 `오류 고치기` 버튼은 최근 출력 중 오류 주변 로그만 추려 입력창에 넣어 준다.
- **worktree로 하나 더 열기**: 에이전트 선택 메뉴의 `⑂` 항목. 옆 폴더 `<저장소>-wtN`에 새 브랜치 `mygdeck/wtN`을 만들어 카드로 연다. 마지막 커밋(HEAD)에서 만들므로 커밋하지 않은 변경은 새 카드에 없다. 같은 프로젝트에서 두 번째 에이전트가 첫 번째의 파일을 건드리지 않고 일한다. worktree 카드의 에이전트 메뉴에는 `⇢ 원래 폴더에 합치기`(커밋된 작업을 원래 폴더의 현재 브랜치로 병합, 충돌이 나면 합치지 않음)와 `✕ 이 worktree 버리기`(카드를 닫고 폴더 삭제, 커밋하지 않은 변경이 있으면 지우지 않음, 합치지 않은 브랜치는 남김)가 있다.
- **이미지 붙여넣기**: 입력창에서 `Ctrl+V`로 이미지를 붙여넣으면 임시 파일 경로가 들어가고 입력창 위쪽에 미리보기가 뜬다. 미리보기를 누르면 크게 보이고, `×`를 누르면 이미지와 경로가 함께 빠진다.
- **CLI 추천 문구**: CLI 입력 줄에 흐린 글자로 뜬 추천 문구를 입력창에도 흐리게 보여 준다. 빈 입력창에서 `→`를 누르면 그 문구로 채운다.
- **상태 표시**: 카드 헤더와 전체 보기(`Ctrl+0`) 타일에 상태 아이콘이 붙는다(작업 중 · 승인 대기 · 완료 · 종료됨). 승인을 기다리는 카드는 테두리가 주황색으로 깜빡인다. 작업 중에는 경과 시간이 초 단위로 갱신된다.
- **다음 할 일**: 에이전트가 작업 중일 때 입력창에 보낸 지시는 바로 들어가지 않고 줄을 선다(`다음 N`). 턴이 끝날 때마다 하나씩 보낸다. `다음 N`을 누르거나 `Ctrl+Q`로 중지하면 줄이 비워진다. 턴 종료를 정확히 아는 에이전트(hooks, Codex `notify`)에서만 동작하고, 그 밖의 에이전트는 예전처럼 바로 보낸다. `??` 질문은 에이전트를 거치지 않으므로 바로 답한다.
- **원격 서버**: [docs/remote.md](docs/remote.md)
- **휴대폰 대시보드**: `https://mygdeck.asone26g.workers.dev`에서 하루 한 번 비밀번호로 연다. 프로젝트 상태 보기, 승인 선택지 답하기, 지시 보내기, 중지, 프로젝트 추가, 알림. PC는 데몬이 띄우는 Cloudflare 이름 있는 터널(공개 주소 없음)로 연결된다. [docs/mobile.md](docs/mobile.md)

## 에이전트 어댑터

`src-tauri/adapters/*.toml`(`claude-code`, `codex`, `gemini`, `antigravity`)이 기본 어댑터이고, `~/.mygdeck/adapters/*.toml`을 추가하면 새 에이전트를 붙일 수 있다(코드 수정 없음). 필드 설명과 예시는 [docs/adapters.md](docs/adapters.md).
Claude Code와 Antigravity는 덱 전용 hooks 설정으로 승인 대기·작업 완료 상태를 받는다. 사용자의 기존 에이전트 설정 파일은 건드리지 않는다.

## 테스트

```bash
npm test                          # 프론트엔드 로직
cd src-tauri && cargo test        # 백엔드 (세션 데몬, PTY 실행, hooks 전달, git 등)
```

자동 테스트가 못 잡는 입력·표시 문제는 릴리스 전에 [docs/regression-checklist.md](docs/regression-checklist.md)로 손으로 확인한다. 배포와 크래시 로그는 [docs/release.md](docs/release.md).
