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
  foreach ($name in @('Update-ZAICODE.ps1', 'ZaicodeInstallLib.ps1', 'ZaicodeChecks.ps1', 'Install-ZAICODE.ps1', 'ZaicodeSuite.ps1', 'Uninstall-ZAICODE.ps1')) {
    $wsFiles["install\$name"] = [IO.File]::ReadAllText((Join-Path $source $name))
  }
  $wsFiles['.gitignore'] = "/zcode/`n/saipen/`n/saimail/`n/install/logs/`n/install/install-state.json`n/install/update-state.json`n/launcher-built.txt`n"
  $ws = New-Remote 'workspace' 'master' $wsFiles
  $app = New-Remote 'app' 'zaicode' @{ 'package.json' = "{ `"name`": `"zcode`", `"version`": `"3.14.0`" }`n"; 'pnpm-lock.yaml' = "lockfileVersion: '9.0'`n"; 'src\feature.txt' = "one`n" }
  # SAIPEN ships its maintainer's launcher; the installer rewrites it for this clone (a tracked file changed by us).
  $saipen = New-Remote 'saipen' 'main' @{ 'VERSION' = "8.0.1`n"; 'tools\saipen.py' = "print('saipen')`n"; 'bin\saipen.cmd' = "@echo off`r`nrem the maintainer's launcher`r`n" }

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

  Write-Host 'what is no one''s work never blocks an update (found on the first real one-click install)' -ForegroundColor White
  # 1. SAIPEN changes the launcher file the installer rewrote for this clone.
  Assert-That (((Invoke-Git -C (Join-Path $install 'saipen') status --porcelain) -match 'bin/saipen.cmd')) 'the installer''s own launcher shows as a changed tracked file'
  $r = Run-Update @('-Check')
  Assert-That ($r['saipen'].dirty -eq $false) 'that file is not counted as a local edit'
  [IO.File]::WriteAllText((Join-Path $saipen.Seed 'bin\saipen.cmd'), "@echo off`r`nrem the maintainer's new launcher`r`n")
  Publish $saipen 'VERSION' "8.0.3`n" 'feat: SAIPEN 8.0.3 with a new launcher'
  $r = Run-Update @('-Component', 'saipen')
  Assert-That ($r['saipen'].status -eq 'updated') "saipen with the installer's launcher in place updates ($($r['saipen'].status): $($r['saipen'].detail))"
  Assert-That ((Get-Content (Join-Path $install 'saipen\bin\saipen.cmd') -Raw) -match [regex]::Escape((Join-Path $install 'saipen\tools\saipen.py'))) 'and the launcher names this clone again'
  # A real edit that overlaps the next update wins; the installer's launcher is put back exactly as it was.
  $launcherBefore = Get-Content (Join-Path $install 'saipen\bin\saipen.cmd') -Raw
  [IO.File]::WriteAllText((Join-Path $install 'saipen\VERSION'), "8.0.3-mine`n")
  [IO.File]::WriteAllText((Join-Path $saipen.Seed 'bin\saipen.cmd'), "@echo off`r`nrem yet another launcher`r`n")
  Publish $saipen 'VERSION' "8.0.4`n" 'feat: SAIPEN 8.0.4'
  $r = Run-Update @('-Component', 'saipen')
  Assert-That ($r['saipen'].status -eq 'local-changes') "a real edit overlapping the update keeps the clone as it is ($($r['saipen'].status))"
  Assert-That ((Get-Content (Join-Path $install 'saipen\VERSION') -Raw).Trim() -eq '8.0.3-mine') 'the edit is untouched'
  Assert-That ((Get-Content (Join-Path $install 'saipen\bin\saipen.cmd') -Raw) -eq $launcherBefore) 'and the launcher for this clone is back as it was'
  Invoke-Git -C (Join-Path $install 'saipen') checkout --quiet -- VERSION | Out-Null
  # 2. A file stored with CRLF under an eol=lf attribute (SAIMAIL's README.md): git lists it as changed forever.
  $appSeed = $app.Seed
  [IO.File]::WriteAllText((Join-Path $appSeed 'notes.md'), "line one`r`nline two`r`n")
  Invoke-Git -C $appSeed -c core.autocrlf=false add notes.md | Out-Null
  Invoke-Git -C $appSeed -c core.autocrlf=false -c user.name=test -c user.email=test@example.invalid commit --quiet -m 'notes with CRLF' | Out-Null
  [IO.File]::WriteAllText((Join-Path $appSeed '.gitattributes'), "notes.md text eol=lf`n")
  Invoke-Git -C $appSeed -c core.autocrlf=false add .gitattributes | Out-Null
  Invoke-Git -C $appSeed -c core.autocrlf=false -c user.name=test -c user.email=test@example.invalid commit --quiet -m 'eol=lf for notes' | Out-Null
  Invoke-Git -C $appSeed push --quiet origin $app.Branch | Out-Null
  $r = Run-Update @('-Component', 'app', '-NoBuild')
  Assert-That ($r['app'].status -eq 'updated') "app took the CRLF commits ($($r['app'].status))"
  $zc = Join-Path $install 'zcode'
  Assert-That (((Invoke-Git -C $zc status --porcelain) -match 'notes.md')) 'git now lists notes.md as changed (line endings only)'
  # 3. The person's own stash stays exactly theirs.
  [IO.File]::WriteAllText((Join-Path $zc 'src\feature.txt'), "my idea`n")
  Invoke-Git -C $zc -c user.name=me -c user.email=me@example.invalid stash push --quiet -m 'my own stash' -- src/feature.txt | Out-Null
  $r = Run-Update @('-Check')
  Assert-That ($r['app'].dirty -eq $false) "a line-ending-only file is not a local edit (dirty=$($r['app'].dirty))"
  [IO.File]::WriteAllText((Join-Path $appSeed 'notes.md'), "line one`r`nline two`r`nline three`r`n")
  Invoke-Git -C $appSeed -c core.autocrlf=false add notes.md | Out-Null
  Invoke-Git -C $appSeed -c core.autocrlf=false -c user.name=test -c user.email=test@example.invalid commit --quiet -m 'notes: line three' | Out-Null
  Invoke-Git -C $appSeed push --quiet origin $app.Branch | Out-Null
  $r = Run-Update @('-Component', 'app', '-NoBuild')
  Assert-That ($r['app'].status -eq 'updated') "an update that changes that file goes through ($($r['app'].status): $($r['app'].detail))"
  Assert-That ((Get-Content (Join-Path $zc 'notes.md') -Raw) -match 'line three') 'the file is the new one'
  $stashes = Invoke-Git -C $zc stash list
  Assert-That (($stashes -match 'my own stash') -and (@($stashes -split "`n" | Where-Object { $_ }).Count -eq 1)) "the person's stash is still there, alone ($stashes)"

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
