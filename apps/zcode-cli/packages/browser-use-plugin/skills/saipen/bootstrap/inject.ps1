# saipen injector -- installs saipen as default protocol on every agentic system found.
# Run from the clone dir:  powershell -ExecutionPolicy Bypass -File .\inject.ps1
# Idempotent: safe to re-run any time (skips what's already installed).
#
# Host inventory law (SRC-028:R008 / SRC-030 Part 7): every installed host,
# its surfaces and its blocking hook come from extensions/adapters/registry.json.
# This script contains NO handwritten host list; the per-adapter loop below is
# data-driven, and only the three registry-declared bespoke installers
# (freebuff-backstop, aider-conf, antigravity-plugins) keep hand-written bodies.

# Optional host filter (T-1319 TARGET 1): with -AdapterId NAME the injector
# updates ONLY that registered adapter's surfaces plus the common ones it
# declares. Default (empty) retains the all-host behavior. The host inventory
# stays extensions/adapters/registry.json; this is a filter, not a second list.
param(
  [string]$SkillHome = (Join-Path (Split-Path $PSScriptRoot) "saipen"),
  [string]$AdapterId = ""
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
# Raw .NET File APIs take the path as a plain string, and on Unix a
# backslash is a legal filename character, not a directory separator --
# PowerShell cmdlets (Test-Path, Copy-Item) normalize the Windows-style
# paths below, but [System.IO.File] does not, so every raw .NET call gets
# the platform-native spelling.
function Get-NativePath([string]$path) {
  return $path.Replace('\', [System.IO.Path]::DirectorySeparatorChar)
}
function Write-NoBom([string]$file, [string]$text) {
  if ((Test-Path $file) -and -not (Test-Path "$file.bak")) { Copy-Item $file "$file.bak" -Force }
  [System.IO.File]::WriteAllText((Get-NativePath $file), $text, $Utf8NoBom)
}
try { $SkillHome = (Resolve-Path $SkillHome).Path } catch {
  Write-Host "FATAL: saipen folder not found at $SkillHome" -ForegroundColor Red; exit 1
}
# BOOT.md, not RFC.md: the sanity check must name the file the injected block
# actually sends agents to. RFC.md has been a redirect stub since the v7.190.0
# split, so a clone missing BOOT.md but carrying the stub would pass this guard
# and install an entry point with no rules behind it.
if (-not (Test-Path (Join-Path $SkillHome "BOOT.md"))) {
  Write-Host "FATAL: BOOT.md missing in $SkillHome" -ForegroundColor Red; exit 1
}
$Root = Split-Path $SkillHome
$ManifestPath = Join-Path $SkillHome "MANIFEST.json"
try {
  $RuntimeManifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
} catch {
  Write-Host "FATAL: runtime manifest unreadable at $ManifestPath`: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
$RegistryPath = Join-Path $Root "extensions\adapters\registry.json"
try {
  $AdapterRegistry = Get-Content -LiteralPath $RegistryPath -Raw -Encoding utf8 | ConvertFrom-Json
} catch {
  Write-Host "FATAL: adapter registry unreadable at $RegistryPath`: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
if (-not $AdapterRegistry.adapters -or @($AdapterRegistry.adapters).Count -eq 0) {
  Write-Host "FATAL: adapter registry has no adapters: $RegistryPath" -ForegroundColor Red
  exit 1
}
# T-1319 TARGET 1: an optional host filter resolves against the registry ONLY.
# An unknown id is a hard failure, never a silent all-host run.
if (-not [string]::IsNullOrWhiteSpace($AdapterId)) {
  $knownAdapterIds = @($AdapterRegistry.adapters | ForEach-Object { [string]$_.id })
  if ($knownAdapterIds -notcontains $AdapterId) {
    Write-Host "FATAL: unknown adapter id '$AdapterId'; registry declares: $($knownAdapterIds -join ', ')" -ForegroundColor Red
    exit 1
  }
}
function Get-InstallRelativePath([string]$sourcePath) {
  $normalized = $sourcePath.Replace('\', '/')
  if ([string]::IsNullOrWhiteSpace($normalized) -or
      $normalized.StartsWith('/') -or
      $normalized -match '^[A-Za-z]:' -or
      $normalized -match '(^|/)\.\.(/|$)') {
    throw "unsafe runtime manifest path: $sourcePath"
  }
  if ($normalized.StartsWith('saipen/')) { $normalized = $normalized.Substring(7) }
  return $normalized.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
}

function Get-SourcePath([string]$sourcePath) {
  $normalized = $sourcePath.Replace('\', '/')
  if ([string]::IsNullOrWhiteSpace($normalized) -or
      $normalized.StartsWith('/') -or
      $normalized -match '^[A-Za-z]:' -or
      $normalized -match '(^|/)\.\.(/|$)') {
    throw "unsafe runtime manifest source: $sourcePath"
  }
  $native = $normalized.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
  $candidate = [System.IO.Path]::GetFullPath((Join-Path $Root $native))
  $rootPrefix = [System.IO.Path]::GetFullPath($Root).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  $comparison = if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    [System.StringComparison]::OrdinalIgnoreCase
  } else {
    [System.StringComparison]::Ordinal
  }
  if (-not $candidate.StartsWith($rootPrefix, $comparison)) {
    throw "runtime manifest source escapes repository root: $sourcePath"
  }
  return $candidate
}

try {
  if (@($RuntimeManifest.files).Count -eq 0 -or
      @($RuntimeManifest.copy_trees).Count -eq 0 -or
      @($RuntimeManifest.managed_dirs).Count -eq 0 -or
      @($RuntimeManifest.phase_docs.files).Count -eq 0) {
    throw "runtime manifest lacks nonempty files/copy_trees/managed_dirs/phase_docs.files"
  }
  foreach ($rel in @($RuntimeManifest.managed_dirs)) {
    if ($rel -isnot [string]) { throw "managed_dirs entries must be strings" }
    [void](Get-InstallRelativePath $rel)
  }
  foreach ($tree in @($RuntimeManifest.copy_trees)) {
    $names = @($tree.PSObject.Properties.Name)
    if ($names -notcontains "src" -or $names -notcontains "dst" -or
        $tree.src -isnot [string] -or $tree.dst -isnot [string]) {
      throw "copy_trees entries require string src/dst"
    }
    [void](Get-SourcePath $tree.src)
    [void](Get-InstallRelativePath $tree.dst)
  }
  $requiredCount = 0
  foreach ($entry in @($RuntimeManifest.files)) {
    $names = @($entry.PSObject.Properties.Name)
    if ($names -notcontains "src" -or $names -notcontains "required" -or
        $entry.src -isnot [string] -or $entry.required -isnot [bool]) {
      throw "files entries require string src and boolean required"
    }
    [void](Get-SourcePath $entry.src)
    [void](Get-InstallRelativePath $entry.src)
    if ($entry.required) { $requiredCount++ }
  }
  if ($requiredCount -eq 0) { throw "runtime manifest has no required files" }
  foreach ($phase in @($RuntimeManifest.phase_docs.files)) {
    if ($phase -isnot [string]) { throw "phase_docs.files entries must be strings" }
    [void](Get-InstallRelativePath "phases/$phase")
  }
} catch {
  Write-Host "FATAL: runtime manifest invalid: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

# ONE activation template (SRC-028:R009 / SRC-030 Part 8): the semantic block
# is rendered from saipen/ACTIVATION_BLOCK.md; only the SAIPEN home path is
# substituted. This script no longer carries its own copy of the block.
$TemplateSource = [string]$AdapterRegistry.activation_template
if ([string]::IsNullOrWhiteSpace($TemplateSource)) {
  Write-Host "FATAL: adapter registry names no activation_template" -ForegroundColor Red
  exit 1
}
$TemplatePath = Get-SourcePath $TemplateSource
if (-not (Test-Path $TemplatePath -PathType Leaf)) {
  Write-Host "FATAL: activation template missing: $TemplatePath" -ForegroundColor Red
  exit 1
}
$blockCore = [System.IO.File]::ReadAllText((Get-NativePath $TemplatePath), $Utf8NoBom)
$blockCore = $blockCore.Replace('{{SAIPEN_HOME}}', $SkillHome)
$blockCore = $blockCore.Trim([char[]]"`r`n")

function Get-Newline([string]$text) {
  if ($text.Contains("`r`n")) { return "`r`n" }
  return "`n"
}

function Get-BlockCore([string]$text) {
  $nl = Get-Newline $text
  return ($blockCore -replace "`r?`n", $nl)
}

function Add-Block([string]$file) {
  if (Test-Path $file) {
    if (-not (Test-Path $file -PathType Leaf)) { throw "config path is not a file: $file" }
    $text = [System.IO.File]::ReadAllText((Get-NativePath $file))
    $match = [regex]::Match($text, '(?s)<!-- SAIPEN:BEGIN -->.*?<!-- SAIPEN:END -->')
    $core = Get-BlockCore $text
    if ($match.Success) {
      $existing = $match.Value -replace "`r`n", "`n"
      $canonical = $blockCore -replace "`r`n", "`n"
      if ($existing -eq $canonical) { return "already" }
      $clean = $text.Substring(0, $match.Index) + $core + $text.Substring($match.Index + $match.Length)
      Write-NoBom $file $clean
      return "block refreshed"
    }
    $nl = Get-Newline $text
    Write-NoBom $file ($text + $nl + $core + $nl)
    return "block added"
  }
  $dir = Split-Path $file
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir -ErrorAction Stop | Out-Null }
  Write-NoBom $file ($blockCore + "`n")
  return "file created"
}

function Get-PythonBin {
  # The selected interpreter, shared by the launcher renderer and the runtime
  # identity proof: explicit override FIRST, then PATH, then the per-user
  # CPython layout. Never a guess that is not a file.
  $candidates = New-Object System.Collections.ArrayList
  if (-not [string]::IsNullOrWhiteSpace($env:SAIPEN_PYTHON)) { [void]$candidates.Add($env:SAIPEN_PYTHON) }
  foreach ($name in @("python", "python3")) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { [void]$candidates.Add([string]$cmd.Source) }
  }
  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python*\python.exe" -ErrorAction SilentlyContinue |
      ForEach-Object { [void]$candidates.Add($_.FullName) }
  }
  foreach ($candidate in $candidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path $candidate -PathType Leaf)) {
      return (Resolve-Path $candidate).Path
    }
  }
  return $null
}

# SAIPEN-CLI-LAUNCHER-OWNERSHIP:BEGIN
# The canonical installer OWNS the installed `saipen` launcher surface: the
# `bin/saipen` / `bin/saipen.cmd` files are rendered from the ONE source owner
# (bootstrap/cli_launcher.py) into the STAGED skill before the atomic swap, so a
# render failure aborts the install and preserves the active copy. The OpenCode
# guard only verifies them, never writes them.
function Write-CliLaunchers([string]$StageDir, [string]$SkillDir) {
  if ([string]::IsNullOrWhiteSpace($StageDir) -or [string]::IsNullOrWhiteSpace($SkillDir)) {
    return "FAILED: launcher stage/skill dir missing"
  }
  try {
    $pythonBin = Get-PythonBin
    if ([string]::IsNullOrWhiteSpace($pythonBin)) { return "FAILED: no Python runtime for launcher" }
    $renderer = Get-SourcePath "bootstrap/cli_launcher.py"
    if (-not (Test-Path $renderer -PathType Leaf)) { return "FAILED: launcher renderer missing" }
    $cli = Get-NativePath (Join-Path $SkillDir "tools\saipen.py")
    $outDir = Get-NativePath (Join-Path $StageDir "bin")
    $output = & $pythonBin $renderer --python $pythonBin --cli $cli --out-dir $outDir 2>&1
    if ($LASTEXITCODE -ne 0) { return "FAILED: launcher render ($output)" }
    if (-not (Test-Path (Join-Path $outDir "saipen.cmd") -PathType Leaf) -or
        -not (Test-Path (Join-Path $outDir "saipen") -PathType Leaf)) {
      return "FAILED: launcher files missing after render"
    }
    return "ok"
  } catch {
    return "FAILED: launcher render: $($_.Exception.Message)"
  }
}
# SAIPEN-CLI-LAUNCHER-OWNERSHIP:END

function Copy-Skill([string]$dst) {
  # MANIFEST.json owns every copied file/tree and replaced destination. Any
  # copy failure surfaces -- a claimed "copied" over a half-copy is exactly
  # the silent-failure class hunt.md exists to catch.
  if ([string]::IsNullOrWhiteSpace($dst)) { return "copy FAILED ($dst): unsafe destination" }
  $stage = $null
  $backup = $null
  try {
    $parent = Split-Path $dst
    if ([string]::IsNullOrWhiteSpace($parent)) { throw "unsafe destination parent" }
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force $parent -ErrorAction Stop | Out-Null }
    $leaf = Split-Path $dst -Leaf
    $stage = Join-Path $parent ".$leaf.saipen-stage-$PID"
    $backup = Join-Path $parent ".$leaf.saipen-backup-$PID"
    if ((Test-Path $stage) -or (Test-Path $backup)) {
      throw "stale staging/backup path exists; inspect before retry"
    }
    New-Item -ItemType Directory $stage -ErrorAction Stop | Out-Null
    foreach ($rel in $RuntimeManifest.managed_dirs) {
      [void](Get-InstallRelativePath ([string]$rel))
    }
    foreach ($tree in $RuntimeManifest.copy_trees) {
      $source = Get-SourcePath ([string]$tree.src)
      $target = Join-Path $stage (Get-InstallRelativePath ([string]$tree.dst))
      if (-not (Test-Path $source -PathType Container)) { throw "runtime manifest tree missing: $($tree.src)" }
      if (((Get-Item -LiteralPath $source -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "runtime manifest tree is a reparse point: $($tree.src)"
      }
      $reparse = Get-ChildItem -LiteralPath $source -Recurse -Force -ErrorAction Stop |
        Where-Object { ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 }
      if ($reparse) { throw "runtime manifest tree contains reparse point: $($reparse[0].FullName)" }
      New-Item -ItemType Directory -Force $target -ErrorAction Stop | Out-Null
      Get-ChildItem -LiteralPath $source -Force -ErrorAction Stop |
        Copy-Item -Destination $target -Recurse -Force -ErrorAction Stop
    }
    foreach ($entry in @($RuntimeManifest.files | Where-Object { $_.required -eq $true })) {
      $source = Get-SourcePath ([string]$entry.src)
      $target = Join-Path $stage (Get-InstallRelativePath ([string]$entry.src))
      if (-not (Test-Path $source -PathType Leaf)) { throw "runtime manifest file missing: $($entry.src)" }
      if (((Get-Item -LiteralPath $source -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "runtime manifest file is a reparse point: $($entry.src)"
      }
      $parent = Split-Path $target
      if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force $parent -ErrorAction Stop | Out-Null }
      Copy-Item -LiteralPath $source -Destination $target -Force -ErrorAction Stop
    }
    Get-ChildItem -LiteralPath $stage -Directory -Recurse -Force -ErrorAction Stop |
      Where-Object Name -eq "__pycache__" |
      Remove-Item -Recurse -Force -ErrorAction Stop
    Get-ChildItem -LiteralPath $stage -File -Recurse -Force -ErrorAction Stop |
      Where-Object Extension -in ".pyc", ".pyo" |
      Remove-Item -Force -ErrorAction Stop
    foreach ($entry in @($RuntimeManifest.files | Where-Object { $_.required -eq $true })) {
      $target = Join-Path $stage (Get-InstallRelativePath ([string]$entry.src))
      if (-not (Test-Path $target -PathType Leaf)) { throw "installed runtime file missing: $($entry.src)" }
    }
    foreach ($phase in $RuntimeManifest.phase_docs.files) {
      if (-not (Test-Path (Join-Path $stage "phases\$phase") -PathType Leaf)) {
        throw "installed phase document missing: $phase"
      }
    }
    # SAIPEN-CLI-LAUNCHER-OWNERSHIP:BEGIN
    $launcher = Write-CliLaunchers -StageDir $stage -SkillDir $dst
    if ($launcher -ne "ok") { throw "cli launcher render failed: $launcher" }
    # SAIPEN-CLI-LAUNCHER-OWNERSHIP:END
    if (Test-Path $dst) { Move-Item -LiteralPath $dst -Destination $backup -ErrorAction Stop }
    try {
      Move-Item -LiteralPath $stage -Destination $dst -ErrorAction Stop
      $stage = $null
    } catch {
      if ((Test-Path $backup) -and -not (Test-Path $dst)) {
        Move-Item -LiteralPath $backup -Destination $dst -ErrorAction SilentlyContinue
      }
      throw
    }
    if (Test-Path $backup) { Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction Stop }
    $backup = $null
    return "copied (re-run after updates)"
  } catch {
    if ($stage -and (Test-Path $stage)) {
      Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($backup -and (Test-Path $backup) -and -not (Test-Path $dst)) {
      Move-Item -LiteralPath $backup -Destination $dst -ErrorAction SilentlyContinue
    }
    return "copy FAILED ($dst): $($_.Exception.Message)"
  }
}

function Expand-Home([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return $null }
  return Get-NativePath ($path.Replace('~', $env:USERPROFILE))
}

function Copy-Hook($adapter) {
  # One artifact file, copied over by digest on every run (idempotent);
  # uninstall removes exactly this file and nothing else.
  try {
    if ((Has-Prop $adapter 'hook_installer') -and $adapter.hook_installer) {
      $installer = Get-SourcePath ([string]$adapter.hook_installer)
      $result = & python $installer ([string]$adapter.id) --home $env:USERPROFILE 2>&1
      if ($LASTEXITCODE -ne 0) { throw "native hook installer failed: $result" }
      return "guard hook and configuration installed; health unproven"
    }
    $source = Get-SourcePath ([string]$adapter.hook_artifact)
    $destination = Expand-Home ([string]$adapter.install.hook)
    if ([string]::IsNullOrWhiteSpace($destination)) { throw "registry hook surface is empty" }
    $parent = Split-Path $destination
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force $parent -ErrorAction Stop | Out-Null }
    Copy-Item -LiteralPath $source -Destination $destination -Force -ErrorAction Stop
    $shippedHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    $installedHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    if ($installedHash -ne $shippedHash) { throw "installed SHA-256 differs from shipped artifact" }
    if ([string]$adapter.id -eq 'opencode') {
      return "guard hook installed sha256=$installedHash; already-running OpenCode processes require restart"
    }
    return "guard hook installed sha256=$installedHash"
  } catch {
    return "hook FAILED ($($adapter.id)): $($_.Exception.Message)"
  }
}

function Remove-LegacyHook($adapter) {
  # The supported OpenCode runtime discovers BOTH the singular `plugin/` and
  # the plural `plugins/` global directories, so a stale copy of this one
  # artifact on the legacy surface would load the guard hook twice. The
  # injector removes that exact stale copy -- never a directory, never
  # anything else.
  try {
    if (-not (Has-Prop $adapter 'legacy_hook_surfaces')) { return "clean" }
    $removed = 0
    foreach ($surface in @($adapter.legacy_hook_surfaces)) {
      $legacy = Expand-Home ([string]$surface)
      if ([string]::IsNullOrWhiteSpace($legacy)) { continue }
      if (Test-Path $legacy -PathType Leaf) {
        Remove-Item -LiteralPath $legacy -Force -ErrorAction Stop
        $removed++
      }
    }
    if ($removed -gt 0) { return "legacy hook removed" }
    return "clean"
  } catch {
    return "legacy hook remove FAILED ($($adapter.id)): $($_.Exception.Message)"
  }
}

function Has-Prop($object, [string]$name) {
  return ($object.PSObject.Properties.Name -contains $name)
}

# --- T-1319 TARGET 2: install-time runtime provenance ---------------------
# A stale installed runtime cannot discover canonical source from its own
# __file__ (that is the INSTALLED tree). The canonical installer therefore
# stamps each installed skill home with one small machine-readable record the
# runtime reads back before it mutates anything. Project state is NEVER stored
# here; this is install provenance only.
#
# T-1342: the installer generation label and the runtime fingerprint are NOT
# defined here. Both come from the ONE owner in the source tree's own engine
# (tools/saipen_engine/runtime_bootstrap.py GENERATION and
# tools/saipen_engine/runtime_surface.py), so the fingerprint a marker records
# is the same manifest-derived identity every freshness check compares. The
# private inventory this script used to hash (saipen.py + registry + manifest +
# engine *.py) was a second definition that could call a stale validator,
# phase document or hook artifact current.
$ProvenanceName = ".saipen_runtime.json"
$script:SourceRuntimeIdentity = $null

function Get-RuntimeIdentity([string]$candidate) {
  $pythonBin = Get-PythonBin
  if ([string]::IsNullOrWhiteSpace($pythonBin)) { throw "no Python runtime to prove the runtime identity" }
  $tools = Join-Path $Root "tools"
  # -I: isolated (no PYTHONPATH/user site, no cwd on sys.path), -B: never write
  # bytecode into the tree being proven. The engine is imported from THIS
  # source tree only.
  $code = "import json,sys;sys.path.insert(0,sys.argv[1]);" +
    "from saipen_engine.runtime_bootstrap import GENERATION;" +
    "from saipen_engine.runtime_surface import require_runtime_generation_identity as identity;" +
    "print(json.dumps({'installer_generation':GENERATION,'runtime_fingerprint':identity(sys.argv[2])}))"
  $output = @(& $pythonBin -I -B -c $code $tools $candidate)
  if ($LASTEXITCODE -ne 0 -or $output.Count -eq 0) {
    throw "runtime identity unprovable for $candidate (exit $LASTEXITCODE)"
  }
  $identity = ([string]$output[-1]) | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$identity.runtime_fingerprint) -or
      [string]::IsNullOrWhiteSpace([string]$identity.installer_generation)) {
    throw "runtime identity for $candidate is incomplete"
  }
  return $identity
}

function Get-SourceRuntimeIdentity {
  # The source tree is immutable for one run (the scheduled runner injects
  # from a published snapshot), so it is proven once; every installed copy is
  # still proven on its own.
  if ($null -eq $script:SourceRuntimeIdentity) {
    $script:SourceRuntimeIdentity = Get-RuntimeIdentity $Root
  }
  return $script:SourceRuntimeIdentity
}

function Write-RuntimeProvenance($adapter, [string]$skillDir) {
  # Provenance is REQUIRED recovery state, not optional diagnostics: the caller
  # records this result and a failure makes the host-scoped migration
  # non-successful. Never swallow the error.
  if ([string]::IsNullOrWhiteSpace($skillDir) -or -not (Test-Path $skillDir -PathType Container)) {
    return "FAILED: provenance skill dir missing"
  }
  try {
    $version = ""
    $versionFile = Join-Path $Root "VERSION"
    if (Test-Path $versionFile -PathType Leaf) {
      $version = ([System.IO.File]::ReadAllText((Get-NativePath $versionFile))).Trim()
    }
    $head = ""
    try {
      $headOut = & git -C $Root rev-parse HEAD 2>$null
      if ($LASTEXITCODE -eq 0 -and $headOut) { $head = ([string]$headOut).Trim() }
    } catch { $head = "" }
    $expectedRoot = [System.IO.Path]::GetFullPath($Root)
    $sourceIdentity = Get-SourceRuntimeIdentity
    $expectedFp = [string]$sourceIdentity.runtime_fingerprint
    $installerGeneration = [string]$sourceIdentity.installer_generation
    # The copy just made must BE the source generation, proven over its own
    # declared surface -- not assumed from a successful Copy-Item.
    $installedFp = [string](Get-RuntimeIdentity $skillDir).runtime_fingerprint
    if ($installedFp -ne $expectedFp) {
      return "FAILED: installed runtime identity $installedFp differs from source $expectedFp"
    }
    $record = [ordered]@{
      schema_version        = 1
      adapter_id            = [string]$adapter.id
      canonical_source_root = $expectedRoot
      source_version        = $version
      source_build          = $head
      runtime_fingerprint   = $expectedFp
      installer_generation  = $installerGeneration
    }
    $json = ($record | ConvertTo-Json -Depth 4)
    $markerPath = Get-NativePath (Join-Path $skillDir $ProvenanceName)
    [System.IO.File]::WriteAllText($markerPath, $json, $Utf8NoBom)
    if (-not (Test-Path $markerPath -PathType Leaf)) {
      return "FAILED: provenance marker not written"
    }
    $doc = [System.IO.File]::ReadAllText($markerPath) | ConvertFrom-Json
    $problems = @()
    if ([string]$doc.adapter_id -ne [string]$adapter.id) { $problems += "adapter_id" }
    if ([string]$doc.canonical_source_root -ne $expectedRoot) { $problems += "canonical_source_root" }
    if ([string]$doc.installer_generation -ne $installerGeneration) { $problems += "installer_generation" }
    if ([string]::IsNullOrWhiteSpace([string]$doc.runtime_fingerprint)) {
      $problems += "runtime_fingerprint-missing"
    } elseif ($expectedFp -and ([string]$doc.runtime_fingerprint -ne $expectedFp)) {
      $problems += "runtime_fingerprint-mismatch"
    }
    if ($problems.Count -gt 0) {
      return ("FAILED: provenance invalid: " + ($problems -join ","))
    }
    return "verified"
  } catch {
    return ("FAILED: provenance write/validate: " + $_.Exception.Message)
  }
}

$h = $env:USERPROFILE
$report = New-Object System.Collections.ArrayList

# --- Data-driven host loop (extensions/adapters/registry.json is the only
# --- host inventory). Adapters without an `install` object are documented
# --- surfaces only and install nothing.
foreach ($adapter in @($AdapterRegistry.adapters)) {
  if (-not [string]::IsNullOrWhiteSpace($AdapterId) -and ([string]$adapter.id) -ne $AdapterId) { continue }
  if (-not (Has-Prop $adapter 'install') -or $null -eq $adapter.install) { continue }
  $install = $adapter.install
  $label = [string]$adapter.name

  if ((Has-Prop $install 'bespoke') -and $install.bespoke) {
    switch ([string]$install.bespoke) {
      'freebuff-backstop' {
        # --- Generic ~/.agents/skills (FreeBuff etc.) ---
        # Copy, lowercase: these readers skip junctions and uppercase dirs.
        # Positive host detection (not directory-exists-only): create parent when a supported host is present.
        $agentsSupported = (Test-Path "$h\.config\opencode") -or (Test-Path "$h\.codex") -or (Test-Path "$h\.gemini") -or (Test-Path "$h\.codebuddy") -or (Test-Path "$h\.claude") -or (Test-Path "$h\.agents") -or (Get-Command freebuff -ErrorAction SilentlyContinue) -or (Get-Command codebuddy -ErrorAction SilentlyContinue)
        $agentsSkillDir = "$h\.agents\skills\saipen"
        $agentsSkillRes = $null
        if (Test-Path "$h\.agents\skills") {
          $agentsSkillRes = (Copy-Skill $agentsSkillDir)
          [void]$report.Add(@("~/.agents skills", $agentsSkillRes))
        } elseif ($agentsSupported) {
          # Host supports generic skill root but hasn't created the directory yet -- create it.
          $agentsSkillRes = (Copy-Skill $agentsSkillDir)
          [void]$report.Add(@("~/.agents skills", $agentsSkillRes))
        } else { [void]$report.Add(@("~/.agents", "not installed - skip")) }
        if ($agentsSkillRes -and ($agentsSkillRes -match '^(copied|already)')) {
          [void]$report.Add(@("~/.agents provenance", (Write-RuntimeProvenance $adapter $agentsSkillDir)))
        }

        # --- FreeBuff always-on activation backstop ---
        # T-1426 live RED: FreeBuff ships TWO loaders with DIFFERENT home
        # knowledge contracts, so installing ONE surface leaves the other
        # loader blind:
        #   * the freebuff CLI reads the FIRST existing of ~/.knowledge.md,
        #     ~/.AGENTS.md, ~/.claude.md;
        #   * FreeBuff Desktop (orchestrator loadUserKnowledgeFiles) scans the
        #     home for DOT-prefixed entries only and reads the FIRST of
        #     .AGENTS.md, .CLAUDE.md -- ~/.knowledge.md is not a home surface
        #     for it at all.
        # The registry declares every surface (instruction_surfaces); the
        # backstop installs ALL of them. An either/or choice here is exactly
        # the defect class this backstop exists to remove.
        $freebuffDetected = (Test-Path "$h\.agents") -or (Get-Command freebuff -ErrorAction SilentlyContinue) -or (Test-Path "$h\.agents\skills")
        if ($freebuffDetected) {
          $fbSurfaces = @($adapter.instruction_surfaces | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
          if ($fbSurfaces.Count -eq 0) {
            [void]$report.Add(@("FreeBuff", "FAILED: registry declares no instruction_surfaces"))
          }
          foreach ($fbSurface in $fbSurfaces) {
            $fbResolved = Expand-Home ([string]$fbSurface)
            if ([string]::IsNullOrWhiteSpace($fbResolved)) {
              [void]$report.Add(@("FreeBuff", "FAILED: empty instruction surface '$fbSurface'"))
              continue
            }
            [void]$report.Add(@("FreeBuff $fbSurface", (Add-Block $fbResolved)))
          }
        } else { [void]$report.Add(@("FreeBuff", "not installed - skip")) }
      }
      'aider-conf' {
        # --- Aider (boot set is BOOT.md + STYLE.md, same promise as every platform) ---
        $aider = "$h\.aider.conf.yml"
        $skillPath = Join-Path $SkillHome "BOOT.md"
        $stylePath = Join-Path $SkillHome "STYLE.md"
        if (Get-Command aider -ErrorAction SilentlyContinue) {
          if (Test-Path $aider) {
            $conf = Get-Content $aider -Raw -Encoding utf8
            if (($conf -match [regex]::Escape($skillPath)) -and ($conf -match [regex]::Escape($stylePath))) {
              [void]$report.Add(@("Aider conf", "already"))
            } elseif ($conf -notmatch '(?m)^read:') {
              if (-not (Test-Path "$aider.bak")) { Copy-Item $aider "$aider.bak" -Force -ErrorAction Stop }
              $original = [System.IO.File]::ReadAllBytes((Get-NativePath $aider))
              $addition = $Utf8NoBom.GetBytes("`n# saipen protocol auto-loaded`nread:`n  - $skillPath`n  - $stylePath`n")
              $combined = New-Object byte[] ($original.Length + $addition.Length)
              [System.Buffer]::BlockCopy($original, 0, $combined, 0, $original.Length)
              [System.Buffer]::BlockCopy($addition, 0, $combined, $original.Length, $addition.Length)
              [System.IO.File]::WriteAllBytes((Get-NativePath $aider), $combined)
              [void]$report.Add(@("Aider conf", "read: appended"))
            } else {
              [void]$report.Add(@("Aider conf", "has own read: - add manually: $skillPath + $stylePath"))
            }
          } else {
            Write-NoBom $aider "# saipen protocol auto-loaded`nread:`n  - $skillPath`n  - $stylePath`n"
            [void]$report.Add(@("Aider conf", "created"))
          }
        } else { [void]$report.Add(@("Aider", "not installed - skip")) }
      }
      'antigravity-plugins' {
        # --- Antigravity plugins (copy: IDE locks dirs, junction impossible while open) ---
        $plugRoot = "$h\.gemini\config\plugins"
        if (Test-Path $plugRoot) {
          Get-ChildItem $plugRoot -Directory | ForEach-Object {
            $skillsDir = Join-Path $_.FullName "skills"
            if (Test-Path $skillsDir) {
              $agDst = (Join-Path $skillsDir "saipen")
              $agRes = (Copy-Skill $agDst)
              [void]$report.Add(@("Antigravity [$($_.Name)]", $agRes))
              if ($agRes -match '^(copied|already)') {
                [void]$report.Add(@("Antigravity [$($_.Name)] provenance", (Write-RuntimeProvenance $adapter $agDst)))
              }
            }
          }
        }
      }
      default {
        [void]$report.Add(@($label, "unknown bespoke installer '$($install.bespoke)' - skip"))
      }
    }
    continue
  }

  # NOT $home: $HOME is a read-only automatic variable in PowerShell, so the
  # old spelling failed the whole host loop for every adapter (reproduced on
  # pwsh 7 during the T-1317 audit).
  $hostHome = Expand-Home ([string]$install.home)
  if ([string]::IsNullOrWhiteSpace($hostHome) -or -not (Test-Path $hostHome)) {
    [void]$report.Add(@($label, "not installed - skip"))
    continue
  }
  if ((Has-Prop $install 'skill') -and $install.skill) {
    $skillDst = Expand-Home ([string]$install.skill)
    $skillResult = Copy-Skill $skillDst
    [void]$report.Add(@("$label skill", $skillResult))
    if ($skillResult -match '^(copied|already)') {
      [void]$report.Add(@("$label provenance", (Write-RuntimeProvenance $adapter $skillDst)))
    }
  }
  if ((Has-Prop $install 'instruction') -and $install.instruction) {
    [void]$report.Add(@("$label instructions", (Add-Block (Expand-Home ([string]$install.instruction)))))
  }
  if ((Has-Prop $install 'hook') -and $install.hook) {
    [void]$report.Add(@("$label guard hook", (Copy-Hook $adapter)))
    [void]$report.Add(@("$label legacy hook", (Remove-LegacyHook $adapter)))
  }
}

# --- Report ---
Write-Host ""
Write-Host "saipen injector report (source: $SkillHome)" -ForegroundColor Yellow
Write-Host ("-" * 60)
foreach ($r in $report) {
  $color = if ($r[1] -match "FAILED|manually") { "Red" }
           elseif ($r[1] -match "already|skip") { "DarkGray" } else { "Green" }
  Write-Host ("{0,-28} {1}" -f $r[0], $r[1]) -ForegroundColor $color
}
Write-Host ("-" * 60)
$failed = @($report | Where-Object { $_[1] -match "FAILED" })
if ($failed.Count -gt 0) {
  Write-Host "FAILED. Fix reported errors and re-run." -ForegroundColor Red
  exit 1
}
Write-Host "Done. Test: open any project in any agent, say: saipen set" -ForegroundColor Yellow
