@echo off
chcp 65001 >nul
setlocal
rem mygdeck 실행기. 더블클릭하면 바로 열립니다.
rem   mygdeck.bat                 → 지난번 프로젝트 목록으로 열기 (없으면 빈 화면에서 폴더 추가)
rem   mygdeck.bat C:\work\a ...   → 지정한 폴더들로 열기
rem   mygdeck.bat rebuild         → 코드를 고친 뒤 실행 파일 다시 만들기

set "ROOT=%~dp0"
set "EXE=%ROOT%src-tauri\target\release\mygdeck.exe"

if /i "%~1"=="rebuild" (
  call :build || goto :fail
  shift
)
if not exist "%EXE%" (
  echo 처음 실행이라 앱을 빌드합니다. 몇 분 걸립니다...
  call :build || goto :fail
)

start "" "%EXE%" %*
exit /b 0

:build
pushd "%ROOT%"
if not exist node_modules (call npm install || (popd & exit /b 1))
call npx tauri build --no-bundle || (popd & exit /b 1)
popd
exit /b 0

:fail
echo.
echo 빌드에 실패했습니다. 위 메시지를 확인하세요.
pause
exit /b 1
