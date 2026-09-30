@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0flash-dior.ps1"
set "result=%errorlevel%"
pause
exit /b %result%
