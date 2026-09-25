@echo off
rem Builds install\ZAICODE-Setup.exe (the one-click installer) with the .NET Framework compiler.
rem The install scripts ride along as resources, so the exe runs without anything next to it.
set HERE=%~dp0
set INSTALL=%HERE%..
set ICON=%INSTALL%\..\zcode\packages\desktop\build\icon.ico
set ICONARG=
if exist "%ICON%" set ICONARG=/win32icon:"%ICON%"
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /optimize+ %ICONARG% ^
  /resource:"%INSTALL%\Install-ZAICODE.ps1",Install-ZAICODE.ps1 ^
  /resource:"%INSTALL%\ZaicodeInstallLib.ps1",ZaicodeInstallLib.ps1 ^
  /resource:"%INSTALL%\ZaicodeChecks.ps1",ZaicodeChecks.ps1 ^
  /resource:"%INSTALL%\ZAICODE-Doctor.ps1",ZAICODE-Doctor.ps1 ^
  /out:"%INSTALL%\ZAICODE-Setup.exe" "%HERE%ZaicodeSetup.cs"
exit /b %ERRORLEVEL%
