@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"

echo ============================================
echo   GaplessPlayer 一键安装
echo   （自动安装 BetterNCM，再装本插件）
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "RC=%errorlevel%"

rem 42 = 已经提权重开（新窗口会自己停住），本窗口直接退出
if "%RC%"=="42" (
  popd
  exit /b 0
)

echo.
echo 脚本已结束（退出码 %RC%）。
echo 如果窗口一闪而过、没看到结果，请查看日志：
echo   %TEMP%\gapless-player-install.log
echo.
echo 按任意键关闭窗口…
pause >nul
popd
