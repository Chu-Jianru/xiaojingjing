@echo off
cd /d "%~dp0"
python "%~dp0setup.py" --install
if errorlevel 1 pause
