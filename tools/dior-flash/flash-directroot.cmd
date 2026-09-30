@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0flash-directroot.ps1" -ImageDirectory "%~dp0" -Flash
set "result=%errorlevel%"
pause
exit /b %result%
