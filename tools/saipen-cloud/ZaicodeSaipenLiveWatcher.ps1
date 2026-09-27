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

    Product pass (T-90). zcode/ is a separate repository, gitignored here, so
    the pass above never moves product code. After it, the same tick brings
    the product checkout (-ProductRepo, branch -ProductBranch) up to its
    remote, and ONLY by fast-forward:

        P-A  remote ahead, incoming files touch no dirty path -> PRODUCT_SYNCED
             (git merge --ff-only; uncommitted product work is left as it is)
        P-H  remote ahead, an incoming file is dirty here      -> PRODUCT_HELD
        P-L  local ahead                                       -> PRODUCT_LOCAL_AHEAD
             (never pushed: product is published by SAIPEN SHIP, not a watcher)
        P-E  diverged                                          -> PRODUCT_DIVERGED
        P-B  other branch / git op in flight / no repo / fetch failed -> paused

    git itself refuses a fast-forward that would overwrite a local change, so
    the overlap check is a second, earlier guard, not the only one.

    Self-update (T-90). This script runs as a copy under %APPDATA%\SAIPEN, so
    a newer watcher in the repository would otherwise never run. On each pass
    in loop mode, when the repository's committed copy differs from the
    running one, parses cleanly and is not being edited, the watcher copies it
    over itself, releases the lock and restarts once with the same arguments.

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
    Run a single pass and exit 0. Used by the acceptance test. Never
    self-updates.

.PARAMETER ProductRepo
    The nested product checkout. Default: <Repo>\zcode. A missing folder is
    not an error: the product pass is skipped and says so once.

.PARAMETER ProductBranch
    Product branch. Default: zaicode

.PARAMETER NoProduct
    Skip the product pass entirely.

.PARAMETER NoSelfUpdate
    Never replace the running copy with the repository's copy.

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
    [switch]$Once,
    [string]$ProductRepo = '',
    [string]$ProductBranch = 'zaicode',
    [switch]$NoProduct,
    [switch]$NoSelfUpdate
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

if ([string]::IsNullOrEmpty($ProductRepo)) {
    $ProductRepo = Join-Path $Repo 'zcode'
}

$script:LastState = ''
$script:LastProductState = ''
$script:LastSelfUpdateState = ''
$script:Relaunch = $false

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
        [string[]]$Arguments,
        [string]$Path = $Repo,
        # Machine-read output (-z, porcelain) must not be trimmed: the first
        # porcelain entry starts with a space (" M file"), and trimming it
        # shifts the path by one character.
        [switch]$Raw
    )

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $global:LASTEXITCODE = 0
        $output = & git -C $Path @Arguments 2>&1
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }

    $text = ''
    if ($null -ne $output) {
        $text = (@($output) | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    }

    if (-not $Raw) {
        $text = $text.Trim()
    }
    return [pscustomobject]@{
        ExitCode = $code
        Output   = $text
    }
}

function Get-GitHead {
    param([string]$Revision, [string]$Path = $Repo)

    $result = Invoke-Git -Path $Path -Arguments @('rev-parse', '--verify', '--quiet', $Revision)
    if ($result.ExitCode -ne 0 -or [string]::IsNullOrEmpty($result.Output)) {
        return $null
    }
    return $result.Output
}

function Test-GitAncestor {
    param(
        [Parameter(Mandatory = $true)][string]$Ancestor,
        [Parameter(Mandatory = $true)][string]$Descendant,
        [string]$Path = $Repo
    )

    $result = Invoke-Git -Path $Path -Arguments @('merge-base', '--is-ancestor', $Ancestor, $Descendant)
    return ($result.ExitCode -eq 0)
}

function Test-GitOperationInFlight {
    param([string]$Path = $Repo)

    $gitDir = (Invoke-Git -Path $Path -Arguments @('rev-parse', '--absolute-git-dir'))
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

# --- product pass (T-90) ---------------------------------------------------

function Write-ProductStateChange {
    param([string]$State, [string]$Message)

    if ($State -eq $script:LastProductState) {
        return
    }
    $script:LastProductState = $State
    Write-SyncLog "Product: $Message"
}

# NUL-separated git output (-z) split into paths. Robust against quoting,
# spaces and non-ASCII names, which the line form escapes.
function Split-NulPaths {
    param([string]$Text)

    if ([string]::IsNullOrEmpty($Text)) {
        return [pscustomobject]@{ Paths = @() }
    }
    return [pscustomobject]@{ Paths = @($Text -split "`0" | Where-Object { $_ -ne '' }) }
}

# Every path git status -z reports as changed or untracked, including both
# sides of a rename. Returns a record (never a bare array; see Get-DirtyPaths).
function Get-ProductDirtyPaths {
    $status = Invoke-Git -Raw -Path $ProductRepo -Arguments @('status', '--porcelain=v1', '-z', '--untracked-files=all')
    if ($status.ExitCode -ne 0) {
        return [pscustomobject]@{ Ok = $false; Paths = @() }
    }
    $entries = (Split-NulPaths -Text $status.Output).Paths
    $paths = @()
    $index = 0
    while ($index -lt $entries.Count) {
        $entry = $entries[$index]
        if ($entry.Length -gt 3) {
            $paths += $entry.Substring(3)
            $code = $entry.Substring(0, 2)
            if ($code.Contains('R') -or $code.Contains('C')) {
                $index += 1
                if ($index -lt $entries.Count) {
                    $paths += $entries[$index]
                }
            }
        }
        $index += 1
    }
    return [pscustomobject]@{ Ok = $true; Paths = $paths }
}

function Invoke-ProductSyncPass {
    if ($NoProduct) {
        return
    }
    if (-not (Test-Path -LiteralPath (Join-Path $ProductRepo '.git'))) {
        Write-ProductStateChange 'PRODUCT_ABSENT' "no product checkout at $ProductRepo; product pass skipped."
        return
    }

    $branchResult = Invoke-Git -Path $ProductRepo -Arguments @('branch', '--show-current')
    if ($branchResult.ExitCode -ne 0) {
        Write-ProductStateChange 'PRODUCT_NO_BRANCH' 'paused: unable to read the product branch.'
        return
    }
    $currentBranch = $branchResult.Output.Trim()
    if ($currentBranch -ne $ProductBranch) {
        Write-ProductStateChange "PRODUCT_WAIT_BRANCH:$currentBranch" `
            "paused: product branch is '$currentBranch', expected '$ProductBranch'. Nothing fetched or merged."
        return
    }

    if (Test-GitOperationInFlight -Path $ProductRepo) {
        Write-ProductStateChange 'PRODUCT_BUSY' 'paused: a git merge/rebase/cherry-pick is in flight in the product checkout.'
        return
    }

    $fetch = Invoke-Git -Path $ProductRepo -Arguments @('fetch', $Remote, $ProductBranch, '--quiet')
    if ($fetch.ExitCode -ne 0) {
        Write-ProductStateChange 'PRODUCT_DEGRADED' `
            "degraded: fetch $Remote/$ProductBranch failed (exit $($fetch.ExitCode)). Product untouched, retrying."
        return
    }

    $localHead = Get-GitHead -Path $ProductRepo -Revision 'HEAD'
    $remoteHead = Get-GitHead -Path $ProductRepo -Revision "$Remote/$ProductBranch"
    if (-not $localHead -or -not $remoteHead) {
        Write-ProductStateChange 'PRODUCT_HEAD_UNRESOLVED' 'paused: unable to resolve the local or remote product HEAD.'
        return
    }
    if ($localHead -eq $remoteHead) {
        Write-ProductStateChange "PRODUCT_SYNCED:$localHead" "synchronized at $localHead."
        return
    }

    if (Test-GitAncestor -Path $ProductRepo -Ancestor $localHead -Descendant $remoteHead) {
        $tree = Get-ProductDirtyPaths
        if (-not $tree.Ok) {
            Write-ProductStateChange 'PRODUCT_STATUS_FAILED' 'paused: git status failed in the product checkout.'
            return
        }
        $incoming = Invoke-Git -Raw -Path $ProductRepo -Arguments @('diff', '--name-only', '-z', $localHead, $remoteHead)
        if ($incoming.ExitCode -ne 0) {
            Write-ProductStateChange 'PRODUCT_DIFF_FAILED' 'paused: unable to list the incoming product files.'
            return
        }
        $dirty = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($path in $tree.Paths) {
            [void]$dirty.Add($path)
        }
        $overlap = @((Split-NulPaths -Text $incoming.Output).Paths | Where-Object { $dirty.Contains($_) })
        if ($overlap.Count -gt 0) {
            $shown = ($overlap | Select-Object -First 5) -join ', '
            Write-ProductStateChange "PRODUCT_HELD:${localHead}:${remoteHead}" `
                "HELD: $Remote/$ProductBranch $remoteHead changes $($overlap.Count) file(s) that are uncommitted here ($shown). Nothing merged; commit or finish that work, then the next pass fast-forwards."
            return
        }
        $merge = Invoke-Git -Path $ProductRepo -Arguments @('merge', '--ff-only', "$Remote/$ProductBranch")
        if ($merge.ExitCode -eq 0) {
            $newHead = Get-GitHead -Path $ProductRepo -Revision 'HEAD'
            Write-ProductStateChange "PRODUCT_SYNCED:$newHead" `
                "fast-forwarded $localHead -> $newHead from $Remote/$ProductBranch; $($tree.Paths.Count) uncommitted path(s) left as they were. Rebuild to test (pnpm bundle:zaicode)."
        }
        else {
            Write-ProductStateChange "PRODUCT_FF_FAILED:$remoteHead" `
                "fast-forward from $Remote/$ProductBranch failed (exit $($merge.ExitCode)); git changed nothing: $($merge.Output)"
        }
        return
    }

    if (Test-GitAncestor -Path $ProductRepo -Ancestor $remoteHead -Descendant $localHead) {
        Write-ProductStateChange "PRODUCT_LOCAL_AHEAD:$localHead" `
            "local product $localHead is ahead of $Remote/$ProductBranch. Not pushed: product is published by SAIPEN SHIP, never by the watcher."
        return
    }

    Write-ProductStateChange "PRODUCT_DIVERGED:${localHead}:${remoteHead}" `
        "DIVERGED: local $localHead and $Remote/$ProductBranch $remoteHead share no ancestor. Both preserved; nothing merged, rebased or pushed. Reconcile by hand."
}

# --- self-update (T-90) ----------------------------------------------------

function Write-SelfUpdateStateChange {
    param([string]$State, [string]$Message)

    if ($State -eq $script:LastSelfUpdateState) {
        return
    }
    $script:LastSelfUpdateState = $State
    Write-SyncLog $Message
}

# Returns $true when a newer watcher was installed over this copy and the
# caller must restart. Only a committed, parse-clean repository copy is taken.
function Test-SelfUpdateReady {
    if ($Once -or $NoSelfUpdate) {
        return $false
    }
    $running = $PSCommandPath
    # Segment by segment: a backslash inside one Join-Path argument is part of
    # the file name on non-Windows hosts, and GetFullPath would keep it.
    $source = Join-Path (Join-Path (Join-Path $Repo 'tools') 'saipen-cloud') 'ZaicodeSaipenLiveWatcher.ps1'
    if (-not $running -or -not (Test-Path -LiteralPath $source -PathType Leaf)) {
        return $false
    }
    $runningFull = [System.IO.Path]::GetFullPath($running)
    $sourceFull = [System.IO.Path]::GetFullPath($source)
    if ([string]::Equals($runningFull, $sourceFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    if ((Get-FileHash -LiteralPath $runningFull -Algorithm SHA256).Hash -eq
        (Get-FileHash -LiteralPath $sourceFull -Algorithm SHA256).Hash) {
        return $false
    }
    # Never install a copy someone is still editing.
    $edits = Invoke-Git -Arguments @('status', '--porcelain=v1', '--', 'tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1')
    if ($edits.ExitCode -ne 0 -or -not [string]::IsNullOrEmpty($edits.Output)) {
        return $false
    }
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($sourceFull, [ref]$tokens, [ref]$errors)
    if ($null -ne $errors -and @($errors).Count -gt 0) {
        Write-SelfUpdateStateChange "SELF_UPDATE_REFUSED:$(@($errors).Count)" `
            "Self-update refused: the repository watcher has $(@($errors).Count) parse error(s); this copy keeps running."
        return $false
    }
    Copy-Item -LiteralPath $sourceFull -Destination $runningFull -Force
    Write-SyncLog "Self-update: installed the repository watcher over $runningFull; restarting with the same arguments."
    return $true
}

function Test-WindowsHost {
    # $IsWindows does not exist in Windows PowerShell 5.1 and StrictMode rejects it.
    return ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)
}

function Start-WatcherAgain {
    $shell = (Get-Process -Id $PID).Path
    $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass')
    if (Test-WindowsHost) {
        $arguments += @('-WindowStyle', 'Hidden')
    }
    $arguments += @(
        '-File', ('"{0}"' -f $PSCommandPath),
        '-Repo', ('"{0}"' -f $Repo),
        '-Remote', ('"{0}"' -f $Remote),
        '-Branch', ('"{0}"' -f $Branch),
        '-IntervalSeconds', ('{0}' -f $IntervalSeconds),
        '-LogFile', ('"{0}"' -f $LogFile),
        '-LockFile', ('"{0}"' -f $LockFile),
        '-PidFile', ('"{0}"' -f $PidFile),
        '-MaxLogBytes', ('{0}' -f $MaxLogBytes),
        '-ProductRepo', ('"{0}"' -f $ProductRepo),
        '-ProductBranch', ('"{0}"' -f $ProductBranch)
    )
    if ($NoProduct) {
        $arguments += '-NoProduct'
    }
    if (Test-WindowsHost) {
        Start-Process -FilePath $shell -ArgumentList $arguments -WindowStyle Hidden
    }
    else {
        Start-Process -FilePath $shell -ArgumentList $arguments
    }
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

    Write-SyncLog "Watcher up: repo $Repo, branch $Branch, remote $Remote, interval ${IntervalSeconds}s, pid $PID, once $Once, product $ProductRepo@$ProductBranch (off: $NoProduct)."

    if ($Once) {
        Invoke-SyncPass
        Invoke-ProductSyncPass
        exit 0
    }

    while ($true) {
        try {
            Invoke-SyncPass
        }
        catch {
            Write-StateChange "ERROR:$($_.Exception.Message)" "Watcher error: $($_.Exception.Message)"
        }
        try {
            Invoke-ProductSyncPass
        }
        catch {
            Write-ProductStateChange "PRODUCT_ERROR:$($_.Exception.Message)" "error: $($_.Exception.Message)"
        }
        try {
            if (Test-SelfUpdateReady) {
                $script:Relaunch = $true
                break
            }
        }
        catch {
            Write-SelfUpdateStateChange "SELF_UPDATE_ERROR:$($_.Exception.Message)" "Self-update error (this copy keeps running): $($_.Exception.Message)"
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

# Self-update restart, after the lock and pid file are released so the new
# copy can take them. Exactly one successor, started once.
if ($script:Relaunch) {
    Start-WatcherAgain
}
