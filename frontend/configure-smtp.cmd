@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"

set "SMTP_HOST=smtp.qq.com"
set /p "SMTP_HOST=SMTP host [smtp.qq.com]: "
if not defined SMTP_HOST set "SMTP_HOST=smtp.qq.com"

set "SMTP_PORT=465"
set /p "SMTP_PORT=SMTP port [465]: "
if not defined SMTP_PORT set "SMTP_PORT=465"

set "SMTP_SECURE=true"
set /p "SMTP_SECURE=Use TLS (true/false) [true]: "
if not defined SMTP_SECURE set "SMTP_SECURE=true"

set "SMTP_USER="
set /p "SMTP_USER=SMTP account email: "
if not defined SMTP_USER (
  echo SMTP account email is required.
  exit /b 1
)

set "SMTP_PASS="
set /p "SMTP_PASS=SMTP password or authorization code: "
if not defined SMTP_PASS (
  echo SMTP password or authorization code is required.
  exit /b 1
)

set "SMTP_FROM=%SMTP_USER%"
set /p "SMTP_FROM=From email [%SMTP_USER%]: "
if not defined SMTP_FROM set "SMTP_FROM=%SMTP_USER%"

> "%~dp0flowboard.env.cmd" echo @echo off
>> "%~dp0flowboard.env.cmd" echo set "FLOWBOARD_SMTP_HOST=%SMTP_HOST%"
>> "%~dp0flowboard.env.cmd" echo set "FLOWBOARD_SMTP_PORT=%SMTP_PORT%"
>> "%~dp0flowboard.env.cmd" echo set "FLOWBOARD_SMTP_SECURE=%SMTP_SECURE%"
>> "%~dp0flowboard.env.cmd" echo set "FLOWBOARD_SMTP_USER=%SMTP_USER%"
>> "%~dp0flowboard.env.cmd" echo set "FLOWBOARD_SMTP_PASS=%SMTP_PASS%"
>> "%~dp0flowboard.env.cmd" echo set "FLOWBOARD_SMTP_FROM=%SMTP_FROM%"

echo.
echo SMTP settings saved to flowboard.env.cmd.
echo Run start-server.cmd to restart FlowBoard.
endlocal
