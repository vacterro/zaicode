@echo off
REM saipen_crew.bat -- one click, three crew windows (Windows).
REM Opens three terminals at the project root, each showing the single command
REM to type into the agent-chat you start in that window. See extensions/subs/crew.md.
setlocal
set "PROJ=%~dp0.."
set /a "LAUNCHED=0"

set "ATTEMPT=1"
call :launch "SAIPEN crew - MAIN (Core writer)" cmd /k "cd /d "%PROJ%" && echo === MAIN / Core writer (mode: full) === && echo Start your agent in this window, then type: && echo     saipen continue && echo."
if errorlevel 1 (
  >&2 echo FAILED: crew window 1 of 3 was not accepted; %LAUNCHED% accepted.
  endlocal & exit /b 1
)
set /a "LAUNCHED+=1"

set "ATTEMPT=2"
call :launch "SAIPEN crew - saihunt (sensor)" cmd /k "cd /d "%PROJ%" && echo === saihunt / bug sensor (read-only) === && echo Start your agent in this window, then type: && echo     saihunt && echo (spawns + adopts the role, then hunts on loop into its OUTBOX) && echo."
if errorlevel 1 (
  >&2 echo FAILED: crew window 2 of 3 was not accepted; %LAUNCHED% accepted.
  endlocal & exit /b 1
)
set /a "LAUNCHED+=1"

set "ATTEMPT=3"
call :launch "SAIPEN crew - saipython (fixer)" cmd /k "cd /d "%PROJ%" && echo === saipython / tail fixer (read-only) === && echo Start your agent in this window, then type: && echo     saipython && echo (spawns + adopts the role, fixes in its pen, hands patches via OUTBOX) && echo."
if errorlevel 1 (
  >&2 echo FAILED: crew window 3 of 3 was not accepted; %LAUNCHED% accepted.
  endlocal & exit /b 1
)
set /a "LAUNCHED+=1"

echo Three crew windows opened. In the MAIN window collect the workers any time with: saipen sub collect
endlocal & exit /b 0

:launch
if not defined SAIPEN_CREW_START_COMMAND goto :launch_real
set "SAIPEN_CREW_LAUNCH_INDEX=%ATTEMPT%"
call "%SAIPEN_CREW_START_COMMAND%" %*
exit /b %errorlevel%

:launch_real
start %*
exit /b %errorlevel%
