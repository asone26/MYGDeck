@echo off
chcp 65001 >nul
setlocal
rem 어디서든 mygdeck 실행 (bin\install.cmd가 이 폴더를 PATH에 넣는다).
rem   mygdeck                → 지난번 프로젝트 목록으로 열기
rem   mygdeck . ..\other     → 지정한 폴더들로 열기 (상대 경로 가능)
rem   mygdeck rebuild        → 다시 빌드하고 열기 (mygdeck.bat)
rem   mygdeck status|send|daemon|mobile|help ...  → mygdeck-cli
set "ROOT=%~dp0.."

for %%c in (status send daemon mobile help -h --help) do if /i "%~1"=="%%c" goto :cli
if /i "%~1"=="rebuild" (
  call "%ROOT%\mygdeck.bat" rebuild
  exit /b %errorlevel%
)

rem 앱은 다른 폴더에서 열릴 수 있으므로 폴더 인자는 절대 경로로 바꿔 넘긴다.
set "ARGS="
:loop
if "%~1"=="" goto :run
if exist "%~1\" (set ARGS=%ARGS% "%~f1") else (set ARGS=%ARGS% "%~1")
shift
goto :loop
:run
start "" wscript.exe "%ROOT%\mygdeck.vbs" %ARGS%
exit /b 0

:cli
set "CLI=%ROOT%\src-tauri\target\debug\mygdeck-cli.exe"
if not exist "%CLI%" (
  echo mygdeck-cli가 아직 빌드되지 않았습니다. 먼저 mygdeck rebuild 를 실행하세요.
  exit /b 1
)
"%CLI%" %*
exit /b %errorlevel%
