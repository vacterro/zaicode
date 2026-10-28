$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
# Raw .NET File APIs take the path as a plain string, and on Unix a
# backslash is a legal filename character, not a directory separator --
# PowerShell cmdlets normalize the Windows-style paths below, but
# [System.IO.File] does not, so every raw .NET call gets the
# platform-native spelling.
function Get-NativePath([string]$path) {
  return $path.Replace('\', [System.IO.Path]::DirectorySeparatorChar)
}

function Remove-Block([string]$file) {
  if (Test-Path $file) {
    if (-not (Test-Path $file -PathType Leaf)) { throw "config path is not a file: $file" }
    $text = [System.IO.File]::ReadAllText((Get-NativePath $file))
    $match = [regex]::Match($text, '(?s)(?:\r\n|\n)?<!-- SAIPEN:BEGIN -->.*?<!-- SAIPEN:END -->(?:\r\n|\n)?')
    if ($match.Success) {
      $clean = $text.Substring(0, $match.Index) + $text.Substring($match.Index + $match.Length)
      # Backup the file before uninstalling just in case
      Copy-Item $file "$file.uninstalled.bak" -Force -ErrorAction Stop
      [System.IO.File]::WriteAllText((Get-NativePath $file), $clean, $Utf8NoBom)
      return "block removed"
    }
  }
  return "clean"
}

function Remove-Skill([string]$path) {
  if (Test-Path $path) {
    try {
      Remove-Item -Recurse -Force $path -ErrorAction Stop
      return "skill removed"
    } catch {
      return "remove FAILED ($path): $($_.Exception.Message)"
    }
  }
  return "clean"
}

function Get-SchedulerTask([string]$Name) {
  $queryErrors = @()
  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue `
    -ErrorVariable +queryErrors
  $unexpected = @($queryErrors | Where-Object {
    $_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound
  })
  if ($unexpected.Count -gt 0) {
    throw "could not query $Name`: $($unexpected[0].Exception.Message)"
  }
  return $task
}

function Test-SchedulerTaskWithSchtasks([string]$Name) {
  schtasks /Query /TN $Name 2>&1 | Out-Null
  $specificRc = $LASTEXITCODE
  if ($specificRc -eq 0) { return $true }
  # A successful all-task query proves Task Scheduler is reachable, so only
  # this name is absent. Two failed queries mean unknown service/access state.
  schtasks /Query /FO CSV /NH 2>&1 | Out-Null
  $allRc = $LASTEXITCODE
  if ($allRc -eq 0) { return $false }
  throw "could not query $Name (schtasks rc $specificRc; all-task query rc $allRc)"
}

function Remove-Task() {
  # Remove the auto-scheduled inject task (T-531) when uninstalling, so a
  # de-advertised protocol does not keep pulling + injecting every 15 minutes.
  # Windows-only: Get-ScheduledTask does not exist on pwsh/Linux, and a host
  # that never ran the scheduler has nothing to remove -- both are clean. The
  # sandboxed injector probe sets SAIPEN_UNINSTALL_SKIP_TASK because the task
  # is machine-global and a test run must not delete real machine state.
  if ($env:SAIPEN_UNINSTALL_SKIP_TASK) { return "clean" }
  $hasScheduledTaskCmdlet = [bool](Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)
  if (-not $hasScheduledTaskCmdlet -and
      -not (Get-Command schtasks -ErrorAction SilentlyContinue)) {
    return "clean"
  }
  $removed = @()
  $failures = @()
  foreach ($taskName in @("saipen-inject", "saipen-autoinject")) {
    try {
      if ($hasScheduledTaskCmdlet) {
        $present = [bool](Get-SchedulerTask $taskName)
      } else {
        $present = Test-SchedulerTaskWithSchtasks $taskName
      }
    } catch {
      $failures += $_.Exception.Message
      continue
    }
    if (-not $present) { continue }
    schtasks /Delete /TN $taskName /F 2>&1 | Out-Null
    $deleteRc = $LASTEXITCODE
    if ($deleteRc -eq 0) {
      $removed += $taskName
    } else {
      $failures += "$taskName rc $deleteRc"
    }
  }
  if ($failures.Count -gt 0) {
    return "task remove FAILED ($($failures -join ', ')); wrapper preserved"
  }
  $runtimeDir = Join-Path $env:LOCALAPPDATA "saipen"
  $runtimeWrapper = Join-Path $runtimeDir "schedule-run-hidden.vbs"
  $runtimeSource = Join-Path $runtimeDir "scheduled-source"
  try {
    if (Test-Path -LiteralPath $runtimeWrapper) {
      Remove-Item -LiteralPath $runtimeWrapper -Force -ErrorAction Stop
      $removed += "runtime wrapper"
    }
    if (Test-Path -LiteralPath $runtimeSource) {
      Remove-Item -LiteralPath $runtimeSource -Recurse -Force -ErrorAction Stop
      $removed += "runtime source"
    }
    if (Test-Path -LiteralPath $runtimeDir) {
      Get-ChildItem -LiteralPath $runtimeDir -Force -ErrorAction Stop |
        Where-Object {
          $_.Name -like "scheduled-source-previous*" -or
          $_.Name -like "source-*" -or
          $_.Name -like "inject-*.log"
        } |
        ForEach-Object {
          Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
          $removed += "runtime source backup"
        }
    }
  } catch {
    return "scheduler runtime remove FAILED ($runtimeDir): $($_.Exception.Message)"
  }
  if ($removed.Count -gt 0) { return "removed: $($removed -join ', ')" }
  return "clean"
}

function Remove-Aider([string]$file) {
  # Remove exactly the block the injector wrote (comment + read: key +
  # consecutive saipen BOOT/STYLE items), CRLF-tolerant -- never any other
  # read: line the user owns.
  if (Test-Path $file) {
    if (-not (Test-Path $file -PathType Leaf)) { throw "config path is not a file: $file" }
    $bytes = [System.IO.File]::ReadAllBytes((Get-NativePath $file))
    # Latin-1 maps one byte to one character, so regex indices are byte offsets.
    # Managed lines are ASCII; untouched BOM/non-UTF8/user bytes stay untouched.
    $byteText = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
    $blockRe = '(?m)(?:^|\r?\n)# saipen protocol auto-loaded\r?\nread:\r?\n[ \t]*-[ \t][^\r\n]*saipen[\\/]BOOT\.md\r?\n[ \t]*-[ \t][^\r\n]*saipen[\\/]STYLE\.md(?:\r?\n)?'
    $match = [regex]::Match($byteText, $blockRe)
    if ($match.Success) {
      $clean = New-Object byte[] ($bytes.Length - $match.Length)
      [System.Buffer]::BlockCopy($bytes, 0, $clean, 0, $match.Index)
      $suffixLength = $bytes.Length - $match.Index - $match.Length
      if ($suffixLength -gt 0) {
        [System.Buffer]::BlockCopy($bytes, $match.Index + $match.Length,
          $clean, $match.Index, $suffixLength)
      }
      Copy-Item $file "$file.uninstalled.bak" -Force -ErrorAction Stop
      [System.IO.File]::WriteAllBytes((Get-NativePath $file), $clean)
      return "aider conf cleaned"
    } elseif ($byteText -match 'saipen[\\/]BOOT\.md') {
      return "manual aider conf (please remove manually)"
    }
  }
  return "clean"
}

$h = $env:USERPROFILE
$script:BootstrapFailed = $false

function Remove-Hooks {
  # Hook surfaces come from the ONE adapter registry, never a second
  # handwritten host inventory. It removes both the current install surface and
  # every registry-declared legacy surface -- including the singular `plugin/`
  # copy the supported runtime would otherwise load a second time.
  $registryPath = Join-Path (Split-Path $PSScriptRoot) "extensions\adapters\registry.json"
  if (-not (Test-Path $registryPath)) { return "adapter registry missing: $registryPath" }
  try {
    $registry = Get-Content -LiteralPath $registryPath -Raw -Encoding utf8 | ConvertFrom-Json
  } catch {
    return "adapter registry read FAILED: $($_.Exception.Message)"
  }
  $surfaces = @()
  foreach ($adapter in @($registry.adapters)) {
    if ($adapter.PSObject.Properties.Name -contains "install" -and $adapter.install) {
      if ($adapter.install.PSObject.Properties.Name -contains "hook" -and $adapter.install.hook) {
        $surfaces += [string]$adapter.install.hook
      }
    }
    if ($adapter.PSObject.Properties.Name -contains "legacy_hook_surfaces") {
      foreach ($surface in @($adapter.legacy_hook_surfaces)) {
        if ($surface) { $surfaces += [string]$surface }
      }
    }
  }
  $removed = 0
  foreach ($surface in $surfaces) {
    $path = $surface.Replace("~", $h)
    if (-not (Test-Path $path -PathType Leaf)) { continue }
    try {
      Remove-Item -LiteralPath $path -Force -ErrorAction Stop
      $removed++
    } catch {
      return "hook remove FAILED ($path): $($_.Exception.Message)"
    }
  }
  if ($removed -gt 0) { return "guard hook removed" }
  return "clean"
}

function Report([string]$label, [string]$result) {
  "{0,-28} {1}" -f $label, $result
  if ($result -match "FAILED") { $script:BootstrapFailed = $true }
}

Write-Host "saipen uninstaller"
Write-Host "------------------------------------------------------------"
Report "Claude Code skill" (Remove-Skill "$h\.claude\skills\saipen")
Report "Claude Code CLAUDE.md" (Remove-Block "$h\.claude\CLAUDE.md")
Report "OpenCode skill" (Remove-Skill "$h\.config\opencode\skills\saipen")
Report "OpenCode AGENTS.md" (Remove-Block "$h\.config\opencode\AGENTS.md")
Report "guard hooks" (Remove-Hooks)
Report "Codex skill" (Remove-Skill "$h\.codex\skills\saipen")
Report "Codex AGENTS.md" (Remove-Block "$h\.codex\AGENTS.md")
Report "Gemini GEMINI.md" (Remove-Block "$h\.gemini\GEMINI.md")
Report "~/.agents skills" (Remove-Skill "$h\.agents\skills\saipen")
$plugRoot = "$h\.gemini\config\plugins"
if (Test-Path $plugRoot) {
  Get-ChildItem $plugRoot -Directory | ForEach-Object {
    $skillsPath = Join-Path $_.FullName "skills\saipen"
    Report "Antigravity [$($_.Name)]" (Remove-Skill $skillsPath)
  }
}
Report "Aider conf" (Remove-Aider "$h\.aider.conf.yml")
Report "scheduled inject task" (Remove-Task)
Write-Host "------------------------------------------------------------"
if ($script:BootstrapFailed) {
  Write-Host "FAILED. Fix reported errors and re-run." -ForegroundColor Red
  exit 1
}
Write-Host "Done. SAIPEN global hooks removed."
