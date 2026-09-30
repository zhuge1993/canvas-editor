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

echo Starting FlowBoard on %FLOWBOARD_HOST%:%FLOWBOARD_PORT% ...
echo.
echo   本窗口支持直接输入命令：输入 help 回车查看全部命令
echo   常用：smtp set 配置邮件 / admin 设管理员 / users 看用户 / firewall 放行防火墙
echo.
"%~dp0FlowBoard.exe" --host "%FLOWBOARD_HOST%" --port "%FLOWBOARD_PORT%" --debug

if errorlevel 1 (
  echo.
  echo FlowBoard stopped with an error.
  pause
)
endlocal
