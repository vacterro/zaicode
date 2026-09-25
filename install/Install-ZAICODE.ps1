<#
.SYNOPSIS
  ZAICODE one-click install: ZAICODE + SAIPEN + SAIMAIL, fresh from GitHub, with everything they need.

.DESCRIPTION
  Run it and wait. It takes what the machine already has (Git, Node.js 24,
  Python 3.11+) and fetches a private copy of whatever is missing into
  <InstallDir>\.tools (no administrator rights), clones ZAICODE, SAIPEN and
  SAIMAIL, builds the app, builds the root launcher and puts a ZAICODE
  shortcut on the desktop and in the Start menu. Running it again updates
  everything and repairs what broke. Problems later: install\ZAICODE-Doctor.ps1
  (Autotroubleshoot) runs the same checks and repairs.

  From nothing (PowerShell):
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/workspace/install/Install-ZAICODE.ps1)))

.PARAMETER AddClaudeAccounts
  Prepare N extra Claude Code login homes (~/.claude-accountN); ZAICODE lists
  each as its own engine (A2, A3, ...). The login itself happens in the browser.
.PARAMETER AddCodexAccounts
  The same for Codex (~/.codex-accountN -> C2, C3, ...).
.PARAMETER PortableTools
  Use private copies of Git, Node.js and Python even when the machine has them.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:USERPROFILE 'ZAICODE'),
  [string]$ShortcutDir = [Environment]::GetFolderPath('Desktop'),
  [switch]$NoStartMenu,
  [switch]$NoShortcut,
  [switch]$PortableTools,
  [int]$AddClaudeAccounts = 0,
  [int]$AddCodexAccounts = 0,
  [switch]$Launch,
  [string]$ZaicodeRepo = 'https://github.com/vacterro/zaicode.git',
  [string]$SaipenRepo = 'https://github.com/vacterro/saipen.git',
  [string]$SaimailRepo = 'https://github.com/vacterro/saimail.git',
  [string]$LibraryBaseUrl = 'https://raw.githubusercontent.com/vacterro/zaicode/workspace/install'
)

$ErrorActionPreference = 'Stop'

# The library next to this script, or (run from the web) a fresh copy of it.
$here = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'ZaicodeChecks.ps1'))) { $here = $PSScriptRoot }
if (-not $here) {
  $here = Join-Path $env:TEMP ('zaicode-setup-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $here | Out-Null
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  foreach ($name in @('ZaicodeInstallLib.ps1', 'ZaicodeChecks.ps1')) {
    Invoke-WebRequest -UseBasicParsing -Uri "$LibraryBaseUrl/$name" -OutFile (Join-Path $here $name)
  }
}
. (Join-Path $here 'ZaicodeInstallLib.ps1')
. (Join-Path $here 'ZaicodeChecks.ps1')

$layout = Get-ZaicodeLayout $InstallDir
$options = [pscustomobject]@{
  ShortcutDir = $ShortcutDir; NoStartMenu = [bool]$NoStartMenu; NoShortcut = [bool]$NoShortcut; PortableTools = [bool]$PortableTools
  ZaicodeRepo = $ZaicodeRepo; SaipenRepo = $SaipenRepo; SaimailRepo = $SaimailRepo
}
$log = Start-ZaicodeLog $layout.Logs 'install'
$started = Get-Date

Write-ZaicodeLog '============================================================' 'White'
Write-ZaicodeLog ' ZAICODE install: ZAICODE + SAIPEN + SAIMAIL' 'White'
Write-ZaicodeLog " into $($layout.Root)" 'White'
Write-ZaicodeLog ' This takes a while the first time (the app is built here). Nothing to click.' 'White'
Write-ZaicodeLog '============================================================' 'White'

# An existing install is updated first: every clone fast-forwards (local edits are kept).
$changed = @{}
$git = Find-ZaicodeGit $layout
if ($git -and (Test-ZaicodeRepo $git $layout.Root)) {
  Write-ZaicodeLog 'Updating the existing install from GitHub' 'White'
  try { $changed = Update-ZaicodeClones $layout $options $git } catch { Write-ZaicodeLog "update skipped: $($_.Exception.Message)" 'Yellow' }
}

$results = @(Invoke-ZaicodeChecks $layout $options -Repair)

# New app or launcher source: rebuild after the checks (which reinstall dependencies when the lockfile moved).
# A running ZAICODE gets the app build staged and swapped in on its next start.
if ($changed['app'] -and -not @($results | Where-Object { $_.Id -eq 'app' -and $_.Status -eq 'FIXED' }).Count) {
  try { Build-ZaicodeApp $layout (Find-ZaicodeNode $layout); Write-ZaicodeLog 'App rebuilt from the new source' 'Cyan' }
  catch { $results += [pscustomobject]@{ Id = 'app-update'; Title = 'App rebuild after update'; Status = 'FAIL'; Problem = 'rebuild failed'; Error = $_.Exception.Message; Seconds = 0 } }
}
if ($changed['workspace']) {
  try { Build-ZaicodeLauncher $layout; Write-ZaicodeLog 'Launcher rebuilt from the new source' 'Cyan' }
  catch { $results += [pscustomobject]@{ Id = 'launcher-update'; Title = 'Launcher rebuild after update'; Status = 'FAIL'; Problem = 'rebuild failed'; Error = $_.Exception.Message; Seconds = 0 } }
}

# Several subscriptions: one home per extra login, listed by ZAICODE as its own engine.
$added = @()
for ($index = 0; $index -lt $AddClaudeAccounts; $index++) { $added += [pscustomobject]@{ Vendor = 'claude'; Home = (New-ZaicodeAccountHome 'claude') } }
for ($index = 0; $index -lt $AddCodexAccounts; $index++) { $added += [pscustomobject]@{ Vendor = 'codex'; Home = (New-ZaicodeAccountHome 'codex') } }

$accounts = @(Get-ZaicodeAccounts)
Write-ZaicodeLog '' 'White'
Write-ZaicodeLog 'Subscriptions found (each is its own engine in ZAICODE):' 'White'
if ($accounts.Count -eq 0) { Write-ZaicodeLog '  none yet: ZAICODE starts on its free pool; add a Claude / Codex login any time' 'Gray' }
foreach ($account in $accounts) {
  $state = 'signed in'
  if (-not $account.SignedIn) { $state = 'sign in: ' + (Get-ZaicodeLoginCommand $account.Vendor $account.Home) }
  Write-ZaicodeLog ('  {0,-6} {1}  ({2})' -f $account.Vendor, $account.Home, $state) 'Gray'
}
foreach ($entry in $added) { Write-ZaicodeLog ('  new {0} home {1}: {2}' -f $entry.Vendor, $entry.Home, (Get-ZaicodeLoginCommand $entry.Vendor $entry.Home)) 'Cyan' }

$failed = @($results | Where-Object { $_.Status -eq 'FAIL' })
$report = [ordered]@{
  installDir = $layout.Root
  startedAt = $started.ToString('o')
  minutes = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
  log = $log
  checks = $results
  accounts = $accounts
  addedAccountHomes = $added
  ok = ($failed.Count -eq 0)
}
New-Item -ItemType Directory -Force -Path (Split-Path $layout.Report) | Out-Null
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $layout.Report -Encoding UTF8

Write-ZaicodeLog '' 'White'
if ($failed.Count -gt 0) {
  Write-ZaicodeLog ('Not finished: ' + (($failed | ForEach-Object { $_.Title }) -join ', ')) 'Red'
  Write-ZaicodeLog "Autotroubleshoot: powershell -ExecutionPolicy Bypass -File `"$(Join-Path $layout.Root 'install\ZAICODE-Doctor.ps1')`" -Repair" 'Yellow'
  Write-ZaicodeLog "Log: $log" 'Yellow'
  exit 1
}
Write-ZaicodeLog ("Done in {0} min. Start ZAICODE from the shortcut (or {1})." -f $report.minutes, $layout.Launcher) 'Green'
if ($Launch) { Start-Process -FilePath $layout.Launcher -WorkingDirectory $layout.Root }
exit 0
