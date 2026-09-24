@echo off
rem Builds the root ZAICODE.exe launcher (no console window) with the .NET Framework compiler.
set ROOT=%~dp0..\..
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ ^
  /win32icon:"%ROOT%\zcode\packages\desktop\build\icon.ico" ^
  /reference:System.Windows.Forms.dll ^
  /out:"%ROOT%\ZAICODE.exe" "%~dp0ZaicodeLauncher.cs"
