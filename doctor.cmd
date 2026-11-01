@echo off
cd /d "%~dp0"
python "%~dp0setup.py" --doctor
if errorlevel 1 pause
