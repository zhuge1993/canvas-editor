@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0flowboard.env.cmd" call "%~dp0flowboard.env.cmd"

if not defined FLOWBOARD_HOST set "FLOWBOARD_HOST=0.0.0.0"
if not defined FLOWBOARD_PORT set "FLOWBOARD_PORT=3000"

if not exist "%~dp0FlowBoard.exe" (
  echo FlowBoard.exe was not found in this folder.
  pause
  exit /b 1
)

echo Starting FlowBoard in daemon mode (watchdog: auto-restart on crash) on %FLOWBOARD_HOST%:%FLOWBOARD_PORT% ...
echo Watchdog log: logs\daemon.log
"%~dp0FlowBoard.exe" --daemon --host "%FLOWBOARD_HOST%" --port "%FLOWBOARD_PORT%" --no-open

endlocal
