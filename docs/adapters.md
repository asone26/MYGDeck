# 에이전트 어댑터 만들기

TOML 파일 하나를 `~/.mygdeck/adapters/`에 넣으면 새 에이전트 CLI가 덱에 붙는다. 코드는 고치지 않는다. 덱을 다시 열면 에이전트 선택 메뉴에 나타나고, 실행 파일이 PATH에 있으면 새 프로젝트의 기본값 후보가 된다.

기본 어댑터(`src-tauri/adapters/`의 claude-code, codex, gemini)와 이름이 같으면 사용자 파일이 이긴다.

## 가장 작은 어댑터

```toml
name = "opencode"
launch = "opencode"
```

이것만으로 CLI가 카드 안에서 돌아간다. 상태는 출력이 멈춘 시간으로 추정한다("입력 대기 추정").
실제로 쓸 만한 예시는 [adapters/opencode.toml](adapters/opencode.toml)에 있다(opencode 1.18에서 플래그 확인).

## 필드

| 필드 | 기본값 | 뜻 |
|---|---|---|
| `name` | (필수) | 메뉴와 `mygdeck.json`의 `agent`에 쓰는 이름 |
| `launch` | (필수) | 실행 명령. 따옴표로 공백을 묶을 수 있다 |
| `hook_args` | `""` | 상태 보고용 인자. `{settings}`, `{hook_exe}` 자리표시자를 쓴다 (아래) |
| `resume_args` | `""` | 마지막 대화를 다시 여는 인자. 데몬까지 꺼진 뒤(재부팅) 덱을 열 때만 붙는다 |
| `mention` | `"@{path}"` | 파일을 끌어다 놓거나 `Ctrl+I`를 눌렀을 때 넣을 형식 |
| `model_cmd` / `models` | `""` / `[]` | 모델 바꾸는 명령(`{model}` 자리)과 목록. 비우면 모델 선택이 숨는다 |
| `effort_cmd` / `efforts` | `""` / `[]` | 추론 강도 명령(`{effort}` 자리)과 목록 |
| `deep_model` / `base_model` | `""` | 설계·디버깅 질문에 잠깐 바꿀 모델과 돌아올 모델 |
| `clear_cmd` | `""` | 새 대화 명령 |
| `context_limit` | `0` | 컨텍스트 창 크기(토큰). `status = "hooks"`일 때만 쓰이고, 70%에 이르면 `clear_cmd`로 세션을 넘긴다. 0이면 넘기지 않는다 |
| `context_limits` | `{}` | 모델별 창 크기. 대화 기록의 모델명(예: `claude-opus-5-5`)에 들어 있는 첫 키의 값이 `context_limit`보다 우선한다. 예: `{ opus = 1000000 }` |
| `interrupt` | Esc | 작업 중지 키(`Ctrl+Q`) |
| `commands` | `[]` | 입력창에서 `/`를 쳤을 때 보여 줄 슬래시 명령 |
| `status` | `"idle"` | `"hooks"`면 hooks 이벤트로 상태를 받고 GUI 화면을 쓴다 |
| `waiting` | `""` | hooks가 없는 에이전트의 승인 프롬프트 문구(정규식, 대소문자 무시). 출력이 이 문구에서 멈추면 카드가 "승인 대기"가 된다. 덱 기본 패턴(`Enter to confirm`, `(y/n)`, 번호 메뉴 등)에 더해 검사한다 |

## 상태를 정확히 받는 법

덱은 상태를 세 단계로 받는다. 위로 갈수록 정확하다.

1. **hooks** (`status = "hooks"`): 에이전트가 요청 시작·도구 실행·승인 대기·턴 종료마다 `"{hook_exe}" --hook <이벤트>`를 실행하고 JSON을 stdin으로 넘긴다. 이벤트 이름은 `prompt`, `tool`, `notify`, `stop`이다. Claude Code가 이 방식이며, 덱은 hooks 설정 파일을 만들어 `{settings}` 자리로 넘긴다.
2. **턴 종료 알림만**: 에이전트가 턴이 끝날 때 프로그램을 실행해 줄 수 있으면 `"{hook_exe}" --hook stop <JSON>`을 실행하게 한다. JSON은 마지막 인자로 넘겨도 된다. 덱은 "완료"를 정확히 알고, 승인 대기만 출력 멈춤으로 추정한다. Codex 어댑터의 `notify`가 이 방식이다.
3. **출력 멈춤 추정**: 아무것도 설정하지 않은 경우.

hooks가 없는 에이전트(2·3)는 출력이 승인 프롬프트(기본 패턴 또는 `waiting`)에서 멈추면 "승인 대기"로 표시하고 알림을 띄운다.

Codex 예시. 바깥 큰따옴표(`\"…\"`)는 덱이 공백 있는 인자를 하나로 묶는 데만 쓰고, 실제 인자에서는 사라진다. 그 안의 Codex 설정값은 작은따옴표(TOML 리터럴 문자열)로 쓴다. npm으로 설치한 CLI는 Windows에서 `.cmd` 셸을 거치는데, 큰따옴표가 넘어가면 깨지기 때문이다.

```toml
hook_args = "-c \"notify=['{hook_exe}','--hook','stop']\""
```

## 확인 상태

| 어댑터 | 실행 | 상태 보고 | `resume_args` |
|---|---|---|---|
| claude-code | 확인 | hooks, 확인 | `--continue`, 확인 (데몬이 없는 상태에서 이전 대화 복원, 대화가 없으면 새로 시작) |
| codex | 미확인 | `notify`, 이 PC에 codex가 없어 실제 실행은 미확인 | `resume --last`, 미확인 |
| gemini | 미확인 | 출력 멈춤 추정, `waiting` 문구 미확인 | `--resume latest`, 미확인 |
| antigravity (`agy`) | 미확인 (1.5.6 설치·로그인 확인) | 출력 멈춤 추정 | `--continue`, 플래그만 확인 |
| opencode (예시) | 미확인 | 출력 멈춤 추정 | `--continue`, 플래그만 확인 (opencode 1.18.18) |

미확인 어댑터를 쓰다 문제가 생기면 해당 줄을 지우거나 `~/.mygdeck/adapters/`에 같은 이름으로 고친 파일을 두면 된다.
