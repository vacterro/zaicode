<#
.SYNOPSIS
    Installs and repairs the local half of the ZAICODE SAIPEN cloud transport.

.DESCRIPTION
    Prepares the local checkout to exchange verified checkpoints with Claude
    Code Cloud over origin/<Branch>:

      1. validates git, the repository root and the remote;
      2. creates or reconciles the transport branch WITHOUT force push,
         hard reset, checkout -- or destructive branch switching;
      3. installs the watcher, the autostart entry and the log/lock/pid files
         under %APPDATA%\SAIPEN;
      4. starts exactly one watcher and proves it is the only one;
      5. finishes by proving local HEAD == origin/<Branch>.

    Idempotent: re-running it revalidates, rewrites the machine-local copies
    and restarts only the watcher it recorded in its own pid file. It never
    stops a process it did not start, and never touches a working tree it
    did not have to.

    A dirty tree is preserved, never cleaned. If every dirty path is canonical
    SAIPEN state under .saipen/, that is an uncheckpointed protocol state, and
    the refusal names the exact checkpoint commands instead of telling the
    operator to make a commit by hand. Any dirty path outside .saipen/ is real
    uncommitted engineering work and is listed verbatim.

.PARAMETER Repo
    Repository path. Defaults to the repository two levels above this script,
    so the installer never depends on the caller's working directory.

.PARAMETER Remote
    Git remote name. Default: origin

.PARAMETER Branch
    Transport branch. Default: saipen-live

.PARAMETER IntervalSeconds
    Watcher poll interval. Default: 30

.PARAMETER InfraRoot
    Machine-local install root. Default: %APPDATA%\SAIPEN

.PARAMETER NoStart
    Install everything but do not start the watcher now.

.PARAMETER NoAutostart
    Install everything but do not write the Windows Startup entry.

.EXAMPLE
    powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1

.EXAMPLE
    powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1 -IntervalSeconds 15
#>
[CmdletBinding()]
param(
    [string]$Repo = '',
    [string]$Remote = 'origin',
    [string]$Branch = 'saipen-live',
    [int]$IntervalSeconds = 30,
    [string]$InfraRoot = '',
    [switch]$NoStart,
    [switch]$NoAutostart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrEmpty($Repo)) {
    $Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
if ([string]::IsNullOrEmpty($InfraRoot)) {
    $InfraRoot = Join-Path $env:APPDATA 'SAIPEN'
}

$script:ExitCodes = @{
    Dirty       = 2
    Diverged    = 3
    NotVerified = 4
}

function Write-Step {
    param([string]$Text)
    Write-Host ''
    Write-Host "=== $Text ==="
}

function Write-Detail {
    param([string]$Text)
    Write-Host "  $Text"
}

# 5.1-safe native call: the preference is lowered around git and the verdict is
# $LASTEXITCODE, never a NativeCommandError from a stderr progress line.
function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$AllowFailure
    )

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $global:LASTEXITCODE = 0
        $output = & git -C $Repo @Arguments 2>&1
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }

    $text = ''
    if ($null -ne $output) {
        $text = (@($output) | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    }
    $text = $text.Trim()

    if ($code -ne 0 -and -not $AllowFailure) {
        throw "git $($Arguments -join ' ') failed with exit $code`n$text"
    }

    return [pscustomobject]@{ ExitCode = $code; Output = $text }
}

function Get-GitHead {
    param([string]$Revision)
    $result = Invoke-Git -Arguments @('rev-parse', '--verify', '--quiet', $Revision) -AllowFailure
    if ($result.ExitCode -ne 0 -or [string]::IsNullOrEmpty($result.Output)) {
        return $null
    }
    return $result.Output
}

function Test-GitAncestor {
    param([string]$Ancestor, [string]$Descendant)
    $result = Invoke-Git -Arguments @('merge-base', '--is-ancestor', $Ancestor, $Descendant) -AllowFailure
    return ($result.ExitCode -eq 0)
}

function Test-GitRef {
    param([string]$Ref)
    $result = Invoke-Git -Arguments @('show-ref', '--verify', '--quiet', $Ref) -AllowFailure
    return ($result.ExitCode -eq 0)
}

function Stop-RecordedWatcher {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    $recorded = (Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ([string]::IsNullOrWhiteSpace($recorded)) {
        return $false
    }
    $watcherPid = 0
    if (-not [int]::TryParse($recorded.Trim(), [ref]$watcherPid)) {
        return $false
    }
    $process = Get-Process -Id $watcherPid -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $false
    }
    # Only the PID this transport recorded, never a process matched by name.
    Stop-Process -Id $watcherPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 700
    return $true
}

# --- 1. preconditions ------------------------------------------------------

Write-Step 'SAIPEN CLOUD TRANSPORT'
Write-Detail "Repository:       $Repo"
Write-Detail "Remote:           $Remote"
Write-Detail "Transport branch: $Branch"
Write-Detail "Interval:         ${IntervalSeconds}s"
Write-Detail "Infra root:       $InfraRoot"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'git is not on PATH. Install Git for Windows and reopen the shell.'
}
if (-not (Test-Path -LiteralPath $Repo -PathType Container)) {
    throw "Repository path does not exist: $Repo"
}

$rootResult = Invoke-Git -Arguments @('rev-parse', '--show-toplevel')
$Repo = $rootResult.Output
Write-Detail "Repository root: $Repo"

$remoteUrl = (Invoke-Git -Arguments @('remote', 'get-url', $Remote)).Output
if ([string]::IsNullOrEmpty($remoteUrl)) {
    throw "Remote '$Remote' does not exist. Add it with: git remote add $Remote <url>"
}
Write-Detail "Remote URL:      $remoteUrl"

# --- 2. worktree gate ------------------------------------------------------

Write-Step 'WORKTREE'

$status = Invoke-Git -Arguments @('status', '--porcelain=v1', '--untracked-files=all')
$dirty = @()
if (-not [string]::IsNullOrEmpty($status.Output)) {
    $dirty = @($status.Output -split "`r?`n" | Where-Object { $_.Trim() })
}

$currentBranch = (Invoke-Git -Arguments @('branch', '--show-current')).Output
if ([string]::IsNullOrEmpty($currentBranch)) {
    throw 'HEAD is detached. Check out a real branch before running the transport installer.'
}
$head = Get-GitHead 'HEAD'

Write-Detail "Current branch:  $currentBranch"
Write-Detail "Current HEAD:    $head"

if ($dirty.Count -gt 0) {
    $foreign = @($dirty | Where-Object {
            $path = $_.Substring(3).Trim().Trim('"')
            -not $path.StartsWith('.saipen/')
        })

    Write-Host ''
    Write-Host "Working tree is dirty: $($dirty.Count) path(s). Nothing was modified, staged or removed."
    Write-Host ''

    if ($foreign.Count -eq 0) {
        $activeTicket = ''
        $stateFile = Join-Path $Repo '.saipen\STATE.md'
        if (Test-Path -LiteralPath $stateFile -PathType Leaf) {
            $match = Select-String -LiteralPath $stateFile -Pattern '^task:\s*(\S+)' | Select-Object -First 1
            if ($null -ne $match) {
                $activeTicket = $match.Matches[0].Groups[1].Value
            }
        }

        Write-Host 'Every dirty path is canonical SAIPEN state under .saipen/.'
        Write-Host 'That is uncheckpointed protocol state, not a transport fault, and this'
        Write-Host 'installer will not commit it behind the protocol''s back.'
        Write-Host ''
        Write-Host 'Settle it through SAIPEN, then re-run this installer:'
        Write-Host ''
        Write-Host '  saipen validate'
        if ($activeTicket) {
            Write-Host "  saipen checkpoint RUN $activeTicket `"<what this checkpoint proves>`""
        }
        else {
            Write-Host '  saipen checkpoint RUN <T-###> "<what this checkpoint proves>"'
        }
        Write-Host '  git add -A .saipen'
        Write-Host '  git commit -m "chore(saipen): checkpoint"'
    }
    else {
        Write-Host "Uncommitted engineering work outside .saipen/ ($($foreign.Count) path(s)):"
        Write-Host ''
        foreach ($line in $foreign) {
            Write-Host "  $line"
        }
        Write-Host ''
        Write-Host 'Commit or stash that work yourself. This installer preserves it and'
        Write-Host 'refuses to guess.'
    }

    exit $script:ExitCodes.Dirty
}

Write-Detail 'Working tree is clean.'

# --- 3. transport branch ---------------------------------------------------

Write-Step 'TRANSPORT BRANCH'

$null = Invoke-Git -Arguments @('fetch', $Remote, '--prune')

$localSyncRef = "refs/heads/$Branch"
$remoteSyncRef = "refs/remotes/$Remote/$Branch"
$localSyncExists = Test-GitRef $localSyncRef
$remoteSyncExists = Test-GitRef $remoteSyncRef
$remoteHead = if ($remoteSyncExists) { Get-GitHead "$Remote/$Branch" } else { $null }

Write-Detail "Local  $Branch exists: $localSyncExists"
Write-Detail "Remote $Branch exists: $remoteSyncExists"

if (-not $localSyncExists -and -not $remoteSyncExists) {
    Write-Detail "Creating $Branch at $head, publishing it and checking it out."
    $null = Invoke-Git -Arguments @('branch', $Branch, $head)
    $null = Invoke-Git -Arguments @('push', '--set-upstream', $Remote, "HEAD:refs/heads/$Branch")
    $null = Invoke-Git -Arguments @('switch', $Branch)
}
elseif (-not $localSyncExists) {
    if ($head -eq $remoteHead) {
        Write-Detail "Tracking the existing remote $Branch at the same commit."
        $null = Invoke-Git -Arguments @('branch', '--track', "$Remote/$Branch")
    }
    elseif (Test-GitAncestor -Ancestor $remoteHead -Descendant $head) {
        Write-Detail "Local HEAD is ahead of $Remote/$Branch; creating $Branch at HEAD."
        $null = Invoke-Git -Arguments @('branch', $Branch, $head)
        $null = Invoke-Git -Arguments @('push', '--set-upstream', $Remote, "HEAD:refs/heads/$Branch")
    }
    elseif (Test-GitAncestor -Ancestor $head -Descendant $remoteHead) {
        Write-Detail "Remote $Branch is ahead of local HEAD; creating $Branch at $remoteHead."
        $null = Invoke-Git -Arguments @('branch', "$Branch", $remoteHead)
    }
    else {
        throw "Local HEAD $head and $Remote/$Branch $remoteHead have diverged. Both histories are preserved. Reconcile by hand."
    }
}
else {
    $syncHead = Get-GitHead $Branch
    if ($currentBranch -ne $Branch) {
        if ($syncHead -eq $head) {
            Write-Detail "Switching to the existing $Branch (same commit as $currentBranch)."
            $null = Invoke-Git -Arguments @('switch', $Branch)
        }
        elseif (Test-GitAncestor -Ancestor $syncHead -Descendant $head) {
            Write-Detail "Fast-forwarding the existing $Branch $syncHead -> $head and switching to it."
            $null = Invoke-Git -Arguments @('branch', '-f', $Branch, $head)
            $null = Invoke-Git -Arguments @('switch', $Branch)
        }
        elseif (Test-GitAncestor -Ancestor $head -Descendant $syncHead) {
            Write-Detail "Switching to the existing $Branch, which is ahead at $syncHead."
            $null = Invoke-Git -Arguments @('switch', $Branch)
        }
        else {
            throw "$currentBranch ($head) and $Branch ($syncHead) have diverged. Both histories are preserved. Reconcile by hand."
        }
    }
}

# --- 4. converge local and remote -----------------------------------------

Write-Step 'CONVERGE'

$null = Invoke-Git -Arguments @('fetch', $Remote, $Branch)

if ($currentBranch -ne $Branch) {
    $currentBranch = (Invoke-Git -Arguments @('branch', '--show-current')).Output
}
if ($currentBranch -ne $Branch) {
    throw "Expected to be on $Branch but the current branch is $currentBranch."
}

$localHead = Get-GitHead 'HEAD'
if (-not (Test-GitRef $remoteSyncRef)) {
    Write-Detail "Publishing $Branch; $Remote/$Branch does not exist yet."
    $null = Invoke-Git -Arguments @('push', '--set-upstream', $Remote, "HEAD:refs/heads/$Branch")
}
else {
    $remoteHead = Get-GitHead "$Remote/$Branch"
    if ($localHead -eq $remoteHead) {
        Write-Detail "Local and remote already match at $localHead."
    }
    elseif (Test-GitAncestor -Ancestor $localHead -Descendant $remoteHead) {
        Write-Detail "Remote is ahead; fast-forwarding local to $remoteHead."
        $null = Invoke-Git -Arguments @('merge', '--ff-only', "$Remote/$Branch")
    }
    elseif (Test-GitAncestor -Ancestor $remoteHead -Descendant $localHead) {
        Write-Detail "Local is ahead; pushing $localHead."
        $null = Invoke-Git -Arguments @('push', $Remote, "HEAD:refs/heads/$Branch")
    }
    else {
        Write-Host "DIVERGED. Local $localHead, remote $remoteHead. Both are preserved."
        Write-Host 'No merge, no rebase, no force push was attempted.'
        exit $script:ExitCodes.Diverged
    }
}

# --- 5. machine-local watcher install --------------------------------------

Write-Step 'WATCHER INSTALL'

if (-not (Test-Path -LiteralPath $InfraRoot -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $InfraRoot | Out-Null
}

$watcherScript = Join-Path $InfraRoot 'ZaicodeSaipenLiveWatcher.ps1'
$logFile = Join-Path $InfraRoot 'ZAICODE_cloud-sync.log'
$lockFile = Join-Path $InfraRoot 'ZAICODE_cloud-sync.lock'
$pidFile = Join-Path $InfraRoot 'ZAICODE_cloud-sync.pid'

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'ZaicodeSaipenLiveWatcher.ps1') `
    -Destination $watcherScript -Force
Write-Detail "Watcher script:  $watcherScript"
Write-Detail "Log:             $logFile"
Write-Detail "Lock:            $lockFile"
Write-Detail "Pid:             $pidFile"

# --- 6. autostart ----------------------------------------------------------

$startupDir = [Environment]::GetFolderPath('Startup')
$startupEntry = Join-Path $startupDir 'SAIPEN-ZAICODE-Cloud-Sync.cmd'

if ($NoAutostart) {
    Write-Detail 'Autostart skipped (-NoAutostart).'
}
else {
    if (-not (Test-Path -LiteralPath $startupDir -PathType Container)) {
        throw "The Windows Startup folder could not be resolved: $startupDir"
    }
    $watcherArgs = @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', ('"{0}"' -f $watcherScript),
        '-Repo', ('"{0}"' -f $Repo),
        '-Remote', ('"{0}"' -f $Remote),
        '-Branch', ('"{0}"' -f $Branch),
        '-IntervalSeconds', ('{0}' -f $IntervalSeconds),
        '-LogFile', ('"{0}"' -f $logFile),
        '-LockFile', ('"{0}"' -f $lockFile),
        '-PidFile', ('"{0}"' -f $pidFile)
    ) -join ' '
    $entry = @(
        '@echo off',
        'rem SAIPEN ZAICODE cloud transport watcher. Regenerate with tools\saipen-cloud\Install-SaipenLiveSync.ps1.',
        ('start "" /min powershell.exe ' + $watcherArgs)
    ) -join "`r`n"
    Set-Content -LiteralPath $startupEntry -Value $entry -Encoding ASCII
    Write-Detail "Autostart entry:  $startupEntry"
}

# --- 7. start exactly one watcher -----------------------------------------

$stopped = Stop-RecordedWatcher -Path $pidFile
if ($stopped) {
    Write-Detail 'Stopped the previously recorded watcher instance.'
}

if ($NoStart) {
    Write-Detail 'Watcher start skipped (-NoStart).'
}
else {
    $arguments = @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden',
        '-File', ('"{0}"' -f $watcherScript),
        '-Repo', ('"{0}"' -f $Repo),
        '-Remote', ('"{0}"' -f $Remote),
        '-Branch', ('"{0}"' -f $Branch),
        '-IntervalSeconds', ('{0}' -f $IntervalSeconds),
        '-LogFile', ('"{0}"' -f $logFile),
        '-LockFile', ('"{0}"' -f $lockFile),
        '-PidFile', ('"{0}"' -f $pidFile)
    )
    Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden
    Start-Sleep -Seconds 2

    # Prove single instance: the recorded pid must still be alive, and a second
    # watcher launched by hand must exit 0 without taking the lock or logging.
    $runningPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($runningPid) -or
        $null -eq (Get-Process -Id ([int]$runningPid) -ErrorAction SilentlyContinue)) {
        throw "The watcher did not come up. See $logFile"
    }
    Write-Detail "Watcher running as pid $runningPid."

    $probeLog = "$logFile.probe"
    $probe = Start-Process -FilePath 'powershell.exe' -PassThru -Wait -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $watcherScript),
        '-Repo', ('"{0}"' -f $Repo),
        '-Remote', ('"{0}"' -f $Remote),
        '-Branch', ('"{0}"' -f $Branch),
        '-LogFile', ('"{0}"' -f $probeLog),
        '-LockFile', ('"{0}"' -f $lockFile),
        '-PidFile', ('"{0}.never"' -f $pidFile)
    )
    if ($probe.ExitCode -ne 0) {
        throw "A second watcher instance did not stand down (exit $($probe.ExitCode)); single instance is not proven."
    }
    Write-Detail 'Single instance proven: a second watcher exited 0 without taking the lock.'
    if (Test-Path -LiteralPath $probeLog) {
        Remove-Item -LiteralPath $probeLog -Force
    }
}

# --- 8. final verification ------------------------------------------------

Write-Step 'FINAL VERIFICATION'

$finalLocal = Get-GitHead 'HEAD'
$finalRemote = (Invoke-Git -Arguments @('ls-remote', $Remote, "refs/heads/$Branch") -AllowFailure).Output
$finalRemoteSha = $null
if (-not [string]::IsNullOrEmpty($finalRemote)) {
    $parts = $finalRemote -split '\s+'
    $finalRemoteSha = $parts[0]
}

$finalBranch = (Invoke-Git -Arguments @('branch', '--show-current')).Output
Write-Detail "Branch:          $finalBranch"
Write-Detail "Local HEAD:      $finalLocal"
Write-Detail "Remote HEAD:     $finalRemoteSha"

if ($finalBranch -ne $Branch) {
    throw "Final check failed: on $finalBranch, expected $Branch."
}
if ([string]::IsNullOrEmpty($finalRemoteSha) -or $finalLocal -ne $finalRemoteSha) {
    Write-Host ''
    Write-Host 'Local and remote are NOT identical.'
    exit $script:ExitCodes.NotVerified
}

Write-Step 'READY'
Write-Host 'Synchronization: VERIFIED'
Write-Host ''
Write-Host "Open this repository in Claude Code Cloud:"
Write-Host "  $remoteUrl"
Write-Host "Branch: $Branch"
Write-Host ''
Write-Host 'A cloud checkpoint pushed to that branch reaches this checkout'
Write-Host 'automatically on the next clean pass of the watcher.'
