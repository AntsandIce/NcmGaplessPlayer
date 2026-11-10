@echo off
chcp 65001 >nul
setlocal
echo ============================================
echo   GaplessPlayer 一键安装
echo   （自动安装 BetterNCM，再装本插件）
echo ============================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
echo 如果窗口没有自动关闭，按任意键退出…
pause >nul
