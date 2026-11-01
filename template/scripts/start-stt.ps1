$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $Root 'qq-persona\p1\tools\ops\stt_sidecar.py'
$existing = @(Get-CimInstance Win32_Process -Filter "name='python.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($runtime)})
if ($existing.Count -gt 0) { Write-Output 'Voice-message recognition already running'; exit }
$python = Join-Path $Root 'bot-home\call-runtime\.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'CPU recognition environment unavailable' }
Start-Process -FilePath $python -ArgumentList '-u', ('"'+$runtime+'"') -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Root 'bot-home\logs\stt-sidecar.log') -RedirectStandardError (Join-Path $Root 'bot-home\logs\stt-sidecar.err.log') | Out-Null
Write-Output 'CPU voice-message recognition starting'
