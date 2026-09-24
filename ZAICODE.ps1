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
}
