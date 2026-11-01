@echo off
cd /d "%~dp0"
python "%~dp0setup.py" --vision
if errorlevel 1 pause
