# saipen scheduled injector -- headless body of the 'saipen-inject' task.
# A background run never updates its development clone. It accepts only a
# clean worktree, snapshots one committed HEAD, rechecks source stability, and
# injects from that immutable snapshot. Refusals leave installed configs alone.

param([string]$CloneRoot = (Split-Path $PSScriptRoot -Parent))

$ErrorActionPreference = "Stop"
$logDir = Join-Path $env:LOCALAPPDATA "saipen"
try {
  [System.IO.Directory]::CreateDirectory($logDir) | Out-Null
} catch {
  Write-Host "FATAL: scheduler log directory unavailable: $($_.Exception.Message)"
  exit 1
}
$log = Join-Path $logDir "inject.log"
$runId = [System.Guid]::NewGuid().ToString("N")
$archive = Join-Path $logDir ("source-{0}.zip" -f $runId)
$snapshot = Join-Path $logDir ("source-{0}" -f $runId)
$raw = Join-Path $logDir ("inject-{0}.log" -f $runId)
$published = Join-Path $logDir "scheduled-source"
$previous = Join-Path $logDir "scheduled-source-previous"
$publishedChanged = $false

function Write-Log([string]$msg) {
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Add-Content -LiteralPath $log -Value $line -Encoding utf8
}

function Remove-RunFiles {
  $ok = $true
  foreach ($path in @($raw, $archive, $snapshot)) {
    if (Test-Path -LiteralPath $path) {
      try {
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
      } catch {
        Write-Log "cleanup: failed $path -- $($_.Exception.Message)"
        $ok = $false
      }
    }
  }
  return $ok
}

function Restore-PublishedSource {
  $ok = $true
  try {
    if (Test-Path -LiteralPath $published) {
      Remove-Item -LiteralPath $published -Recurse -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $previous) {
      Move-Item -LiteralPath $previous -Destination $published -ErrorAction Stop
    }
    $script:publishedChanged = $false
  } catch {
    Write-Log "rollback: failed published source -- $($_.Exception.Message)"
    $ok = $false
  }
  return $ok
}

function Stop-Run([string]$message, [int]$code) {
  Write-Log $message
  $cleanupOk = Remove-RunFiles
  if (-not $cleanupOk -and $code -eq 0) { $code = 1 }
  Write-Log "=== end rc=$code ==="
  exit $code
}

function Invoke-Git([string[]]$Arguments) {
  $output = @(& $script:GitPath @Arguments 2>&1)
  $rc = $LASTEXITCODE
  return [pscustomobject]@{ Rc = $rc; Output = @($output | ForEach-Object { "$_" }) }
}

function Get-InjectedSurface([string]$sourceRoot) {
  # The paths the injector actually copies, read from the ONE owner of that
  # list: saipen/MANIFEST.json. Duplicating it here would drift, and a drifted
  # copy would either block on something harmless or -- far worse -- publish an
  # edited protocol file this check no longer watches.
  $manifestPath = Join-Path $sourceRoot "saipen/MANIFEST.json"
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    Stop-Run "REFUSE: MANIFEST_MISSING $manifestPath" 1
  }
  try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Stop-Run "REFUSE: MANIFEST_UNREADABLE $($_.Exception.Message)" 1
  }
  $surface = New-Object System.Collections.Generic.List[string]
  foreach ($tree in @($manifest.copy_trees)) { if ($tree.src) { $surface.Add([string]$tree.src) } }
  foreach ($file in @($manifest.files)) { if ($file.src) { $surface.Add([string]$file.src) } }
  # The manifest decides what ships, so an edit to it is an edit to the surface.
  $surface.Add("saipen/MANIFEST.json")
  if ($surface.Count -eq 0) {
    Stop-Run "REFUSE: MANIFEST_EMPTY_SURFACE" 1
  }
  return ($surface | Sort-Object -Unique)
}

function Read-CleanStatus([string]$sourceRoot) {
  # T-1251: the guard exists so an EDITED PROTOCOL is never published to the
  # consumer homes. It used to reject any line of `git status -uall`, which on
  # a live project means the translation cache, the subSaipen kitchens, the
  # improve cycles and the user's own notes -- thousands of untracked files
  # that change nothing about what gets copied. The task was healthy, fired
  # every 15 minutes, and skipped every single time: a feature shipped inert.
  # Scoping the question to the injected surface keeps the property that
  # matters (an unstaged saipen/CORE.md still blocks) and drops the one that
  # made it useless.
  $surface = Get-InjectedSurface $sourceRoot
  $result = Invoke-Git (@("-C", $sourceRoot, "status", "--porcelain=v1",
                          "--untracked-files=all", "--") + $surface)
  if ($result.Rc -ne 0) {
    foreach ($line in $result.Output) { Write-Log ("status: " + $line) }
    Stop-Run "REFUSE: SOURCE_STATUS_FAILED rc=$($result.Rc)" 1
  }
  if (($result.Output -join "").Length -gt 0) {
    Write-Log ("surface: " + ($surface -join " "))
    foreach ($line in $result.Output) { Write-Log ("dirty: " + $line) }
    Stop-Run "SKIP: DIRTY_SOURCE" 2
  }
  Write-Log ("clean: injected surface matches HEAD (" + $surface.Count + " path(s))")
}

Write-Log "=== saipen scheduled inject run=$runId ==="
$env:GIT_OPTIONAL_LOCKS = "0"
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
  Stop-Run "REFUSE: GIT_UNAVAILABLE" 1
}
$GitPath = $git.Source

$rootResult = Invoke-Git @("-C", $CloneRoot, "rev-parse", "--show-toplevel")
if ($rootResult.Rc -ne 0 -or $rootResult.Output.Count -ne 1) {
  foreach ($line in $rootResult.Output) { Write-Log ("root: " + $line) }
  Stop-Run "REFUSE: SOURCE_ROOT_UNAVAILABLE rc=$($rootResult.Rc)" 1
}
$sourceRoot = $rootResult.Output[0].Trim()
try {
  $requestedRoot = [System.IO.Path]::GetFullPath(
    (Resolve-Path -LiteralPath $CloneRoot).Path).TrimEnd('\', '/')
  $resolvedRoot = [System.IO.Path]::GetFullPath($sourceRoot).TrimEnd('\', '/')
} catch {
  Stop-Run "REFUSE: SOURCE_ROOT_INVALID $($_.Exception.Message)" 1
}
if (-not $requestedRoot.Equals(
    $resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  Stop-Run "REFUSE: SOURCE_ROOT_MISMATCH requested=$requestedRoot git=$resolvedRoot" 1
}

Read-CleanStatus $sourceRoot
$headResult = Invoke-Git @("-C", $sourceRoot, "rev-parse", "--verify", "HEAD")
if ($headResult.Rc -ne 0 -or $headResult.Output.Count -ne 1) {
  Stop-Run "REFUSE: SOURCE_HEAD_UNAVAILABLE rc=$($headResult.Rc)" 1
}
$head = $headResult.Output[0].Trim()
Write-Log "source: HEAD $head"

try {
  $archiveResult = Invoke-Git @("-C", $sourceRoot, "archive", "--format=zip",
                                "--output=$archive", $head)
  if ($archiveResult.Rc -ne 0) {
    foreach ($line in $archiveResult.Output) { Write-Log ("archive: " + $line) }
    Stop-Run "REFUSE: SOURCE_SNAPSHOT_FAILED rc=$($archiveResult.Rc)" 1
  }
  Expand-Archive -LiteralPath $archive -DestinationPath $snapshot -Force

  # Catch edits or branch movement during preflight. Injection below reads only
  # the archive, so even a later edit can never produce a mixed-source install.
  Read-CleanStatus $sourceRoot
  $headAfter = Invoke-Git @("-C", $sourceRoot, "rev-parse", "--verify", "HEAD")
  if ($headAfter.Rc -ne 0 -or $headAfter.Output.Count -ne 1 -or
      $headAfter.Output[0].Trim() -ne $head) {
    Stop-Run "SKIP: SOURCE_CHANGED" 2
  }

  $injector = Join-Path $snapshot "bootstrap\inject.ps1"
  if (-not (Test-Path -LiteralPath $injector)) {
    Stop-Run "REFUSE: SNAPSHOT_INJECTOR_MISSING head=$head" 1
  }

  # Config blocks written by inject.ps1 name its SkillHome. Publish the exact
  # archived tree at one persistent path before invoking it; a temporary source
  # path would become dangling as soon as this run cleaned up.
  if (Test-Path -LiteralPath $previous) {
    Stop-Run "REFUSE: PUBLISHED_SOURCE_BACKUP_EXISTS path=$previous" 1
  }
  if (Test-Path -LiteralPath $published) {
    Move-Item -LiteralPath $published -Destination $previous -ErrorAction Stop
  }
  Move-Item -LiteralPath $snapshot -Destination $published -ErrorAction Stop
  $publishedChanged = $true
  $injector = Join-Path $published "bootstrap\inject.ps1"
  & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
    -File $injector *> $raw
  $rc = $LASTEXITCODE
  if (Test-Path -LiteralPath $raw) {
    Get-Content -LiteralPath $raw | ForEach-Object { Write-Log ("inject: " + $_) }
  }
  if ($null -eq $rc) { $rc = 0 }
  Write-Log "inject: head=$head exit=$rc"
  if ($rc -ne 0) {
    if (-not (Restore-PublishedSource)) { $rc = 1 }
  } else {
    # T-1252: inject.ps1 copies the protocol but writes no freshness stamp, so
    # every refreshed home read as "installed unstamped" forever and a drifted
    # copy was indistinguishable from a current one. The digest has exactly one
    # owner, tools/autoinject.py, so the stamp is written by calling it rather
    # than by a second implementation here that would drift from it. A missing
    # interpreter is logged and left visible: the COPY is good, only its
    # witness is absent, and `autoinject.py --check` says so out loud instead
    # of this run pretending it stamped something.
    $stamper = Join-Path $published "tools\autoinject.py"
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) { $python = Get-Command python3 -ErrorAction SilentlyContinue }
    if (-not $python) {
      Write-Log "stamp: SKIPPED no python on PATH -- copies are current but unstamped"
    } elseif (-not (Test-Path -LiteralPath $stamper)) {
      Write-Log "stamp: SKIPPED tools/autoinject.py absent from the published source"
    } else {
      $stampOutput = @(& $python.Source $stamper "--stamp-only" "--source-head" $head 2>&1)
      $stampRc = $LASTEXITCODE
      foreach ($line in $stampOutput) { Write-Log ("stamp: " + $line) }
      if ($stampRc -ne 0) { Write-Log "stamp: FAILED rc=$stampRc" }
    }
    try {
      if (Test-Path -LiteralPath $previous) {
        Remove-Item -LiteralPath $previous -Recurse -Force -ErrorAction Stop
      }
      $publishedChanged = $false
    } catch {
      Write-Log "cleanup: failed previous published source -- $($_.Exception.Message)"
      $rc = 1
    }
  }
  $cleanupOk = Remove-RunFiles
  if (-not $cleanupOk -and $rc -eq 0) { $rc = 1 }
  Write-Log "=== end rc=$rc ==="
  exit $rc
} catch {
  if ($publishedChanged -or (Test-Path -LiteralPath $previous)) {
    [void](Restore-PublishedSource)
  }
  Stop-Run "REFUSE: PREFLIGHT_FAILED $($_.Exception.Message)" 1
}
