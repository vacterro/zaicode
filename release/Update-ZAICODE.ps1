param([string]$InstallDir, [string[]]$Component = @('all'), [switch]$Check, [switch]$Json, [switch]$Initialize, [switch]$Activate, [switch]$Rollback)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ReleaseLib.ps1')
if (-not $InstallDir) { $InstallDir = Split-Path -Parent $PSScriptRoot }
try {
    if ($Initialize) { Initialize-ReleaseInstall $InstallDir; exit 0 }
    if ($Activate) { Activate-ReleaseInstall $InstallDir; exit 0 }
    if ($Rollback) { Undo-ReleaseActivation $InstallDir; exit 0 }
    $wanted = @($Component | ForEach-Object { $_ -split ',' })
    if ($wanted -contains 'all') { $wanted = $script:ComponentIds }
    if (@($wanted | Where-Object { $_ -notin @('workspace', 'app', 'saipen', 'saimail', 'router') }).Count) { throw 'Unknown update component.' }
    $report = Invoke-ReleaseUpdate $InstallDir @($wanted | Where-Object { $_ -ne 'workspace' }) -Check:$Check
    if ($wanted -contains 'workspace') { $report.components += [pscustomobject]@{ id = 'workspace'; title = 'Installer'; status = 'current'; detail = 'Managed by the verified installer.' } }
    [Console]::Out.WriteLine(($report | ConvertTo-Json -Depth 8 -Compress))
} catch {
    [Console]::Out.WriteLine((@{ schema = 1; components = @(@{ id = 'app'; title = 'ZAICODE'; status = 'failed'; detail = $_.Exception.Message }) } | ConvertTo-Json -Depth 8 -Compress))
    exit 1
}
