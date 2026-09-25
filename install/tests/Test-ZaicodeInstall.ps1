<#
.SYNOPSIS
  Proves an install: seeded faults are found and repaired by the doctor, and
  the shortcut starts ZAICODE.

.DESCRIPTION
  1. Doctor (check only) passes on the fresh install.
  2. Seeds faults: shortcut deleted, launcher deleted, SAIPEN launcher pointed
     at a missing Python, SAIMAIL venv deleted, node_modules recorded for another
     pnpm-lock.yaml, a leftover dist\win-unpacked.previous deeper than MAX_PATH.
  3. Doctor (check only) reports every seeded fault; doctor -Repair fixes them;
     doctor (check only) passes again.
  4. -Smoke: starts the shortcut's target with an isolated app name, profile
     and home, waits for the app to write its profile, then stops exactly the
     process tree it started (by PID).
  Writes a JSON verdict next to the install's logs. Exit 1 on any failure.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string]$InstallDir,
  [Parameter(Mandatory)] [string]$ShortcutDir,
  [switch]$Smoke,
  [int]$SmokeSeconds = 90
)

$ErrorActionPreference = 'Stop'
$installer = Split-Path -Parent $PSScriptRoot
. (Join-Path $installer 'ZaicodeInstallLib.ps1')
. (Join-Path $installer 'ZaicodeChecks.ps1')

$layout = Get-ZaicodeLayout $InstallDir
$doctor = Join-Path $installer 'ZAICODE-Doctor.ps1'
$resultFile = Join-Path $env:TEMP ('zaicode-doctor-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
$common = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $doctor, '-InstallDir', $layout.Root, '-ShortcutDir', $ShortcutDir, '-NoStartMenu', '-JsonOut', $resultFile)
$verdict = [ordered]@{ installDir = $layout.Root; steps = @(); ok = $true }

function Step([string]$Name, [bool]$Pass, $Facts) {
  $verdict.steps += [ordered]@{ step = $Name; pass = $Pass; facts = $Facts }
  if (-not $Pass) { $verdict.ok = $false }
  $mark = 'FAIL'
  $color = 'Red'
  if ($Pass) { $mark = 'PASS'; $color = 'Green' }
  Write-Host ('{0}  {1}' -f $mark, $Name) -ForegroundColor $color
}

function Invoke-Doctor([switch]$Repair) {
  $arguments = $common
  if ($Repair) { $arguments = $common + @('-Repair') }
  Remove-Item -LiteralPath $resultFile -Force -ErrorAction SilentlyContinue
  & powershell.exe @arguments 2>&1 | Out-Null
  $code = $LASTEXITCODE
  $rows = @()
  # Windows PowerShell 5.1 emits a JSON array as one object; ForEach-Object unrolls it.
  if (Test-Path -LiteralPath $resultFile) { $rows = @(Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json | ForEach-Object { $_ }) }
  return [pscustomobject]@{ Code = $code; Rows = $rows }
}

function Status($Result, [string]$Id) {
  $row = $Result.Rows | Where-Object { $_.Id -eq $Id } | Select-Object -First 1
  if ($row) { return $row.Status }
  return 'absent'
}

# 1. A fresh install passes.
$fresh = Invoke-Doctor
Step 'fresh install: doctor passes' ($fresh.Code -eq 0) ([ordered]@{ statuses = ($fresh.Rows | ForEach-Object { "$($_.Id)=$($_.Status)" }) })

# 2. Seed faults.
$shortcut = Join-Path $ShortcutDir 'ZAICODE.lnk'
Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $layout.Launcher -Force -ErrorAction SilentlyContinue
$saipenCmd = Join-Path $layout.Saipen 'bin\saipen.cmd'
Set-Content -LiteralPath $saipenCmd -Encoding ASCII -Value ('@echo off' + "`r`n" + '"C:\no\such\python.exe" "' + (Join-Path $layout.Saipen 'tools\saipen.py') + '" %*')
Remove-Item -LiteralPath $layout.Venv -Recurse -Force -ErrorAction SilentlyContinue
Set-Content -LiteralPath (Get-ZaicodeLockMarker $layout) -Value ('0' * 64) -Encoding ASCII
$previous = Join-Path $layout.Zcode 'packages\desktop\dist\win-unpacked.previous'
$deep = $previous
while ($deep.Length -lt 300) { $deep = Join-Path $deep 'deep-segment-for-max-path' }
[IO.Directory]::CreateDirectory("\\?\$deep") | Out-Null
[IO.File]::WriteAllText("\\?\$deep\__PAGE__.segment.rsc", 'x')
$seeded = @('shortcut', 'launcher', 'saipen-launcher', 'saimail', 'modules', 'staged-build')

# 3. The doctor finds each fault, repairs it, and passes again.
$broken = Invoke-Doctor
$found = @($seeded | Where-Object { @('FAIL', 'WARN') -contains (Status $broken $_) })
Step 'doctor reports every seeded fault' ($found.Count -eq $seeded.Count -and $broken.Code -ne 0) ([ordered]@{ found = $found; statuses = ($broken.Rows | ForEach-Object { "$($_.Id)=$($_.Status)" }) })

$repaired = Invoke-Doctor -Repair
$fixed = @($seeded | Where-Object { (Status $repaired $_) -eq 'FIXED' })
Step 'doctor -Repair fixes every seeded fault' ($fixed.Count -eq $seeded.Count -and $repaired.Code -eq 0) ([ordered]@{ fixed = $fixed; statuses = ($repaired.Rows | ForEach-Object { "$($_.Id)=$($_.Status)" }) })

$again = Invoke-Doctor
Step 'after repair: doctor passes' ($again.Code -eq 0) ([ordered]@{ statuses = ($again.Rows | ForEach-Object { "$($_.Id)=$($_.Status)" }) })

# 4. The shortcut starts ZAICODE (isolated profile; only the started tree is stopped).
if ($Smoke) {
  $shell = New-Object -ComObject WScript.Shell
  $target = $shell.CreateShortcut($shortcut).TargetPath
  $smokeRoot = Join-Path $env:TEMP ('zaicode-install-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $profile = Join-Path $smokeRoot 'userData'
  New-Item -ItemType Directory -Force -Path $profile, (Join-Path $smokeRoot 'home') | Out-Null
  $info = New-Object Diagnostics.ProcessStartInfo $target
  $info.WorkingDirectory = $layout.Root
  $info.UseShellExecute = $false
  $info.EnvironmentVariables['ZCODE_DESKTOP_APPLICATION_NAME'] = 'ZAICODE-InstallSmoke'
  $info.EnvironmentVariables['ZCODE_DESKTOP_USER_DATA_DIR'] = $profile
  $info.EnvironmentVariables['ZCODE_DESKTOP_HOME_DIR'] = (Join-Path $smokeRoot 'home')
  $launcher = [Diagnostics.Process]::Start($info)
  $deadline = (Get-Date).AddSeconds($SmokeSeconds)
  $app = $null
  $wrote = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $app = Get-CimInstance Win32_Process -Filter "ParentProcessId = $($launcher.Id)" | Where-Object { $_.ExecutablePath -eq $layout.AppExe } | Select-Object -First 1
    $wrote = @(Get-ChildItem -LiteralPath $profile -Recurse -File -ErrorAction SilentlyContinue).Count -gt 0
    if ($app -and $wrote -and -not $launcher.HasExited) { break }
  }
  $alive = ($null -ne $app) -and -not $launcher.HasExited
  $facts = [ordered]@{ shortcutTarget = $target; launcherPid = $launcher.Id; appPid = $(if ($app) { $app.ProcessId } else { $null }); profileWritten = $wrote }
  # Stop exactly what this test started: the launcher's process tree, by PID.
  if (-not $launcher.HasExited) { & taskkill.exe /PID $launcher.Id /T /F | Out-Null }
  Step 'shortcut starts ZAICODE (isolated profile)' ($alive -and $wrote) $facts
  Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$out = Join-Path $layout.Logs ('test-install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
New-Item -ItemType Directory -Force -Path $layout.Logs | Out-Null
$verdict | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $out -Encoding UTF8
Write-Host "verdict: $out"
if (-not $verdict.ok) { exit 1 }
exit 0
