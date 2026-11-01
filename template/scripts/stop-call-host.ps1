$ErrorActionPreference='Stop'
$Root=Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'napcat-session.ps1')
$tokenPath=Join-Path $Root 'bot-home\media\onebot\calls\control.token'
if (-not (Test-Path -LiteralPath $tokenPath)) { exit }
$headers=@{Authorization='Bearer '+[IO.File]::ReadAllText($tokenPath).Trim()}
try { $state=(Invoke-RestMethod http://127.0.0.1:6111/v1/status -Headers $headers -TimeoutSec 3).data }
catch { Write-Output 'AV host is offline'; exit }
$processId=[int]$state.pid
$process=Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
$napcat=Split-Path (Split-Path (Get-NapcatWebuiConfigPath) -Parent) -Parent
$expected=$napcat
for($i=0;$i -lt 7 -and -not (Test-Path -LiteralPath (Join-Path $expected 'QQ.exe'));$i++) {$expected=Split-Path $expected -Parent}
$expected=Join-Path $expected 'QQ.exe'
if (-not $process -or $process.ExecutablePath -ne $expected -or $process.CommandLine -notmatch '\s-q\s+0(?:\s|$)') { throw 'Refusing to stop unverified AV host process' }
Get-CimInstance Win32_Process -Filter "ParentProcessId=$processId" | Where-Object {$_.ExecutablePath -eq $expected} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
Write-Output ('Stopped isolated AV host '+$processId)
