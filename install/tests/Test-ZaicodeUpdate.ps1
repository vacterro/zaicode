<#
.SYNOPSIS
  Proof that the parts of a ZAICODE install update one by one (T-134).

.DESCRIPTION
  Builds four throw-away "GitHub" repositories on disk (workspace, app, SAIPEN,
  SAIMAIL), an install made of their clones, and runs install\Update-ZAICODE.ps1
  against it the way ZAICODE does (-Json). No network, no real remote, nothing
  outside the temporary folder. Asserts:
    - a check reports every part and changes nothing,
    - updating one part moves only that part and runs its follow-up
      (SAIPEN: a launcher for this clone; workspace: the root launcher rebuilt),
    - local edits the update would overwrite are kept and reported,
    - local commits (a diverged clone) are left alone,
    - "saipen,app" (one string, as powershell -File passes it) names two parts,
    - a part that is not installed says so instead of failing.
  Exit 1 on the first failed assertion.
#>
[CmdletBinding()]
param([string]$WorkDir = (Join-Path $env:TEMP ('zaicode-update-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))))

$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
$failures = 0

function Assert-That([bool]$Condition, [string]$Message) {
  if ($Condition) { Write-Host "  ok   $Message" -ForegroundColor Green }
  else { Write-Host "  FAIL $Message" -ForegroundColor Red; $script:failures++ }
}

function Invoke-Git {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & git @args 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed: $($output -join ' ')" }
    return ($output -join "`n")
  } finally { $ErrorActionPreference = $previous }
}

function New-Remote([string]$Name, [string]$Branch, [hashtable]$Files) {
  $bare = Join-Path $WorkDir "remotes\$Name.git"
  $seed = Join-Path $WorkDir "seed\$Name"
  Invoke-Git init --quiet --bare $bare | Out-Null
  Invoke-Git init --quiet $seed | Out-Null
  Invoke-Git -C $seed checkout --quiet -b $Branch | Out-Null
  foreach ($path in $Files.Keys) {
    $target = Join-Path $seed $path
    New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
    [IO.File]::WriteAllText($target, $Files[$path])
  }
  Invoke-Git -C $seed add -A | Out-Null
  Invoke-Git -C $seed -c user.name=test -c user.email=test@example.invalid commit --quiet -m "seed $Name" | Out-Null
  Invoke-Git -C $seed remote add origin $bare | Out-Null
  Invoke-Git -C $seed push --quiet origin $Branch | Out-Null
  return [pscustomobject]@{ Bare = $bare; Seed = $seed; Branch = $Branch }
}

function Publish([object]$Remote, [string]$Path, [string]$Text, [string]$Message) {
  [IO.File]::WriteAllText((Join-Path $Remote.Seed $Path), $Text)
  Invoke-Git -C $Remote.Seed add -A | Out-Null
  Invoke-Git -C $Remote.Seed -c user.name=test -c user.email=test@example.invalid commit --quiet -m $Message | Out-Null
  Invoke-Git -C $Remote.Seed push --quiet origin $Remote.Branch | Out-Null
}

function Clone([object]$Remote, [string]$Dir) {
  Invoke-Git clone --quiet --branch $Remote.Branch $Remote.Bare $Dir | Out-Null
}

function Run-Update([string[]]$Arguments) {
  $script = Join-Path $install 'install\Update-ZAICODE.ps1'
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script @Arguments -Json 2>&1 | ForEach-Object { "$_" } }
  finally { $ErrorActionPreference = $previous }
  $line = @($output | Where-Object { $_.TrimStart().StartsWith('{') }) | Select-Object -Last 1
  if (-not $line) { throw "no JSON from Update-ZAICODE.ps1: $($output -join ' | ')" }
  $report = $line | ConvertFrom-Json
  $map = @{}
  foreach ($component in @($report.components)) { $map[$component.id] = $component }
  return $map
}

function Head([string]$Dir) { return (Invoke-Git -C $Dir rev-parse HEAD).Trim() }

Write-Host "ZAICODE update proof in $WorkDir" -ForegroundColor White
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
try {
  # The workspace carries the scripts under test and a stand-in launcher build.
  $wsFiles = @{
    'VERSION' = "0.0.1`n"
    'tools\launcher\build.cmd' = "@echo off`r`necho built> `"%~dp0..\..\launcher-built.txt`"`r`n"
  }
  foreach ($name in @('Update-ZAICODE.ps1', 'ZaicodeInstallLib.ps1', 'ZaicodeChecks.ps1', 'Install-ZAICODE.ps1')) {
    $wsFiles["install\$name"] = [IO.File]::ReadAllText((Join-Path $source $name))
  }
  $wsFiles['.gitignore'] = "/zcode/`n/saipen/`n/saimail/`n/install/logs/`n/install/install-state.json`n/install/update-state.json`n/launcher-built.txt`n"
  $ws = New-Remote 'workspace' 'master' $wsFiles
  $app = New-Remote 'app' 'zaicode' @{ 'package.json' = "{ `"name`": `"zcode`", `"version`": `"3.14.0`" }`n"; 'pnpm-lock.yaml' = "lockfileVersion: '9.0'`n"; 'src\feature.txt' = "one`n" }
  $saipen = New-Remote 'saipen' 'main' @{ 'VERSION' = "8.0.1`n"; 'tools\saipen.py' = "print('saipen')`n" }

  $install = Join-Path $WorkDir 'install'
  Clone $ws $install
  Clone $app (Join-Path $install 'zcode')
  Clone $saipen (Join-Path $install 'saipen')
  # node_modules as installed from this very lockfile: an app update without a lock change needs no reinstall.
  . (Join-Path $install 'install\ZaicodeInstallLib.ps1')
  $layout = Get-ZaicodeLayout $install
  New-Item -ItemType Directory -Force -Path (Join-Path $install 'zcode\node_modules') | Out-Null
  Set-Content -LiteralPath (Get-ZaicodeLockMarker $layout) -Value (Get-ZaicodeLockHash $layout) -Encoding ASCII
  Write-ZaicodeInstallState $layout ([pscustomobject]@{ ZaicodeRepo = $ws.Bare; SaipenRepo = $saipen.Bare; SaimailRepo = 'missing' })

  Write-Host 'check: every part reported, nothing changed' -ForegroundColor White
  $before = @{ ws = Head $install; app = Head (Join-Path $install 'zcode'); saipen = Head (Join-Path $install 'saipen') }
  $r = Run-Update @('-Check')
  Assert-That ($r['workspace'].status -eq 'current') "workspace current ($($r['workspace'].status))"
  Assert-That ($r['app'].status -eq 'current') "app current ($($r['app'].status))"
  Assert-That ($r['saipen'].status -eq 'current') "saipen current ($($r['saipen'].status))"
  Assert-That ($r['saimail'].status -eq 'missing') "saimail not installed -> missing ($($r['saimail'].status))"
  Assert-That ($r['app'].version -eq 'ZCode 3.14.0') "app version read ($($r['app'].version))"

  Publish $saipen 'VERSION' "8.0.2`n" 'feat: SAIPEN 8.0.2'
  Publish $app 'src\feature.txt' "two`n" 'feat(app): feature two'
  $r = Run-Update @('-Check')
  Assert-That ($r['saipen'].status -eq 'available' -and $r['saipen'].behind -eq 1) "saipen: 1 new commit ($($r['saipen'].status), $($r['saipen'].behind))"
  Assert-That (@($r['saipen'].subjects) -contains 'feat: SAIPEN 8.0.2') 'saipen: the waiting commit is named'
  Assert-That ($r['app'].status -eq 'available') "app: new commit ($($r['app'].status))"
  Assert-That ((Head $install) -eq $before.ws -and (Head (Join-Path $install 'saipen')) -eq $before.saipen) 'a check moved nothing'

  Write-Host 'update SAIPEN alone' -ForegroundColor White
  $r = Run-Update @('-Component', 'saipen')
  Assert-That ($r['saipen'].status -eq 'updated') "saipen updated ($($r['saipen'].status): $($r['saipen'].detail))"
  Assert-That (-not $r.ContainsKey('app')) 'only the named part is in the report'
  Assert-That ((Get-Content (Join-Path $install 'saipen\VERSION') -Raw).Trim() -eq '8.0.2') 'saipen files are the new ones'
  $launcher = Join-Path $install 'saipen\bin\saipen.cmd'
  Assert-That ((Test-Path $launcher) -and ((Get-Content $launcher -Raw) -match [regex]::Escape((Join-Path $install 'saipen\tools\saipen.py')))) 'SAIPEN launcher written for this clone'
  Assert-That ((Head (Join-Path $install 'zcode')) -eq $before.app) 'the app was not touched'

  Write-Host 'local edits are kept' -ForegroundColor White
  [IO.File]::WriteAllText((Join-Path $install 'zcode\src\feature.txt'), "mine`n")
  $r = Run-Update @('-Component', 'app', '-NoBuild')
  Assert-That ($r['app'].status -eq 'local-changes') "app with an overlapping local edit -> local-changes ($($r['app'].status))"
  Assert-That ((Get-Content (Join-Path $install 'zcode\src\feature.txt') -Raw).Trim() -eq 'mine') 'the local edit is still there'
  Invoke-Git -C (Join-Path $install 'zcode') checkout --quiet -- src/feature.txt | Out-Null

  Write-Host 'two parts in one string, the workspace follow-up' -ForegroundColor White
  Publish $ws 'VERSION' "0.0.2`n" 'release 0.0.2'
  $r = Run-Update @('-Component', 'workspace,app', '-NoBuild')
  Assert-That ($r['workspace'].status -eq 'updated') "workspace updated ($($r['workspace'].status): $($r['workspace'].detail))"
  Assert-That ($r['app'].status -eq 'updated' -and $r['app'].detail -match 'build skipped') "app updated without a build ($($r['app'].status): $($r['app'].detail))"
  Assert-That (Test-Path (Join-Path $install 'launcher-built.txt')) 'the root launcher was rebuilt'
  Assert-That ((Get-Content (Join-Path $install 'zcode\src\feature.txt') -Raw).Trim() -eq 'two') 'the app source is the new one'

  Write-Host 'local commits (diverged) are left alone' -ForegroundColor White
  [IO.File]::WriteAllText((Join-Path $install 'NOTES.md'), "my notes`n")
  Invoke-Git -C $install add NOTES.md | Out-Null
  Invoke-Git -C $install -c user.name=me -c user.email=me@example.invalid commit --quiet -m 'my local commit' | Out-Null
  Publish $ws 'VERSION' "0.0.3`n" 'release 0.0.3'
  $local = Head $install
  $r = Run-Update @('-Component', 'workspace')
  Assert-That ($r['workspace'].status -eq 'diverged') "workspace with a local commit -> diverged ($($r['workspace'].status))"
  Assert-That ((Head $install) -eq $local) 'the local commit is untouched'

  # Windows PowerShell 5.1 turns a native command's stderr into an error under 'Stop' (traps.md): judge the text.
  $ErrorActionPreference = 'Continue'
  $bad = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $install 'install\Update-ZAICODE.ps1') -Component 'saipen,nonsense' -Check 2>&1 | Out-String
  $ErrorActionPreference = 'Stop'
  Assert-That ($bad -match "Unknown component 'nonsense'") 'an unknown part name is refused, not ignored'
} finally {
  Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures -gt 0) { Write-Host "$failures assertion(s) failed" -ForegroundColor Red; exit 1 }
Write-Host 'PASS: every part updates on its own; local work is never overwritten' -ForegroundColor Green
exit 0
