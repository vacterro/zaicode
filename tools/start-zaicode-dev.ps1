# Starts the ZAICODE desktop dev workspace with an isolated profile.
#
# Isolation is deliberate: an installed production ZCode must never share
# mutable state with ZAICODE (SRC-002). Everything ZAICODE writes lives under
# .zaicode/ in the ZAICODE workspace root.
#
# Usage: powershell -ExecutionPolicy Bypass -File tools\start-zaicode-dev.ps1

$ErrorActionPreference = "Stop"

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$zaicodeBase = Join-Path $workspaceRoot ".zaicode"
$repoRoot = Join-Path $workspaceRoot "zcode"
$pnpmBinDir = Join-Path $workspaceRoot ".tools\pnpm10\node_modules\.bin"

foreach ($dir in @("home", "appdata", "localappdata", "userdata", "data")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $zaicodeBase $dir) | Out-Null
}

$env:PATH = "$pnpmBinDir;C:\nodejs;" +
  [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
  [Environment]::GetEnvironmentVariable("Path", "User")

$env:USERPROFILE = Join-Path $zaicodeBase "home"
$env:HOME = $env:USERPROFILE
$env:APPDATA = Join-Path $zaicodeBase "appdata"
$env:LOCALAPPDATA = Join-Path $zaicodeBase "localappdata"
$env:ZCODE_DESKTOP_APPLICATION_NAME = "ZAICODE"
$env:ZCODE_DESKTOP_USER_DATA_DIR = Join-Path $zaicodeBase "userdata"
$env:ZCODE_DESKTOP_HOME_DIR = $env:USERPROFILE
$env:ZCODE_DATA_BASE_DIR = Join-Path $zaicodeBase "data"
$env:ZCODE_ZAICODE_MODE = "1"
$env:ZCODE_ZAICODE_IDENTITY = "1"

Set-Location -LiteralPath $repoRoot
& pnpm.cmd dev:zaicode
