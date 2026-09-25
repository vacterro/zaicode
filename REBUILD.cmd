@echo off
rem ============================================================================
rem  REBUILD.cmd - rebuild ZAICODE from source, root convenience wrapper.
rem
rem  Safe to run while ZAICODE is open: bundle:zaicode detects the locked live
rem  ZAICODE.exe and stages the new build into packages/desktop/dist-next. The
rem  ZAICODE.cmd / ZAICODE.ps1 launcher swaps it in on the NEXT start, so just
rem  close and reopen the app to see changes (no hot reload).
rem
rem  Usage:
rem    REBUILD.cmd            typecheck (gate) + bundle
rem    REBUILD.cmd --fast     skip typecheck, bundle only
rem    REBUILD.cmd --os win --arch x64   extra flags pass through to bundle
rem ============================================================================
setlocal
set "ROOT=%~dp0"
set "PATH=C:\nodejs;%ROOT%zcode\.tools\pnpm10\node_modules\.bin;%PATH%"
cd /d "%ROOT%zcode" || exit /b 1

rem "shift" does not change %*, so rebuild the pass-through list without --fast.
set "SKIP_TC="
set "BUNDLE_ARGS="
:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="--fast" (
  set "SKIP_TC=1"
) else (
  set "BUNDLE_ARGS=%BUNDLE_ARGS% %1"
)
shift
goto parse_args
:args_done

if not defined SKIP_TC (
  echo [REBUILD] typecheck ...
  call "%ROOT%zcode\node_modules\.bin\tsc.cmd" -b packages/shared packages/ui packages/desktop/tsconfig.host.json
  if errorlevel 1 (
    echo [REBUILD] typecheck FAILED - not bundling. Fix errors or run REBUILD --fast to bypass.
    exit /b 1
  )
)

echo [REBUILD] bundle:zaicode ...
call node scripts/bundle-zaicode.mjs %BUNDLE_ARGS%
if errorlevel 1 (
  echo [REBUILD] bundle FAILED.
  exit /b 1
)

echo.
echo [REBUILD] done. If ZAICODE was running, the new build is staged in dist-next;
echo           close and relaunch via ZAICODE.cmd to swap it in.
endlocal
