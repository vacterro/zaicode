param(
  [string]$ExecutablePath = "",
  [string]$SettingsDirectory = ""
)

$ErrorActionPreference = "Stop"
$workspace = $PSScriptRoot
$executable = if ($ExecutablePath) {
  [IO.Path]::GetFullPath($ExecutablePath)
} else {
  Join-Path $workspace 'zcode\packages\desktop\dist\win-unpacked\ZAICODE.exe'
}
$settingsDirectory = if ($SettingsDirectory) {
  [IO.Path]::GetFullPath($SettingsDirectory)
} else {
  Join-Path $env:APPDATA 'ZAICODE'
}
$preferencesPath = Join-Path $settingsDirectory 'zaicode-launcher.json'
$logPath = Join-Path $settingsDirectory 'launcher.log'
New-Item -ItemType Directory -Force -Path $settingsDirectory | Out-Null

function Write-LauncherLog([string]$message) {
  Add-Content -LiteralPath $logPath -Value ("{0:u} {1}" -f (Get-Date), $message)
}

function Test-AutoRestartEnabled {
  try {
    $preferences = Get-Content -LiteralPath $preferencesPath -Raw | ConvertFrom-Json
    return $preferences.autoRestartOnCrash -ne $false
  } catch {
    return $true
  }
}

function Apply-StagedBuild {
  $staged = Join-Path $workspace 'zcode\packages\desktop\dist-next\win-unpacked'
  $live = Join-Path $workspace 'zcode\packages\desktop\dist\win-unpacked'
  $stagedExe = Join-Path $staged 'ZAICODE.exe'
  if (-not (Test-Path -LiteralPath $stagedExe -PathType Leaf)) { return }
  $liveExe = Join-Path $live 'ZAICODE.exe'
  if ((Test-Path -LiteralPath $liveExe) -and (Get-Item -LiteralPath $liveExe).LastWriteTimeUtc -ge (Get-Item -LiteralPath $stagedExe).LastWriteTimeUtc) {
    Write-LauncherLog "Staged build is not newer than live build; leaving it in place"
    return
  }
  $previous = "${live}.previous"
  try {
    if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
    if (Test-Path -LiteralPath $live) { Move-Item -LiteralPath $live -Destination $previous -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $live) | Out-Null
    Move-Item -LiteralPath $staged -Destination $live -Force
    Write-LauncherLog "Applied staged build from dist-next"
  } catch {
    Write-LauncherLog "Staged build swap failed: $($_.Exception.Message)"
    if (-not (Test-Path -LiteralPath $live) -and (Test-Path -LiteralPath $previous)) {
      try { Move-Item -LiteralPath $previous -Destination $live -Force } catch {}
    }
  }
}

Apply-StagedBuild

if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  Write-LauncherLog "ZAICODE.exe missing: $executable"
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "ZAICODE.exe is missing. Build it with pnpm bundle:zaicode.`n$executable",
    'ZAICODE launcher'
  ) | Out-Null
  exit 2
}

$env:ZCODE_ZAICODE_MODE = '1'
# An inherited TZ (agent shells set TZ=UTC) would move every ZAICODE clock by the zone offset.
Remove-Item Env:TZ -ErrorAction SilentlyContinue
$env:ZCODE_ZAICODE_IDENTITY = '1'
$saipenHome = Join-Path $env:LOCALAPPDATA 'saipen\scheduled-source'
if (-not $env:SAIPEN_HOME -and (Test-Path -LiteralPath (Join-Path $saipenHome 'bin\saipen.cmd'))) {
  $env:SAIPEN_HOME = $saipenHome
}
$rapidCrashes = 0

while ($true) {
  $started = Get-Date
  try {
    $process = Start-Process -FilePath $executable -WorkingDirectory (Split-Path -Parent $executable) -PassThru
    $process.WaitForExit()
    $exitCode = $process.ExitCode
  } catch {
    Write-LauncherLog "Launch failed: $($_.Exception.Message)"
    exit 3
  }

  if ($exitCode -eq 0) {
    Write-LauncherLog 'Normal exit'
    exit 0
  }

  Write-LauncherLog "Process exited with code $exitCode"
  if (-not (Test-AutoRestartEnabled)) { exit $exitCode }

  if (((Get-Date) - $started).TotalSeconds -lt 30) {
    $rapidCrashes++
  } else {
    $rapidCrashes = 0
  }
  if ($rapidCrashes -ge 5) {
    Write-LauncherLog 'Stopped after five rapid crashes'
    exit $exitCode
  }
  Start-Sleep -Seconds 2
  Apply-StagedBuild
}
