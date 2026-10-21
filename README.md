# mygdeck

여러 프로젝트의 코딩 에이전트 CLI(Claude Code, Codex, Gemini CLI…)를 한 창에서 나란히 굴리는 바이브 코딩용 IDE.
기획 문서는 [master.md](master.md).

## 실행

```bash
npm install
npm run tauri dev                 # 개발 실행 (mygdeck.json의 프로젝트를 연다)
npm run tauri dev -- -- C:/work/a C:/work/b   # 프로젝트 경로를 직접 넘기기
npx tauri build --no-bundle       # 단일 실행 파일 빌드 (src-tauri/target/release/mygdeck.exe)
```

프로젝트 목록은 `mygdeck.json`(현재 폴더, 없으면 홈 폴더)에 저장되어 다음 실행 때 그대로 열린다.

```json
{
  "projects": [
    { "path": "C:/work/mygstat", "agent": "claude-code", "spec_file": "MASTER_SPEC.md" },
    { "path": "C:/work/api", "command": "ssh myserver claude" }
  ]
}
```

## 단축키

| 키 | 동작 |
|---|---|
| `Alt+1~9` / `Alt+←→` | 프로젝트 이동 |
| `Alt+J` | 입력을 기다리는 다음 프로젝트로 |
| `Alt+O` | 전체 보기 |
| `Alt+=` / `Alt+-` | 카드 크기 (Full · Compact · Mini) |
| `Alt+↑↓` | 카드 안 포커스 이동 (파일 · CLI · 입력창) |
| `Ctrl+P` | 파일 빠른 열기 (CLI에 포커스가 없을 때) |
| `Alt+I` | 코드 뷰어에서 선택한 코드를 입력창에 `@파일 L줄` 로 넣기 |
| `Alt+T` | 사용자 셸 열기/닫기 |
| `Alt+N` / `Alt+W` | 프로젝트 추가 / 닫기 |

## 에이전트 어댑터

`src-tauri/adapters/*.toml`이 기본 어댑터이고, `~/.mygdeck/adapters/*.toml`을 추가하면 새 에이전트를 붙일 수 있다(코드 수정 없음).
Claude Code는 덱 전용 hooks 설정을 `--settings`로 넘겨 승인 대기·작업 완료 상태를 받는다. 사용자의 Claude 설정 파일은 건드리지 않는다.

## 테스트

```bash
npm test                          # 프론트엔드 로직
cd src-tauri && cargo test        # 백엔드 (PTY 실행, hooks 전달, git 파싱 등)
```
