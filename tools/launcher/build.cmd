@echo off
rem Builds the root ZAICODE.exe launcher (no console window) with the .NET Framework compiler.
rem A running launcher cannot be overwritten, but Windows allows renaming it: the old
rem file moves aside to ZAICODE.exe.old and is deleted on a later build.
set ROOT=%~dp0..\..
if exist "%ROOT%\ZAICODE.exe.old" del /q "%ROOT%\ZAICODE.exe.old" 2>nul
if exist "%ROOT%\ZAICODE.exe" (
  move /y "%ROOT%\ZAICODE.exe" "%ROOT%\ZAICODE.exe.old" >nul 2>nul
)
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ ^
  /win32icon:"%ROOT%\zcode\packages\desktop\build\icon.ico" ^
  /reference:System.Windows.Forms.dll ^
  /out:"%ROOT%\ZAICODE.exe" "%~dp0ZaicodeLauncher.cs"
