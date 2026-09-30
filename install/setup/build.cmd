@echo off
rem Builds install\ZAICODE-Setup.exe (the one-click installer window) with the .NET Framework compiler
rem every Windows 10/11 has. The install scripts and the SAIPEN banner ride along as resources,
rem so the exe runs on its own: download it, double-click, press INSTALL.
set HERE=%~dp0
set INSTALL=%HERE%..
set BUILD=%INSTALL%\..\zcode\packages\desktop\build
set ICONARG=
if exist "%BUILD%\icon.ico" set ICONARG=/win32icon:"%BUILD%\icon.ico"
set BANNERARG=
if exist "%BUILD%\zaicode-splash\splash.png" set BANNERARG=/resource:"%BUILD%\zaicode-splash\splash.png",banner.png
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ %ICONARG% %BANNERARG% ^
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll ^
  /resource:"%INSTALL%\Install-ZAICODE.ps1",Install-ZAICODE.ps1 ^
  /resource:"%INSTALL%\ZaicodeInstallLib.ps1",ZaicodeInstallLib.ps1 ^
  /resource:"%INSTALL%\ZaicodeChecks.ps1",ZaicodeChecks.ps1 ^
  /resource:"%INSTALL%\ZAICODE-Doctor.ps1",ZAICODE-Doctor.ps1 ^
  /resource:"%INSTALL%\Update-ZAICODE.ps1",Update-ZAICODE.ps1 ^
  /out:"%INSTALL%\ZAICODE-Setup.exe" "%HERE%ZaicodeSetup.cs"
exit /b %ERRORLEVEL%
