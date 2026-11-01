param([switch]$Status)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'napcat-session.ps1')
$calls = Join-Path $Root 'bot-home\media\onebot\calls'
$tokenPath = Join-Path $calls 'control.token'
if (-not (Test-Path -LiteralPath $tokenPath)) { throw 'Run patch_napcat_calls.py first.' }
$headers = @{Authorization='Bearer '+([IO.File]::ReadAllText($tokenPath).Trim())}
function Get-HostState {
    try { return (Invoke-RestMethod http://127.0.0.1:6111/v1/status -Headers $headers -TimeoutSec 2).data }
    catch { return $null }
}
$state = Get-HostState
if ($Status) {
    if ($state) { $state | Select-Object ready,pid,electron,pluginFound,methods,invocationCount,lastInvocationCommand | ConvertTo-Json -Depth 4 }
    else { Write-Output 'AV host offline' }
    exit
}
if ($state) { Write-Output ('AV host already running: pid='+$state.pid+' ready='+$state.ready); exit }
$napcat = Split-Path (Split-Path (Get-NapcatWebuiConfigPath) -Parent) -Parent
$package = Get-Content -LiteralPath (Join-Path (Split-Path $napcat -Parent) 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($package.main -ne './napcat/dsh-call-entry.mjs' -or -not (Test-Path -LiteralPath (Join-Path $napcat 'dsh-call-entry.mjs'))) {
    throw 'Native-call bootstrap missing or changed after QQ upgrade; reapply patch_napcat_calls.py before starting an AV host.'
}
$shellRoot = $napcat
for ($i=0; $i -lt 7 -and -not ((Test-Path -LiteralPath (Join-Path $shellRoot 'NapCatWinBootMain.exe')) -and (Test-Path -LiteralPath (Join-Path $shellRoot 'QQ.exe'))); $i++) {
    $shellRoot = Split-Path $shellRoot -Parent
}
$launcher = Join-Path $shellRoot 'NapCatWinBootMain.exe'
if (-not ((Test-Path -LiteralPath $launcher) -and (Test-Path -LiteralPath (Join-Path $shellRoot 'QQ.exe')))) { throw 'Bot QQ launcher unavailable.' }
$old = $env:DSH_QQ_CALL_HOST
$env:DSH_QQ_CALL_HOST = '1'
try {
    Start-Process -FilePath $launcher -ArgumentList '0' -WorkingDirectory $shellRoot -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $calls 'host-boot.log') `
        -RedirectStandardError (Join-Path $calls 'host-boot.err.log') | Out-Null
} finally {
    if ($null -eq $old) { Remove-Item Env:DSH_QQ_CALL_HOST -ErrorAction SilentlyContinue }
    else { $env:DSH_QQ_CALL_HOST = $old }
}
for ($i=0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 1
    $state=Get-HostState
    if ($state) {
        Write-Output ('AV host started: pid='+$state.pid+' ready='+$state.ready+'; answering stays disabled until audio is ready.')
        exit
    }
}
throw 'AV host did not become ready; answering remains disabled. See the private calls directory.'
