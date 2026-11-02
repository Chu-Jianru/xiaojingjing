@echo off
cd /d "%~dp0"
python "%~dp0update.py" --check
pause
