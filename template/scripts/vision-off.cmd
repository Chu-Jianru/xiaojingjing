@echo off
rem Turn the bot's eyes OFF (v2.31 vision toggle) - the default state.
rem
rem Writes {"enabled":false} to bot-home\media\onebot\vision-state.json and
rem asks the sidecar (Qwen2-VL, up to ~4.5GB) to shut down right away so the
rem memory is actually freed. Takes effect immediately, no DSH restart needed.
rem The bot will tell people "the boss turned my eyes off to save money".
rem
rem Turn ON with vision-on.cmd.
setlocal
set "STATE=%~dp0..\bot-home\media\onebot\vision-state.json"
if "%DSH_VISION_PORT%"=="" set "DSH_VISION_PORT=8399"
powershell -NoProfile -Command "Set-Content -LiteralPath '%STATE%' -Value '{\"enabled\":false}' -Encoding ascii"
if errorlevel 1 (
  echo FAILED to write %STATE%
  exit /b 1
)
echo Vision OFF (%STATE%)
powershell -NoProfile -Command "try { Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:%DSH_VISION_PORT%/shutdown' -TimeoutSec 3 | Out-Null; echo 'Sidecar stopped - memory freed.' } catch { echo 'Sidecar was not running.' }"
endlocal
