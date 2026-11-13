# 테스트로 띄운 MYG Deck 창만 닫는다: 임시 폴더(%TEMP%\claude 아래)에서 빌드한 mygdeck*.exe.
# 저장소의 src-tauri\target에서 실행 중인 실제 덱과 세션 데몬은 건드리지 않는다.
$root = Join-Path $env:TEMP 'claude'
$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -like 'mygdeck*' -and $_.Path -and $_.Path.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)
}
if (-not $procs) { 'no test decks running'; exit 0 }
foreach ($p in $procs) {
  taskkill /PID $p.Id /T /F | Out-Null
  "closed $($p.Id) $($p.Path)"
}
