# ZAICODE install checks: one ordered list, each with a test and a repair.
# The installer is "repair everything" on an empty folder; the doctor
# (Autotroubleshoot) runs the same tests and repairs only what fails.
# Every repair is idempotent. Dot-source after ZaicodeInstallLib.ps1.
#
# Tests and repairs are switch arms over a context object, not script blocks:
# a script block does not close over the locals of the function that made it.

$script:ZaicodeCheckList = @(
  @{ Id = 'git';             Title = 'Git';                                  Level = 'FAIL' },
  @{ Id = 'node';            Title = 'Node.js 24';                           Level = 'FAIL' },
  @{ Id = 'python';          Title = 'Python 3.11+';                         Level = 'FAIL' },
  @{ Id = 'pnpm';            Title = 'pnpm (pinned)';                        Level = 'FAIL' },
  @{ Id = 'workspace';       Title = 'ZAICODE workspace (launcher, docs)';   Level = 'FAIL' },
  @{ Id = 'app-source';      Title = 'ZAICODE app source';                   Level = 'FAIL' },
  @{ Id = 'saipen';          Title = 'SAIPEN';                               Level = 'FAIL' },
  @{ Id = 'saipen-launcher'; Title = 'SAIPEN launcher';                      Level = 'FAIL' },
  @{ Id = 'saimail';         Title = 'SAIMAIL';                              Level = 'FAIL' },
  @{ Id = 'saimail-cli';     Title = 'saimail-local (SAIMAIL panels)';       Level = 'WARN' },
  @{ Id = 'router';          Title = '9router package (zero-setup SAIFREN)'; Level = 'WARN' },
  @{ Id = 'modules';         Title = 'App dependencies (pnpm install)';      Level = 'FAIL' },
  @{ Id = 'app';             Title = 'ZAICODE app build';                    Level = 'FAIL' },
  @{ Id = 'staged-build';    Title = 'Staged build swap';                    Level = 'WARN' },
  @{ Id = 'launcher';        Title = 'Root launcher ZAICODE.exe';            Level = 'FAIL' },
  @{ Id = 'shortcut';        Title = 'Shortcuts';                            Level = 'FAIL' },
  @{ Id = 'accounts';        Title = 'Claude / Codex logins';                Level = 'INFO' }
)

$script:ZaicodeWorkspaceExclude = @('/.saipen/', '/stats/', '/_mycustompics/')

function New-ZaicodeContext($Layout, $Options) {
  return [pscustomobject]@{ Layout = $Layout; Options = $Options; Git = $null; Node = $null; Python = $null }
}

function Resolve-ZaicodeGit($Ctx) {
  if (-not $Ctx.Git) { $Ctx.Git = Find-ZaicodeGit $Ctx.Layout }
  if (-not $Ctx.Git) { throw 'Git is not available (run the git repair first)' }
  return $Ctx.Git
}

function Resolve-ZaicodeNode($Ctx) {
  if (-not $Ctx.Node) { $Ctx.Node = Find-ZaicodeNode $Ctx.Layout }
  if (-not $Ctx.Node) { throw 'Node.js 24 is not available (run the node repair first)' }
  return $Ctx.Node
}

function Resolve-ZaicodePython($Ctx) {
  if (-not $Ctx.Python) { $Ctx.Python = Find-ZaicodePython $Ctx.Layout }
  if (-not $Ctx.Python) { throw 'Python 3.11+ is not available (run the python repair first)' }
  return $Ctx.Python
}

function Test-ZaicodeFileLocked([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  try {
    $stream = [IO.File]::Open($Path, 'Open', 'ReadWrite', 'None')
    $stream.Close()
    return $false
  } catch { return $true }
}

# Deletes a build folder whose deepest files pass MAX_PATH (the bundled router's Next output).
function Remove-ZaicodeLongPathDir([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Invoke-ZaicodeCommand -File $env:ComSpec -Arguments @('/d', '/c', 'rd', '/s', '/q', "\\?\$Path") -AllowFailure | Out-Null
  if (Test-Path -LiteralPath $Path) { Move-Item -LiteralPath $Path -Destination ("$Path.stale-" + (Get-Date -Format 'yyyyMMddHHmmss')) }
}

function Get-ZaicodeShortcutList($Ctx) {
  return (Get-ZaicodeShortcutPaths $Ctx.Options.ShortcutDir -StartMenu:(-not $Ctx.Options.NoStartMenu))
}

# Returns $null when the check passes, else one sentence saying what is wrong.
function Test-ZaicodeCheck([string]$Id, $Ctx) {
  $layout = $Ctx.Layout
  $options = $Ctx.Options
  switch ($Id) {
    'git' {
      if ($options.PortableTools -and -not (Test-Path (Join-Path $layout.GitDir 'cmd\git.exe'))) { return 'portable Git requested' }
      if (-not (Find-ZaicodeGit $layout)) { return 'Git is not installed' }
    }
    'node' {
      if ($options.PortableTools -and -not (Test-Path (Join-Path $layout.NodeDir 'node.exe'))) { return 'portable Node.js requested' }
      if (-not (Find-ZaicodeNode $layout)) { return 'Node.js 24 or newer is not installed' }
    }
    'python' {
      if ($options.PortableTools -and -not (Test-Path (Join-Path $layout.PythonDir 'tools\python.exe'))) { return 'portable Python requested' }
      if (-not (Find-ZaicodePython $layout)) { return 'Python 3.11 or newer is not installed' }
    }
    'pnpm' {
      if (-not (Test-Path -LiteralPath (Get-ZaicodePnpm $layout))) { return 'the pinned pnpm is not in .tools' }
    }
    'workspace' {
      if (-not (Test-ZaicodeRepo (Resolve-ZaicodeGit $Ctx) $layout.Root)) { return 'not a clone of the ZAICODE workspace' }
      if (-not (Test-Path -LiteralPath $layout.LauncherSrc)) { return 'tools\launcher is missing' }
    }
    'app-source' {
      if (-not (Test-ZaicodeRepo (Resolve-ZaicodeGit $Ctx) $layout.Zcode)) { return 'zcode\ is not a clone of the ZAICODE app' }
    }
    'saipen' {
      if (-not (Test-ZaicodeRepo (Resolve-ZaicodeGit $Ctx) $layout.Saipen)) { return 'saipen\ is not a clone of SAIPEN' }
    }
    'saipen-launcher' {
      return (Test-ZaicodeSaipenLauncher $layout)
    }
    'saimail' {
      if (-not (Test-ZaicodeRepo (Resolve-ZaicodeGit $Ctx) $layout.Saimail)) { return 'saimail\ is not a clone of SAIMAIL' }
      if (-not (Test-Path -LiteralPath $layout.VenvPython)) { return 'the .venv is missing' }
      $probe = Invoke-ZaicodeCommand -File $layout.VenvPython -Arguments @('-c', 'import saimail') -AllowFailure
      if ($probe.Code -ne 0) { return 'SAIMAIL is not installed in .venv' }
    }
    'saimail-cli' {
      if (-not (Test-ZaicodeSaimailShipsCli $layout)) {
        return ("the published SAIMAIL ({0}) has no saimail-local yet; ZAICODE's SAIMAIL panels stay off until a release ships it" -f (Get-ZaicodeSaimailVersion $layout))
      }
      if (-not (Test-Path -LiteralPath $layout.SaimailExe)) { return 'saimail-local is not installed in .venv' }
      $probe = Invoke-ZaicodeCommand -File $layout.SaimailExe -Arguments @('--help') -AllowFailure
      if ($probe.Code -ne 0) { return 'saimail-local does not start' }
    }
    'router' {
      if (-not (Test-Path -LiteralPath (Join-Path $layout.RouterDir 'node_modules\9router\app'))) { return 'not in .tools (the app works; SAIFREN then needs an existing 9router)' }
    }
    'modules' {
      if (-not (Test-Path -LiteralPath (Join-Path $layout.Zcode 'node_modules\.modules.yaml'))) { return 'node_modules is missing' }
      $marker = Get-ZaicodeLockMarker $layout
      if (-not (Test-Path -LiteralPath $marker)) { return 'no record of which pnpm-lock.yaml node_modules came from' }
      if ((Get-Content -LiteralPath $marker -Raw).Trim() -ne (Get-ZaicodeLockHash $layout)) { return 'pnpm-lock.yaml changed since the last install' }
    }
    'app' {
      if (-not (Test-Path -LiteralPath $layout.AppExe) -and -not (Test-Path -LiteralPath $layout.StagedExe)) { return 'no built ZAICODE.exe' }
    }
    'staged-build' {
      $previous = Join-Path $layout.Zcode 'packages\desktop\dist\win-unpacked.previous'
      if (Test-Path -LiteralPath $previous) { return 'win-unpacked.previous is left over (a long-path swap failed once)' }
      if ((Test-Path -LiteralPath $layout.StagedExe) -and (Test-Path -LiteralPath $layout.AppExe) -and
          (Get-Item -LiteralPath $layout.StagedExe).LastWriteTimeUtc -gt (Get-Item -LiteralPath $layout.AppExe).LastWriteTimeUtc -and
          -not (Test-ZaicodeFileLocked $layout.AppExe)) { return 'a newer staged build waits and ZAICODE is closed' }
    }
    'launcher' {
      if (-not (Test-Path -LiteralPath $layout.Launcher)) { return 'ZAICODE.exe (the launcher) is missing' }
    }
    'shortcut' {
      if ($options.NoShortcut) { return $null }
      $problems = @()
      foreach ($path in (Get-ZaicodeShortcutList $Ctx)) {
        $problem = Test-ZaicodeShortcut $path $layout.Launcher
        if ($problem) { $problems += "$(Split-Path $path -Leaf) in $(Split-Path $path): $problem" }
      }
      if ($problems.Count -gt 0) { return ($problems -join '; ') }
    }
    'accounts' {
      $accounts = @(Get-ZaicodeAccounts)
      if ($accounts.Count -eq 0) { return 'no Claude Code or Codex login yet (optional: ZAICODE works with its free pool)' }
      $waiting = @($accounts | Where-Object { -not $_.SignedIn })
      if ($waiting.Count -gt 0) { return ('not signed in: ' + (($waiting | ForEach-Object { Get-ZaicodeLoginCommand $_.Vendor $_.Home }) -join ' | ')) }
    }
  }
  return $null
}

# Fixes what Test-ZaicodeCheck reported. INFO checks have no repair (a login needs the person).
function Repair-ZaicodeCheck([string]$Id, $Ctx) {
  $layout = $Ctx.Layout
  $options = $Ctx.Options
  switch ($Id) {
    'git' { $Ctx.Git = Install-ZaicodeGit $layout }
    'node' { $Ctx.Node = Install-ZaicodeNode $layout }
    'python' { $Ctx.Python = Install-ZaicodePython $layout }
    'pnpm' { Install-ZaicodePnpm $layout (Resolve-ZaicodeNode $Ctx) | Out-Null }
    'workspace' {
      Sync-ZaicodeRepo -Git (Resolve-ZaicodeGit $Ctx) -Url $options.ZaicodeRepo -Branch $script:ZaicodeDefaults.RootBranch -Dir $layout.Root -Exclude $script:ZaicodeWorkspaceExclude `
        -Owned @('install', '.tools', '.venv', 'zcode', 'saipen', 'saimail')
    }
    'app-source' {
      Sync-ZaicodeRepo -Git (Resolve-ZaicodeGit $Ctx) -Url $options.ZaicodeRepo -Branch $script:ZaicodeDefaults.AppBranch -Dir $layout.Zcode
    }
    'saipen' { Sync-ZaicodeRepo -Git (Resolve-ZaicodeGit $Ctx) -Url $options.SaipenRepo -Branch 'main' -Dir $layout.Saipen }
    'saipen-launcher' { Set-ZaicodeSaipenLauncher $layout (Resolve-ZaicodePython $Ctx) }
    'saimail' {
      Sync-ZaicodeRepo -Git (Resolve-ZaicodeGit $Ctx) -Url $options.SaimailRepo -Branch 'main' -Dir $layout.Saimail
      Install-ZaicodeSaimail $layout (Resolve-ZaicodePython $Ctx)
    }
    'saimail-cli' {
      Sync-ZaicodeRepo -Git (Resolve-ZaicodeGit $Ctx) -Url $options.SaimailRepo -Branch 'main' -Dir $layout.Saimail
      if (-not (Test-ZaicodeSaimailShipsCli $layout)) { throw 'the published SAIMAIL has no saimail-local to install' }
      Install-ZaicodeSaimail $layout (Resolve-ZaicodePython $Ctx)
    }
    'router' { if (-not (Install-ZaicodeRouterPackage $layout (Resolve-ZaicodeNode $Ctx))) { throw 'npm could not install 9router' } }
    'modules' { Install-ZaicodeModules $layout (Resolve-ZaicodeNode $Ctx) }
    'app' { Build-ZaicodeApp $layout (Resolve-ZaicodeNode $Ctx) }
    'staged-build' {
      $dist = Join-Path $layout.Zcode 'packages\desktop\dist\win-unpacked'
      Remove-ZaicodeLongPathDir "$dist.previous"
      if ((Test-Path -LiteralPath $layout.StagedExe) -and -not (Test-ZaicodeFileLocked $layout.AppExe)) {
        if (Test-Path -LiteralPath $dist) { Move-Item -LiteralPath $dist -Destination "$dist.previous" }
        Move-Item -LiteralPath (Split-Path $layout.StagedExe) -Destination $dist
        Remove-ZaicodeLongPathDir "$dist.previous"
      }
    }
    'launcher' { Build-ZaicodeLauncher $layout }
    'shortcut' {
      foreach ($path in (Get-ZaicodeShortcutList $Ctx)) {
        New-ZaicodeShortcut -Path $path -Target $layout.Launcher -WorkingDirectory $layout.Root -Icon $layout.AppExe -Description 'ZAICODE: ZAICODE + SAIPEN + SAIMAIL'
      }
    }
    default { throw "no automatic repair for $Id" }
  }
}

# Runs the checks in order; with -Repair a failing check is repaired and tested again.
function Invoke-ZaicodeChecks($Layout, $Options, [switch]$Repair, [string[]]$Only = @()) {
  $ctx = New-ZaicodeContext $Layout $Options
  $results = @()
  foreach ($check in $script:ZaicodeCheckList) {
    if ($Only.Count -gt 0 -and $Only -notcontains $check.Id) { continue }
    $started = Get-Date
    $problem = $null
    $repaired = $false
    $failure = $null
    try { $problem = Test-ZaicodeCheck $check.Id $ctx } catch { $problem = "test failed: $($_.Exception.Message)" }
    if ($problem -and $Repair -and $check.Level -ne 'INFO') {
      Write-ZaicodeLog ("repair {0}: {1}" -f $check.Title, $problem) 'Cyan'
      try {
        Repair-ZaicodeCheck $check.Id $ctx
        $after = $null
        try { $after = Test-ZaicodeCheck $check.Id $ctx } catch { $after = "test failed: $($_.Exception.Message)" }
        if ($after) { $failure = "still: $after" } else { $repaired = $true }
      } catch { $failure = $_.Exception.Message }
    }
    $status = 'OK'
    if ($problem -and -not $repaired) { $status = $check.Level }
    if ($repaired) { $status = 'FIXED' }
    $detail = ''
    if ($failure) { $detail = $failure } elseif ($problem -and -not $repaired) { $detail = $problem }
    $color = switch ($status) { 'OK' { 'Green' } 'FIXED' { 'Cyan' } 'INFO' { 'Gray' } 'WARN' { 'Yellow' } default { 'Red' } }
    Write-ZaicodeLog ('{0,-6} {1,-38} {2}' -f $status, $check.Title, $detail) $color
    $results += [pscustomobject]@{
      Id = $check.Id; Title = $check.Title; Status = $status; Problem = $problem; Error = $failure
      Seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    }
  }
  return $results
}
