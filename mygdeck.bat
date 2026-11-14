@echo off
chcp 65001 >nul
setlocal
rem mygdeck 실행기. 더블클릭하면 바로 열립니다.
rem 실행할 때마다 디버그 빌드를 다시 만든다 (바뀐 부분만 컴파일해 몇 초). 실행 중인 mygdeck은 먼저 닫힌다.
rem   mygdeck.bat                 → 지난번 프로젝트 목록으로 열기 (없으면 빈 화면에서 폴더 추가)
rem   mygdeck.bat C:\work\a ...   → 지정한 폴더들로 열기
rem   mygdeck.bat rebuild         → 예전 사용법. 지금은 그냥 실행과 같다
rem   mygdeck.bat rebuild --daemon → 실행 중인 세션 데몬까지 종료한 뒤 다시 빌드하고 열기

set "ROOT=%~dp0"
rem 디버그 빌드를 쓴다: 다시 빌드가 빠르다. 배포용 설치 파일은 npx tauri build.
set "EXE=%ROOT%src-tauri\target\debug\mygdeck.exe"
set "CLI=%ROOT%src-tauri\target\debug\mygdeck-cli.exe"
set "STOP_DAEMON=0"
set "PASS_ARGS="

:parse
if "%~1"=="" goto :parsed
if /i "%~1"=="rebuild" (
  shift
  goto :parse
)
if /i "%~1"=="--daemon" (
  set "STOP_DAEMON=1"
  shift
  goto :parse
)
set "PASS_ARGS=%PASS_ARGS% "%~1""
shift
goto :parse

:parsed
if "%STOP_DAEMON%"=="1" if exist "%CLI%" (
  echo 실행 중인 세션 데몬을 종료합니다...
  "%CLI%" daemon stop
)

call :build || goto :fail

rem 실제 실행은 mygdeck.vbs가 맡는다 (콘솔 창 없이 열림).
start "" wscript.exe "%ROOT%mygdeck.vbs"%PASS_ARGS%
exit /b 0

:build
rem 실행 중인 앱이 실행 파일을 잡고 있으면 덮어쓸 수 없다. 이 폴더의 mygdeck.exe만 종료한다.
rem 자식 WebView2 프로세스까지 함께 끝낸다(/T). 남아 있으면 새 창이 "리소스 사용 중"으로 바로 꺼진다.
powershell -NoProfile -Command "$p = Get-Process mygdeck -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:EXE }; if ($p) { Write-Host '실행 중인 mygdeck을 종료합니다...'; $p | ForEach-Object { taskkill /PID $_.Id /T /F | Out-Null }; $p | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue }"
pushd "%ROOT%"
if not exist node_modules (call npm install || (popd & exit /b 1))
rem --debug: 웹 화면은 실행 파일 안에 들어가므로 개발 서버 없이 열린다.
call npx tauri build --debug --no-bundle || (popd & exit /b 1)
popd
exit /b 0

:fail
echo.
echo 빌드에 실패했습니다. 위 메시지를 확인하세요.
pause
exit /b 1
