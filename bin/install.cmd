@echo off
chcp 65001 >nul
rem 이 폴더(bin)를 사용자 PATH에 추가한다. 새로 연 터미널부터 어디서든 mygdeck을 쓸 수 있다.
set "MYGDECK_BIN=%~dp0"
powershell -NoProfile -Command "$bin = $env:MYGDECK_BIN.TrimEnd('\'); $cur = [Environment]::GetEnvironmentVariable('Path','User'); $parts = @($cur -split ';' | Where-Object { $_ }); if ($parts -contains $bin) { Write-Host '이미 PATH에 있습니다:' $bin } else { [Environment]::SetEnvironmentVariable('Path', (($parts + $bin) -join ';'), 'User'); Write-Host 'PATH에 추가했습니다:' $bin; Write-Host '새 터미널을 열고 mygdeck 을 입력하세요.' }"
