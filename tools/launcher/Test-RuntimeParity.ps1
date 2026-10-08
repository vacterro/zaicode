$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$scratch = Join-Path $env:TEMP ('zaicode-runtime-parity-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/out:$scratch\ZAICODE.exe" (Join-Path $root 'tools\launcher\ZaicodeLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Launcher compile failed' }
$type = [Reflection.Assembly]::LoadFrom("$scratch\ZAICODE.exe").GetType('ZaicodeLauncher')
$flags = [Reflection.BindingFlags]'Static,NonPublic,Public'
$compare = $type.GetMethod('StagedBuildIsNewer', $flags)
$skew = $type.GetMethod('DescribeRuntimeSkew', $flags)
if (-not $compare -or -not $skew) { throw 'Missing runtime parity contract' }
function Check([string]$label, [bool]$ok) { if (-not $ok) { throw "FAIL $label" }; Write-Host "PASS $label" }
function New-Package([string]$name, [string]$at, [string]$id, [string]$rev) {
  $dir = Join-Path $scratch $name
  New-Item -ItemType Directory -Path (Join-Path $dir 'resources') -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $dir 'ZAICODE.exe'), 'fixture-not-executable')
  @{ buildTime=$at; runtimePackageIdentity=$id; sourceRevision=$rev; appVersion='3.14.0' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dir 'resources\build-meta.json') -Encoding UTF8
  return Join-Path $dir 'ZAICODE.exe'
}
$old = New-Package 'old' '2026-10-04T10:00:00Z' 'old-package' ('a' * 40)
$new = New-Package 'new' '2026-10-05T01:00:00Z' 'new-package' ('b' * 40)
(Get-Item $old).LastWriteTimeUtc = [datetime]'2027-01-01T00:00:00Z'
(Get-Item $new).LastWriteTimeUtc = [datetime]'2020-01-01T00:00:00Z'
Check 'new metadata wins despite older executable shell timestamp' ([bool]$compare.Invoke($null, @([string]$new,[string]$old)))
Check 'old metadata cannot overwrite new package despite newer executable timestamp' (-not [bool]$compare.Invoke($null, @([string]$old,[string]$new)))
$same = New-Package 'same' '2026-10-06T01:00:00Z' 'new-package' ('b' * 40)
Check 'identical package identity is not promoted again' (-not [bool]$compare.Invoke($null, @([string]$same,[string]$new)))
$legacy = New-Package 'legacy' '' '' ''
(Get-Item $legacy).LastWriteTimeUtc = [datetime]'2027-01-01T00:00:00Z'
Check 'new identity can replace legacy live package despite wrapper timestamp' ([bool]$compare.Invoke($null, @([string]$new,[string]$legacy)))
$ws = Join-Path $scratch 'workspace'
New-Item -ItemType Directory -Path (Join-Path $ws 'zcode') -Force | Out-Null
& git -C (Join-Path $ws 'zcode') init --quiet
if ($LASTEXITCODE -ne 0) { throw 'Fixture git init failed' }
[IO.File]::WriteAllText((Join-Path $ws 'zcode\package.json'), '{}')
& git -C (Join-Path $ws 'zcode') add package.json
& git -C (Join-Path $ws 'zcode') -c user.name=Parity -c user.email=parity@example.invalid commit --quiet -m fixture
if ($LASTEXITCODE -ne 0) { throw 'Fixture commit failed' }
$head = (& git -C (Join-Path $ws 'zcode') rev-parse HEAD).Trim()
Check 'different source reports explicit stale runtime warning' ([string]$skew.Invoke($null, @([string]$ws,[string]$old)) -match 'SOURCE_RUNTIME_SKEW')
$match = New-Package 'match' '2026-10-05T01:00:00Z' 'match-package' $head
Check 'matching clean source has no skew warning' ([string]$skew.Invoke($null, @([string]$ws,[string]$match)) -eq '')
# A build that rewrites a tracked file with other line endings (MinGit checks out CRLF) changed nothing.
$generated = Join-Path $ws 'zcode\packages\types.d.ts'
New-Item -ItemType Directory -Path (Split-Path $generated) -Force | Out-Null
[IO.File]::WriteAllText($generated, "export type A = 1;`r`nexport type B = 2;`r`n")
& git -C (Join-Path $ws 'zcode') -c core.autocrlf=false add packages/types.d.ts
& git -C (Join-Path $ws 'zcode') -c user.name=Parity -c user.email=parity@example.invalid commit --quiet -m types
$head = (& git -C (Join-Path $ws 'zcode') rev-parse HEAD).Trim()
$match = New-Package 'match2' '2026-10-05T02:00:00Z' 'match-package-2' $head
[IO.File]::WriteAllText($generated, "export type A = 1;`nexport type B = 2;`n")
Check 'a line-ending-only rewrite by the build is not source skew' ([string]$skew.Invoke($null, @([string]$ws,[string]$match)) -eq '')
$managed = $type.GetMethod('IsManagedInstall', $flags)
Check 'a developer workspace still gets the parity dialog' (-not [bool]$managed.Invoke($null, @([string]$ws)))
New-Item -ItemType Directory -Path (Join-Path $ws 'install') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $ws 'install\install-state.json'), '{}')
Check 'an installed copy logs parity instead of stopping every start' ([bool]$managed.Invoke($null, @([string]$ws)))
[IO.File]::WriteAllText((Join-Path $ws 'zcode\package.json'), '{"new":true}')
Check 'dirty same HEAD cannot silently claim runtime parity' ([string]$skew.Invoke($null, @([string]$ws,[string]$match)) -match 'SOURCE_RUNTIME_SKEW')
# The installer's private Git is a whole MinGit; a junction to this machine's Git stands in for it.
New-Item -ItemType Directory -Path (Join-Path $ws '.tools') -Force | Out-Null
$gitRoot = Split-Path -Parent (Get-Command git.exe).Source
while ($gitRoot -and -not (Test-Path (Join-Path $gitRoot 'cmd\git.exe'))) { $gitRoot = Split-Path -Parent $gitRoot }
if (-not $gitRoot) { throw 'This check needs Git for Windows (cmd\git.exe)' }
& cmd.exe /d /c mklink /J (Join-Path $ws '.tools\git') $gitRoot | Out-Null
$previousPath = $env:PATH
try {
  $env:PATH = $scratch
  Check 'the installer''s private Git answers when PATH has none' ([string]$skew.Invoke($null, @([string]$ws,[string]$match)) -match 'SOURCE_RUNTIME_SKEW')
} finally { $env:PATH = $previousPath }
& cmd.exe /d /c rmdir (Join-Path $ws '.tools\git')
$previousPath = $env:PATH
try {
  $env:PATH = $scratch
  Check 'Git unavailable is explicit rather than silent parity' ([string]$skew.Invoke($null, @([string]$ws,[string]$match)) -match 'SOURCE_PARITY_UNAVAILABLE')
} finally { $env:PATH = $previousPath }
Write-Host "PASS all runtime parity checks; scratch preserved at $scratch"
