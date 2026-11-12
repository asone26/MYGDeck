# 배포와 크래시 로그

릴리스 파일을 만들고, 사용자 PC에서 생긴 문제를 크래시 로그로 받는 방법이다. 자동 업데이트와 winget 등록은 개인용이라 하지 않는다.

## 빌드 결과물

```bash
npx tauri build --no-bundle
```

| 파일 | 크기 (2026-11 측정) | 역할 |
|---|---|---|
| `src-tauri/target/release/mygdeck.exe` | 5.2 MB | 앱. 같은 파일이 세션 데몬(`--daemon`)과 hooks 명령(`--hook`)도 맡는다 |
| `src-tauri/target/release/mygdeck-cli.exe` | 0.2 MB | 터미널용 `status`·`send`·`daemon stop`. 없어도 앱은 동작한다 |

앱만 배포하면 `mygdeck.exe` 하나다. WebView2는 Windows 11에 기본으로 있다.
설치 파일(NSIS·MSI)은 `npx tauri build`로 만든다. 이때 `mygdeck-cli.exe`가 함께 들어가는지는 아직 확인하지 않았다.

## 사용자 PC에 생기는 파일

모두 `~/.mygdeck/` 아래에 있다.

| 경로 | 내용 |
|---|---|
| `daemon.json` | 실행 중인 데몬의 로컬 포트와 접속 토큰. 데몬이 끝나면 지워진다 |
| `bin/mygdeck-<크기>-<시각>.exe` | 데몬과 hooks가 쓰는 앱 사본. 빌드 폴더의 exe를 잠그지 않으려고 둔다. 쓰지 않는 옛 사본은 다음 실행 때 지워진다 |
| `adapters/*.toml` | 사용자 어댑터 ([adapters.md](adapters.md)) |
| `logs/crash-<유닉스 시각>.log` | 크래시 로그 (아래) |

## 크래시 로그

앱·데몬·hooks 어느 프로세스든 패닉이 나면 종료 직전에 `~/.mygdeck/logs/crash-<유닉스 시각>.log`를 남긴다. 첫 줄에 버전, 역할(`app`, `--daemon`, `--hook`), OS가 있고 그 아래에 패닉 메시지와 백트레이스가 있다.
릴리스 빌드는 심볼을 빼므로(`strip = true`) 백트레이스에 함수 이름이 없을 수 있다. 위치가 필요하면 같은 커밋을 디버그 빌드로 재현한다.
버그 제보를 받을 때 이 파일을 첨부해 달라고 요청한다. 로그에는 경로가 들어갈 수 있지만 토큰이나 대화 내용은 없다.

## 하지 않기로 한 것

자동 업데이트와 winget 등록은 하지 않는다(2026-11-12 결정). 지금은 개인용이라 새 버전은 `mygdeck.bat rebuild`로 직접 빌드한다. 배포 대상이 생기면 Tauri updater 플러그인(릴리스 위치와 서명 키 필요)과 `wingetcreate`로 다시 검토한다.
