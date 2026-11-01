@echo off
cd /d "%~dp0"
python "%~dp0setup.py" --calls
if errorlevel 1 pause
