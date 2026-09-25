<#
.SYNOPSIS
  ZAICODE Autotroubleshoot: checks an install and repairs what is broken.

.DESCRIPTION
  The same checks the installer runs: tools (Git, Node.js, Python, pnpm), the
  ZAICODE, SAIPEN and SAIMAIL clones, the SAIPEN launcher, saimail-local, the
  app's dependencies and build, a staged build left waiting, the root
  launcher, the shortcuts, and the Claude / Codex logins (reported, never
  touched). Without -Repair it only reports. Exit code 1 while any check fails.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Split-Path -Parent $PSScriptRoot),
  [switch]$Repair,
  [switch]$Json,
  [string[]]$Only = @(),
  [string]$ShortcutDir = [Environment]::GetFolderPath('Desktop'),
  [switch]$NoStartMenu,
  [switch]$NoShortcut,
  [switch]$PortableTools,
  [string]$ZaicodeRepo = 'https://github.com/vacterro/zaicode.git',
  [string]$SaipenRepo = 'https://github.com/vacterro/saipen.git',
  [string]$SaimailRepo = 'https://github.com/vacterro/saimail.git'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ZaicodeInstallLib.ps1')
. (Join-Path $PSScriptRoot 'ZaicodeChecks.ps1')

$layout = Get-ZaicodeLayout $InstallDir
$options = [pscustomobject]@{
  ShortcutDir = $ShortcutDir; NoStartMenu = [bool]$NoStartMenu; NoShortcut = [bool]$NoShortcut; PortableTools = [bool]$PortableTools
  ZaicodeRepo = $ZaicodeRepo; SaipenRepo = $SaipenRepo; SaimailRepo = $SaimailRepo
}
$log = Start-ZaicodeLog $layout.Logs 'doctor'
$mode = 'check only'
if ($Repair) { $mode = 'check and repair' }
Write-ZaicodeLog "ZAICODE Autotroubleshoot ($mode): $($layout.Root)" 'White'

$results = @(Invoke-ZaicodeChecks $layout $options -Repair:$Repair -Only $Only)
$failed = @($results | Where-Object { $_.Status -eq 'FAIL' })
if ($Json) { $results | ConvertTo-Json -Depth 4 }
if ($failed.Count -gt 0) {
  $hint = ''
  if (-not $Repair) { $hint = ' (run again with -Repair)' }
  Write-ZaicodeLog ("{0} check(s) fail{1}. Log: {2}" -f $failed.Count, $hint, $log) 'Red'
  exit 1
}
Write-ZaicodeLog "All checks pass. Log: $log" 'Green'
exit 0
