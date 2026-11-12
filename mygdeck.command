#!/bin/bash
# mygdeck 실행기 (macOS). Finder에서 더블클릭하면 열립니다. mygdeck.bat과 같은 일을 한다.
# 실행할 때마다 디버그 빌드를 다시 만든다 (바뀐 부분만 컴파일해 몇 초). 실행 중인 mygdeck은 먼저 닫힌다.
#   ./mygdeck.command                → 지난번 프로젝트 목록으로 열기 (없으면 빈 화면에서 폴더 추가)
#   ./mygdeck.command ~/work/a ...   → 지정한 폴더들로 열기
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# 디버그 빌드를 쓴다: 다시 빌드가 빠르다. 배포용 설치 파일은 npx tauri build.
APP="$ROOT/src-tauri/target/debug/bundle/macos/mygdeck.app"

[ "${1:-}" = "rebuild" ] && shift  # 예전 사용법. 지금은 그냥 실행과 같다

# 앱은 다른 폴더에서 열리므로 프로젝트 경로를 절대 경로로 바꿔 넘긴다.
args=()
for a in "$@"; do
  if [ -d "$a" ]; then args+=("$(cd "$a" && pwd)"); else args+=("$a"); fi
done

fail() {
  echo
  echo "빌드에 실패했습니다. 위 메시지를 확인하세요."
  read -r -p "Enter를 누르면 닫힙니다." _ || true
  exit 1
}

cd "$ROOT"
# 실행 중인 앱이 실행 파일을 잡고 있으면 덮어쓸 수 없다. 이 폴더의 mygdeck만 종료한다 (세션 데몬은 그대로 둔다).
if pkill -f "$APP/Contents/MacOS/mygdeck" 2>/dev/null; then
  echo "실행 중인 mygdeck을 종료합니다..."
  sleep 1
fi
[ -d node_modules ] || npm install || fail
# --debug: 웹 화면은 실행 파일 안에 들어가므로 개발 서버 없이 열린다.
npx tauri build --debug --bundles app || fail

open -n "$APP" --args ${args[@]+"${args[@]}"}
