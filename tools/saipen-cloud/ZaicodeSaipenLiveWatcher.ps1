<#
.SYNOPSIS
    One-way-safe, preservation-first sync watcher for the ZAICODE SAIPEN
    transport branch.

.DESCRIPTION
    Runs in a loop (or exactly once with -Once) and moves the local checkout
    and origin/<Branch> closer together using only the two safe operations:

        remote ahead  -> git merge --ff-only
        local  ahead  -> git push  (never force)

    Everything else pauses the watcher and is written to the log. The watcher
    never commits, never stashes, never resets, never force-pushes, never
    switches branches and never touches a working tree that is not clean.

    Case table (each maps to a state string that is logged on change only):

        A  clean, local is ancestor of remote   -> FF_PULL
        B  clean, remote is ancestor of local   -> PUSH
        C  dirty                                -> DIRTY (no fetch, no merge, no push)
        D  current branch is not <Branch>       -> WAIT_BRANCH
        E  diverged                             -> DIVERGED (both heads logged, no action)
        F  fetch/network failed                 -> DEGRADED (retry on the next tick)
        G  a git operation is already in flight -> BUSY (merge/rebase/cherry-pick present)

    Single instance: an exclusive lock file is held for the whole run, so a
    second copy exits 0 immediately instead of racing the first.

.PARAMETER Repo
    Path to the ZAICODE checkout. Mandatory, and deliberately not defaulted:
    the machine-local copy under %APPDATA%\SAIPEN sits two levels below the
    user's profile, so "two levels above this script" would resolve to
    C:\Users\<name>\AppData and fail. The installer and the Startup entry
    always pass it, and the script never depends on the caller's directory.

.PARAMETER Remote
    Git remote name. Default: origin

.PARAMETER Branch
    Transport branch. Default: saipen-live

.PARAMETER IntervalSeconds
    Seconds between passes. Default: 30. The watcher only fetches on a clean
    tree on the transport branch, so an idle checkout costs no network.

.PARAMETER LogFile
    Log path. Required when the script is started by hand; the installer
    passes it.

.PARAMETER LockFile
    Single-instance lock path. Required when the script is started by hand.

.PARAMETER PidFile
    File the watcher writes its own PID to, so the installer can stop exactly
    this process and nothing else.

.PARAMETER MaxLogBytes
    Rotate the log to <LogFile>.1 past this size. Default: 2 MB.

.PARAMETER Once
    Run a single pass and exit 0. Used by the acceptance test.

.EXAMPLE
    powershell.exe -File ZaicodeSaipenLiveWatcher.ps1 `
        -LogFile "$env:APPDATA\SAIPEN\ZAICODE_cloud-sync.log" `
        -LockFile "$env:APPDATA\SAIPEN\ZAICODE_cloud-sync.lock" `
        -PidFile  "$env:APPDATA\SAIPEN\ZAICODE_cloud-sync.pid"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Repo,
    [string]$Remote = 'origin',
    [string]$Branch = 'saipen-live',
    [int]$IntervalSeconds = 30,
    [string]$LogFile = '',
    [string]$LockFile = '',
    [string]$PidFile = '',
    [int]$MaxLogBytes = 2MB,
    [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrEmpty($LogFile)) {
    $LogFile = Join-Path $env:APPDATA 'SAIPEN\ZAICODE_cloud-sync.log'
}
if ([string]::IsNullOrEmpty($LockFile)) {
    $LockFile = Join-Path $env:APPDATA 'SAIPEN\ZAICODE_cloud-sync.lock'
}
if ([string]::IsNullOrEmpty($PidFile)) {
    $PidFile = Join-Path $env:APPDATA 'SAIPEN\ZAICODE_cloud-sync.pid'
}

$script:LastState = ''

function Write-SyncLog {
    param([string]$Message)

    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $line = "[$stamp] $Message"

    try {
        $logDir = Split-Path -Parent $LogFile
        if ($logDir -and -not (Test-Path -LiteralPath $logDir -PathType Container)) {
            New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        }
        if ((Test-Path -LiteralPath $LogFile) -and
            ((Get-Item -LiteralPath $LogFile).Length -ge $MaxLogBytes)) {
            Move-Item -LiteralPath $LogFile -Destination "$LogFile.1" -Force
        }
        Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
    }
    catch {
        # A watcher that cannot log must still keep protecting the repository.
    }
}

function Write-StateChange {
    param([string]$State, [string]$Message)

    if ($State -eq $script:LastState) {
        return
    }
    $script:LastState = $State
    Write-SyncLog $Message
}

# 5.1 turns native stderr into a terminating NativeCommandError when
# $ErrorActionPreference is Stop, so the preference is lowered around every
# git call and the verdict is $LASTEXITCODE. See .saipen/KNOWLEDGE/traps.md
# "Windows PowerShell 5.1 turns native stderr into errors".
function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
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

    return [pscustomobject]@{
        ExitCode = $code
        Output   = $text.Trim()
    }
}

function Get-GitHead {
    param([string]$Revision)

    $result = Invoke-Git -Arguments @('rev-parse', '--verify', '--quiet', $Revision)
    if ($result.ExitCode -ne 0 -or [string]::IsNullOrEmpty($result.Output)) {
        return $null
    }
    return $result.Output
}

function Test-GitAncestor {
    param(
        [Parameter(Mandatory = $true)][string]$Ancestor,
        [Parameter(Mandatory = $true)][string]$Descendant
    )

    $result = Invoke-Git -Arguments @('merge-base', '--is-ancestor', $Ancestor, $Descendant)
    return ($result.ExitCode -eq 0)
}

function Test-GitOperationInFlight {
    $gitDir = (Invoke-Git -Arguments @('rev-parse', '--absolute-git-dir'))
    if ($gitDir.ExitCode -ne 0 -or [string]::IsNullOrEmpty($gitDir.Output)) {
        return $false
    }
    $dir = $gitDir.Output.Trim()
    foreach ($marker in @('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG')) {
        if (Test-Path -LiteralPath (Join-Path $dir $marker) -PathType Leaf) {
            return $true
        }
    }
    foreach ($marker in @('rebase-merge', 'rebase-apply')) {
        if (Test-Path -LiteralPath (Join-Path $dir $marker) -PathType Container) {
            return $true
        }
    }
    return $false
}

# Returns a record, never a bare array. PowerShell unrolls an array on
# `return`, so an empty one arrives as $null and a one-element one arrives as
# a bare string; both then break the caller's .Count under StrictMode. An empty
# tree used to read as "git status failed" for exactly that reason.
function Get-DirtyPaths {
    $status = Invoke-Git -Arguments @('status', '--porcelain=v1', '--untracked-files=all')
    if ($status.ExitCode -ne 0) {
        Write-SyncLog "git status failed: exit $($status.ExitCode); output=[$($status.Output)]"
        return [pscustomobject]@{ Ok = $false; Paths = @() }
    }
    $paths = @()
    if (-not [string]::IsNullOrEmpty($status.Output)) {
        $paths = @($status.Output -split "`r?`n" | Where-Object { $_.Trim() })
    }
    return [pscustomobject]@{ Ok = $true; Paths = $paths }
}

function Invoke-SyncPass {
    # Case D first: on any other branch the watcher does nothing at all.
    $branchResult = Invoke-Git -Arguments @('branch', '--show-current')
    if ($branchResult.ExitCode -ne 0) {
        Write-StateChange 'NO_BRANCH' 'Paused: unable to read the current branch.'
        return
    }
    $currentBranch = $branchResult.Output.Trim()
    if ($currentBranch -ne $Branch) {
        Write-StateChange "WAIT_BRANCH:$currentBranch" `
            "Paused: current branch is '$currentBranch', expected '$Branch'. No fetch, no merge, no push."
        return
    }

    # Case C: a dirty tree is uncheckpointed work. Touching nothing is the
    # correct answer, and not even a fetch is worth the network round-trip.
    $tree = Get-DirtyPaths
    if (-not $tree.Ok) {
        Write-StateChange 'STATUS_FAILED' 'Paused: git status failed.'
        return
    }
    if ($tree.Paths.Count -gt 0) {
        Write-StateChange "DIRTY:$($tree.Paths.Count)" `
            "Paused: working tree has $($tree.Paths.Count) uncommitted path(s). No fetch, no merge, no push."
        return
    }

    if (Test-GitOperationInFlight) {
        Write-StateChange 'BUSY' 'Paused: a git merge/rebase/cherry-pick is in flight.'
        return
    }

    # Case F: network or GitHub unavailable.
    $fetch = Invoke-Git -Arguments @('fetch', $Remote, $Branch, '--quiet')
    if ($fetch.ExitCode -ne 0) {
        Write-StateChange 'DEGRADED' `
            "Degraded: fetch $Remote/$Branch failed (exit $($fetch.ExitCode)). Local work untouched, retrying."
        return
    }

    $remoteRef = "refs/remotes/$Remote/$Branch"
    $exists = Invoke-Git -Arguments @('show-ref', '--verify', '--quiet', $remoteRef)
    if ($exists.ExitCode -ne 0) {
        Write-StateChange 'REMOTE_REF_MISSING' `
            "Paused: $Remote/$Branch does not exist on the remote. The watcher never creates a remote branch; run tools\saipen-cloud\Install-SaipenLiveSync.ps1."
        return
    }

    $localHead = Get-GitHead 'HEAD'
    $remoteHead = Get-GitHead "$Remote/$Branch"
    if (-not $localHead -or -not $remoteHead) {
        Write-StateChange 'HEAD_UNRESOLVED' 'Paused: unable to resolve local or remote HEAD.'
        return
    }

    if ($localHead -eq $remoteHead) {
        Write-StateChange "SYNCED:$localHead" "Synchronized at $localHead."
        return
    }

    # Case A.
    if (Test-GitAncestor -Ancestor $localHead -Descendant $remoteHead) {
        $merge = Invoke-Git -Arguments @('merge', '--ff-only', "$Remote/$Branch")
        if ($merge.ExitCode -eq 0) {
            $newHead = Get-GitHead 'HEAD'
            Write-StateChange "SYNCED:$newHead" "Case A: fast-forwarded local $localHead -> $newHead from $Remote/$Branch."
        }
        else {
            Write-StateChange 'FF_FAILED' `
                "Fast-forward from $Remote/$Branch failed (exit $($merge.ExitCode)). Nothing was rewritten: $($merge.Output)"
        }
        return
    }

    # Case B.
    if (Test-GitAncestor -Ancestor $remoteHead -Descendant $localHead) {
        $push = Invoke-Git -Arguments @('push', $Remote, "HEAD:refs/heads/$Branch")
        if ($push.ExitCode -eq 0) {
            Write-StateChange "SYNCED:$localHead" "Case B: pushed local $localHead to $Remote/$Branch."
        }
        else {
            Write-StateChange 'PUSH_REJECTED' `
                "Push of $localHead to $Remote/$Branch was rejected (exit $($push.ExitCode)), so the remote advanced concurrently. No force push was attempted."
        }
        return
    }

    # Case E: preservation wins. Both heads are recorded verbatim.
    Write-StateChange "DIVERGED:${localHead}:${remoteHead}" `
        "DIVERGED: local HEAD $localHead and $Remote/$Branch $remoteHead share no ancestor. Both histories are preserved. No merge, no rebase, no force push. Reconcile by hand."
}

# --- single instance -------------------------------------------------------

$lockStream = $null
try {
    $lockStream = [System.IO.File]::Open(
        $LockFile,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
}
catch {
    # Another watcher owns the lock. Nothing to do, and that is not an error.
    exit 0
}

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-SyncLog 'Fatal: git is not on PATH.'
        exit 1
    }
    if (-not (Test-Path -LiteralPath $Repo -PathType Container)) {
        Write-SyncLog "Fatal: repository path does not exist: $Repo"
        exit 1
    }
    $rootResult = Invoke-Git -Arguments @('rev-parse', '--show-toplevel')
    if ($rootResult.ExitCode -ne 0 -or [string]::IsNullOrEmpty($rootResult.Output)) {
        Write-SyncLog "Fatal: $Repo is not inside a Git work tree."
        exit 1
    }

    try {
        Set-Content -LiteralPath $PidFile -Value $PID -Encoding ASCII -ErrorAction SilentlyContinue
    }
    catch {
    }

    Write-SyncLog "Watcher up: repo $Repo, branch $Branch, remote $Remote, interval ${IntervalSeconds}s, pid $PID, once $Once."

    if ($Once) {
        Invoke-SyncPass
        exit 0
    }

    while ($true) {
        try {
            Invoke-SyncPass
        }
        catch {
            Write-StateChange "ERROR:$($_.Exception.Message)" "Watcher error: $($_.Exception.Message)"
        }
        Start-Sleep -Seconds $IntervalSeconds
    }
}
finally {
    if ($null -ne $lockStream) {
        $lockStream.Dispose()
    }
    try {
        if ((Test-Path -LiteralPath $PidFile) -and
            ((Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue) -eq "$PID")) {
            Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        }
    }
    catch {
    }
}
