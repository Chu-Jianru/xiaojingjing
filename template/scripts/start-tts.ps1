$ErrorActionPreference = 'Stop'
$ttsRepo = Split-Path -Parent $PSScriptRoot
$ttsConfig = Join-Path $ttsRepo 'bot-home/media/onebot/tts-voice.json'
if (-not (Test-Path -LiteralPath $ttsConfig)) { exit 0 }
$ttsSettings = Get-Content -LiteralPath $ttsConfig -Raw -Encoding UTF8 | ConvertFrom-Json
if ($ttsSettings.engine -ne 'qwen') { exit 0 }
$ttsPort = 8398
if ($ttsSettings.port -ge 1024 -and $ttsSettings.port -le 65535) { $ttsPort = [int]$ttsSettings.port }
try {
    $ttsHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$ttsPort/health" -TimeoutSec 1
    if ($ttsHealth.service -eq 'dsh-qwen-tts') {
        if (-not $ttsSettings.voiceProfileKey -or $ttsHealth.voiceProfileKey -eq $ttsSettings.voiceProfileKey) { exit 0 }
        & (Join-Path $PSScriptRoot 'stop-tts.ps1')
    }
} catch { }
$ttsPython = Join-Path $ttsRepo 'bot-home/tts-runtime/.venv/Scripts/python.exe'
$ttsModel = Join-Path $ttsRepo 'bot-home/tts-runtime/models/Qwen3-TTS-12Hz-1.7B-CustomVoice/model.safetensors'
if ($ttsSettings.mode -eq 'reference') { $ttsModel = Join-Path $ttsRepo 'bot-home/tts-runtime/models/Qwen3-TTS-12Hz-1.7B-Base/model.safetensors' }
if (-not (Test-Path -LiteralPath $ttsPython) -or -not (Test-Path -LiteralPath $ttsModel)) {
    Write-Output 'Local TTS is not installed; Edge fallback remains available.'
    exit 0
}
$ttsWorker = Join-Path $ttsRepo 'qq-persona/p1/tools/ops/tts_sidecar.py'
$ttsOut = Join-Path $ttsRepo 'logs/tts-sidecar.log'
$ttsErr = Join-Path $ttsRepo 'logs/tts-sidecar.err.log'
Start-Process -FilePath $ttsPython -ArgumentList @('-u', ('"' + $ttsWorker + '"'), '--port', "$ttsPort") -WorkingDirectory $ttsRepo -WindowStyle Hidden -RedirectStandardOutput $ttsOut -RedirectStandardError $ttsErr
