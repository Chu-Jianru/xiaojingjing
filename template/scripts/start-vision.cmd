@echo off
setlocal
if exist "%~dp0..\bot-home\logs\qq-secret\vision-cloud.cmd" call "%~dp0..\bot-home\logs\qq-secret\vision-cloud.cmd"
if "%DSH_VISION_PORT%"=="" set "DSH_VISION_PORT=8399"
cd /d "%~dp0.."
start "" /b node "qq-persona\p1\tools\ops\vision-sidecar.mjs" >> "logs\vision-sidecar.log" 2>&1
endlocal
