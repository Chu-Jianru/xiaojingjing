@echo off
cd /d "%~dp0"
python "%~dp0setup.py" --start
if errorlevel 1 pause
