@echo off
rem ZAICODE one-click install: double-click. Installs into %USERPROFILE%\ZAICODE (see Install-ZAICODE.ps1 -? for options).
setlocal
if exist "%~dp0Install-ZAICODE.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-ZAICODE.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/workspace/install/Install-ZAICODE.ps1))) %*"
)
set CODE=%ERRORLEVEL%
echo.
pause
exit /b %CODE%
