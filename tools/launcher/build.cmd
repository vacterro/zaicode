@echo off
rem Builds the root ZAICODE.exe launcher (no console window) with the .NET Framework compiler.
rem Staged build: compiles to ZAICODE.exe.new first. If compilation fails, the working
rem ZAICODE.exe is left untouched. On success, the old binary is archived to ZAICODE.exe.old
rem and replaced with the new build.
set ROOT=%~dp0..\..
set TARGET=%ROOT%\ZAICODE.exe
set STAGED=%ROOT%\ZAICODE.exe.new
set OLD=%ROOT%\ZAICODE.exe.old

if exist "%STAGED%" del /q "%STAGED%" 2>nul
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ ^
  /win32icon:"%ROOT%\zcode\packages\desktop\build\icon.ico" ^
  /reference:System.Windows.Forms.dll ^
  /out:"%STAGED%" "%~dp0ZaicodeLauncher.cs"

if errorlevel 1 (
  echo Launcher compilation failed. Preserving existing executable.
  exit /b 1
)

if exist "%OLD%" del /q "%OLD%" 2>nul
if exist "%TARGET%" (
  move /y "%TARGET%" "%OLD%" >nul 2>nul
)
move /y "%STAGED%" "%TARGET%" >nul
