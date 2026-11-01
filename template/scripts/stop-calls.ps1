$ErrorActionPreference='Stop'
$Root=Split-Path $PSScriptRoot -Parent
$calls=Join-Path $Root 'bot-home\media\onebot\calls'
$runtime=Join-Path $Root 'qq-persona\p1\tools\calls\call_runtime.py'
if (Test-Path -LiteralPath $calls) {
    [IO.File]::WriteAllText((Join-Path $calls 'stop.request'), 'stop')
    for ($i=0;$i -lt 10;$i++) {
        $workers=@(Get-CimInstance Win32_Process -Filter "name='python.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($runtime)})
        if ($workers.Count -eq 0) { break }
        Start-Sleep -Seconds 1
    }
    foreach ($worker in $workers) { Stop-Process -Id $worker.ProcessId -Force -ErrorAction SilentlyContinue }
}
& (Join-Path $PSScriptRoot 'stop-call-host.ps1')
