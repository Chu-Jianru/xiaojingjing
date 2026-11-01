$ErrorActionPreference = 'Stop'
$ttsRepo = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$ttsWorker = [IO.Path]::GetFullPath((Join-Path $ttsRepo 'qq-persona/p1/tools/ops/tts_sidecar.py'))
$ttsProcesses = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'python.exe' -and $_.CommandLine -and $_.CommandLine.Replace('/', '\').IndexOf($ttsWorker, [StringComparison]::OrdinalIgnoreCase) -ge 0
}
foreach ($ttsProcess in $ttsProcesses) {
    Stop-Process -Id $ttsProcess.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Output 'Local TTS stopped; GPU memory released.'
