@echo off
rem Turn the bot's eyes ON (v2.31 vision toggle).
rem
rem Writes {"enabled":true} to bot-home\media\onebot\vision-state.json.
rem Takes effect immediately (no DSH restart needed): the next inbound image
rem or qq_look call lazily starts the sidecar (about 10s cold start).
rem
rem Turn OFF with vision-off.cmd (also stops the sidecar to free memory).
setlocal
set "STATE=%~dp0..\bot-home\media\onebot\vision-state.json"
powershell -NoProfile -Command "Set-Content -LiteralPath '%STATE%' -Value '{\"enabled\":true}' -Encoding ascii"
if errorlevel 1 (
  echo FAILED to write %STATE%
  exit /b 1
)
echo Vision ON  (%STATE%)
echo Sidecar will start lazily on the first image (~10s cold start).
endlocal
