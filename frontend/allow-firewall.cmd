@echo off
setlocal enabledelayedexpansion
rem ============================================================
rem  FlowBoard 防火墙放行工具
rem  用法: allow-firewall.cmd [端口...]
rem  示例: allow-firewall.cmd            (默认放行 3000)
rem        allow-firewall.cmd 3000 3001 (放行多个端口)
rem  必须以管理员身份运行。
rem ============================================================

net session >nul 2>&1
if errorlevel 1 (
  echo [ERROR] 需要管理员权限。请右键本文件选择 "以管理员身份运行"。
  pause
  exit /b 1
)

if "%~1"=="" (
  set "PORTS=3000"
) else (
  set "PORTS=%*"
)

for %%P in (%PORTS%) do (
  echo [1/2] 删除旧规则 FlowBoard TCP %%P ...
  netsh advfirewall firewall delete rule name="FlowBoard TCP %%P" >nul 2>&1

  echo [2/2] 添加放行规则 FlowBoard TCP %%P ...
  netsh advfirewall firewall add rule name="FlowBoard TCP %%P" dir=in action=allow protocol=TCP localport=%%P profile=any
  if errorlevel 1 (
    echo [ERROR] 放行端口 %%P 失败。
  ) else (
    echo [OK] 端口 %%P 已放行。
  )
)

echo.
echo 完成。若仍需在局域网访问，请确认：
echo   1. 云服务器安全组放行对应 TCP 端口
echo   2. 路由器/AP 未开启 AP 隔离
endlocal
