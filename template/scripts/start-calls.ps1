$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'napcat-session.ps1')
$calls = Join-Path $Root 'bot-home\media\onebot\calls'
$configPath = Join-Path $calls 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) { exit }
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.enabled -ne $true) { exit }
$mutex = Enter-CompanionMutex 'call-start' 0
if (-not $mutex) { exit }
try {
    & (Join-Path $PSScriptRoot 'start-call-host.ps1')
    $runtime = Join-Path $Root 'qq-persona\p1\tools\calls\call_runtime.py'
    $existing = @(Get-CimInstance Win32_Process -Filter "name='python.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($runtime)})
    if ($existing.Count -gt 0) { Write-Output 'Call audio worker already running'; exit }
    $python = Join-Path $Root 'bot-home\call-runtime\.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $python)) { throw 'Install call-runtime requirements first.' }
    Remove-Item -LiteralPath (Join-Path $calls 'stop.request') -ErrorAction SilentlyContinue
    Start-Process -FilePath $python -ArgumentList '-u', ('"'+$runtime+'"') -WorkingDirectory $Root -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $calls 'worker.log') -RedirectStandardError (Join-Path $calls 'worker.err.log') | Out-Null
    Write-Output 'CPU call worker starting; incoming owner calls are accepted only when audio/TTS/chat are ready and she is awake.'
} finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
