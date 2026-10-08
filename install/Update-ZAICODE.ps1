<#
.SYNOPSIS
  Updates the parts of a ZAICODE install one by one: the workspace (launcher,
  installer), the app, SAIPEN and SAIMAIL. Each is its own GitHub repository.

.DESCRIPTION
  Every part is a clone that fast-forwards to its published branch and then
  gets what it needs afterwards: the app its dependencies and a new build
  (staged while ZAICODE runs, swapped in on the next start), SAIPEN its
  launcher, SAIMAIL its .venv install, the workspace a new root launcher.
  Local work is never touched: a clone on another branch, with local commits,
  or with edits the update would overwrite is reported and left as it is.

  ZAICODE runs this itself (Settings -> Updates, and on its own schedule for
  the parts set to update automatically). It also works by hand:

    .\install\Update-ZAICODE.ps1                        # update everything
    .\install\Update-ZAICODE.ps1 -Component saipen      # only SAIPEN
    .\install\Update-ZAICODE.ps1 -Check                 # what is new, change nothing
    .\install\Update-ZAICODE.ps1 -Check -Json           # the same for a program

.PARAMETER Component
  all (default), or any of: workspace, app, saipen, saimail.
.PARAMETER Check
  Fetch and report only.
.PARAMETER Json
  Print one JSON document on stdout and nothing else (the narration goes to the log).
.PARAMETER NoBuild
  Update the app source and dependencies but do not build it (tests).
#>
[CmdletBinding()]
param(
  [string]$InstallDir = '',
  # all, or any of workspace, app, saipen, saimail; "app,saipen" works too (powershell -File passes one string).
  [string[]]$Component = @('all'),
  [switch]$Check,
  [switch]$Json,
  [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 has no $PSScriptRoot inside param() defaults: the install is this script's parent folder.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $InstallDir) { $InstallDir = Split-Path -Parent $here }
. (Join-Path $here 'ZaicodeInstallLib.ps1')

$layout = Get-ZaicodeLayout $InstallDir
$null = Assert-ZaicodeSuiteRoot $layout.Root
$ownership = Read-ZaicodeSuiteOwnership $layout.Root
$ownershipBefore = if (-not $Check -and $ownership) { Get-ZaicodeSuiteBaseline $layout } else { $null }
$script:ZaicodeQuiet = [bool]$Json
$log = Start-ZaicodeLog $layout.Logs $(if ($Check) { 'update-check' } else { 'update' })

# The repositories the installer used (install-state.json); an existing clone's own origin decides anyway.
$state = Read-ZaicodeInstallState $layout
$options = [pscustomobject]@{
  ZaicodeRepo = $(if ($state -and $state.repos.zaicode) { $state.repos.zaicode } else { $script:ZaicodeDefaults.ZaicodeRepo })
  SaipenRepo = $(if ($state -and $state.repos.saipen) { $state.repos.saipen } else { $script:ZaicodeDefaults.SaipenRepo })
  SaimailRepo = $(if ($state -and $state.repos.saimail) { $state.repos.saimail } else { $script:ZaicodeDefaults.SaimailRepo })
}

$git = Find-ZaicodeGit $layout
$names = @($Component | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
foreach ($name in $names) {
  if (@('all', 'workspace', 'app', 'saipen', 'saimail') -notcontains $name) { throw "Unknown component '$name' (all, workspace, app, saipen, saimail)" }
}
$wanted = if (-not $names -or $names -contains 'all') { @('workspace', 'app', 'saipen', 'saimail') } else { $names }
if ($ownership) { $wanted = @($wanted | Where-Object { $_ -eq 'workspace' -or $ownership.components -contains $(if ($_ -eq 'app') { 'zaicode' } else { $_ }) }) }
$started = Get-Date
$records = @()
foreach ($part in (Get-ZaicodeComponents $layout $options)) {
  if ($wanted -notcontains $part.Id) { continue }
  try {
    if ($Check) { $records += Get-ZaicodeComponentStatus $layout $part $git -Fetch }
    else {
      Write-ZaicodeLog "update $($part.Title)" 'White'
      $records += Update-ZaicodeComponent $layout $options $part $git -NoBuild:$NoBuild
    }
  } catch {
    $records += [pscustomobject]@{ id = $part.Id; title = $part.Title; dir = $part.Dir; branch = $part.Branch; status = 'failed'; detail = $_.Exception.Message }
  }
  $last = $records[-1]
  Write-ZaicodeLog ('{0,-10} {1,-14} {2}' -f $last.id, $last.status, $last.detail) $(if ($last.status -eq 'failed') { 'Red' } elseif ($last.status -in @('updated', 'available')) { 'Cyan' } else { 'Gray' })
}

if (-not $Check -and $ownership) {
  try { $null = Write-ZaicodeSuiteOwnership $layout (Get-ZaicodeSuiteOwnershipOptions $ownership) $ownershipBefore -KeepSelection }
  catch { $records += [pscustomobject]@{ id = 'ownership'; title = 'Uninstaller ownership'; status = 'failed'; detail = $_.Exception.Message } }
}

$summary = [ordered]@{
  schema = 1
  installDir = $layout.Root
  managed = [bool]$state
  mode = $(if ($Check) { 'check' } else { 'update' })
  at = (Get-Date).ToString('o')
  seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  log = $log
  components = $records
}
try {
  New-Item -ItemType Directory -Force -Path (Split-Path $layout.UpdateState) | Out-Null
  $summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $layout.UpdateState -Encoding UTF8
} catch { }

if ($Json) {
  [Console]::Out.WriteLine(($summary | ConvertTo-Json -Depth 5 -Compress))
} else {
  foreach ($record in $records) {
    if ($record.subjects) { foreach ($line in $record.subjects) { Write-ZaicodeLog "    $($record.id): $line" 'DarkGray' } }
  }
}
exit $(if (@($records | Where-Object { $_.status -eq 'failed' }).Count) { 1 } else { 0 })
