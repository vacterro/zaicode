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
set PAYLOADARG=
if not "%ZAICODE_SUITE_PAYLOAD%"=="" set PAYLOADARG=/resource:"%ZAICODE_SUITE_PAYLOAD%",suite.zip /resource:"%ZAICODE_SUITE_PAYLOAD%.sha256",suite.sha256
set OUTPUT=%INSTALL%\ZAICODE-Setup.exe
if not "%ZAICODE_SETUP_OUTPUT%"=="" set OUTPUT=%ZAICODE_SETUP_OUTPUT%
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ %ICONARG% %BANNERARG% %PAYLOADARG% ^
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll ^
  /resource:"%INSTALL%\Install-ZAICODE.ps1",Install-ZAICODE.ps1 ^
  /resource:"%INSTALL%\ZaicodeInstallLib.ps1",ZaicodeInstallLib.ps1 ^
  /resource:"%INSTALL%\ZaicodeChecks.ps1",ZaicodeChecks.ps1 ^
  /resource:"%INSTALL%\ZAICODE-Doctor.ps1",ZAICODE-Doctor.ps1 ^
  /resource:"%INSTALL%\Update-ZAICODE.ps1",Update-ZAICODE.ps1 ^
  /resource:"%INSTALL%\ZaicodeSuite.ps1",ZaicodeSuite.ps1 ^
  /resource:"%INSTALL%\Uninstall-ZAICODE.ps1",Uninstall-ZAICODE.ps1 ^
  /resource:"%HERE%assets\launch.jpg",launch.jpg ^
  /resource:"%HERE%assets\background.jpg",background.jpg ^
  /resource:"%INSTALL%\..\VERSION",VERSION ^
  /out:"%OUTPUT%" "%HERE%ZaicodeSetup.cs"
exit /b %ERRORLEVEL%
