@echo off
rem ZAICODE Autotroubleshoot: double-click to check this install and repair what is broken.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ZAICODE-Doctor.ps1" -Repair %*
set CODE=%ERRORLEVEL%
echo.
pause
exit /b %CODE%
