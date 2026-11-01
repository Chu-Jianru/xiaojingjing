@echo off
rem Manual launcher for the vision sidecar (Qwen2-VL in its own process, v2.29).
rem
rem DSH starts this automatically on the first image; use this only to debug
rem or to pre-warm. Ctrl+C stops it. It also exits by itself after 30 idle
rem minutes (DSH_VISION_IDLE_MS) or when RSS goes over 5GB (DSH_VISION_MAX_RSS).
rem
rem Useful env:  set DSH_VISION_PORT=8399   (default)
rem              set DSH_VISION_IDLE_MS=1800000
rem Health:      curl http://127.0.0.1:8399/health
rem Log:         logs\vision-sidecar.log
rem Docs:        docs\media.md (section 3.44)
setlocal
set "SCRIPT=%~dp0..\qq-persona\p1\tools\ops\vision-sidecar.mjs"
if not exist "%SCRIPT%" (
  echo sidecar script not found: %SCRIPT%
  exit /b 1
)
node "%SCRIPT%" %*
endlocal
