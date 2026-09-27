<#
.SYNOPSIS
    Round-trip and cold-recovery acceptance test for the ZAICODE SAIPEN
    transport.

.DESCRIPTION
    Proves, end to end, the two things the transport claims:

      Round trip   a second, independent executor (a fresh clone of
                   origin/<Branch>, sharing no .git with this checkout)
                   commits and pushes a labelled empty probe commit; the
                   installed watcher must fast-forward this checkout onto it
                   without any human step, and both must end identical.

      Cold recovery the same fresh clone, at that commit, must be able to
                   answer the cold-recovery questions from repository bytes
                   alone: CLAUDE.md, the project skill, .saipen/STATE.md, the
                   top workable board ticket, and the cc / cc all rules.

    The probe commit is empty on purpose. It carries no tree change, so it is
    harmless in history while still proving that a commit authored somewhere
    else travels. Its id is printed at the end so it can be recognised later.

    Nothing here force-pushes, resets, cleans or stashes.

.PARAMETER Repo
    The live ZAICODE checkout. Defaults to the repository two levels above
    this script.

.PARAMETER Remote
    Git remote name. Default: origin

.PARAMETER Branch
    Transport branch. Default: saipen-live

.PARAMETER ProbeMessage
    Commit message for the probe. Default: a labelled transport probe.

.PARAMETER WatchTimeoutSeconds
    How long to wait for the watcher to fast-forward. Default: 180.

.PARAMETER SkipPush
    Run only the read-only preconditions and the cold-recovery check, without
    creating or pushing a probe commit.

.EXAMPLE
    powershell.exe -File tools\saipen-cloud\Test-SaipenLiveSync.ps1
#>
[CmdletBinding()]
param(
    [string]$Repo = '',
    [string]$Remote = 'origin',
    [string]$Branch = 'saipen-live',
    [string]$ProbeMessage = '',
    [int]$WatchTimeoutSeconds = 180,
    [switch]$SkipPush
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrEmpty($Repo)) {
    $Repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
if ([string]::IsNullOrEmpty($ProbeMessage)) {
    $ProbeMessage = "chore(transport): round-trip probe from an independent executor"
}

$script:Failures = New-Object System.Collections.ArrayList
$script:Checks = 0
$script:ExitCodes = @{
    Diverged = 3
}

function Write-Head {
    param([string]$Text)
    Write-Host ''
    Write-Host "=== $Text ==="
}

function Write-Detail {
    param([string]$Text)
    Write-Host "  $Text"
}

function Assert-That {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][bool]$Condition,
        [string]$Evidence = ''
    )

    $script:Checks++
    if ($Condition) {
        Write-Host "  PASS  $Name"
        if ($Evidence) {
            Write-Host "        $Evidence"
        }
    }
    else {
        Write-Host "  FAIL  $Name"
        if ($Evidence) {
            Write-Host "        $Evidence"
        }
        $null = $script:Failures.Add($Name)
    }
}

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$AllowFailure
    )

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $env:GIT_TERMINAL_PROMPT = '0'
        $global:LASTEXITCODE = 0
        $output = & git -C $WorkingDirectory @Arguments 2>&1
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

function Get-Head {
    param([string]$WorkingDirectory, [string]$Revision = 'HEAD')
    $result = Invoke-Git -WorkingDirectory $WorkingDirectory `
        -Arguments @('rev-parse', '--verify', '--quiet', $Revision) -AllowFailure
    if ($result.ExitCode -ne 0 -or [string]::IsNullOrEmpty($result.Output)) {
        return $null
    }
    return $result.Output
}

function Test-Ancestor {
    param([string]$WorkingDirectory, [string]$Ancestor, [string]$Descendant)
    $result = Invoke-Git -WorkingDirectory $WorkingDirectory `
        -Arguments @('merge-base', '--is-ancestor', $Ancestor, $Descendant) -AllowFailure
    return ($result.ExitCode -eq 0)
}

# --- preconditions ---------------------------------------------------------

Write-Head 'PRECONDITIONS'

$rootResult = Invoke-Git -WorkingDirectory $Repo -Arguments @('rev-parse', '--show-toplevel')
$Repo = $rootResult.Output
Write-Host "  repo:   $Repo"
Write-Host "  remote: $Remote"
Write-Host "  branch: $Branch"

$status = Invoke-Git -WorkingDirectory $Repo -Arguments @('status', '--porcelain=v1', '--untracked-files=all')
$dirty = @()
if (-not [string]::IsNullOrEmpty($status.Output)) {
    $dirty = @($status.Output -split "`r?`n" | Where-Object { $_.Trim() })
}
Assert-That 'local worktree is clean' ($dirty.Count -eq 0) "$($dirty.Count) dirty path(s)"

$branchName = (Invoke-Git -WorkingDirectory $Repo -Arguments @('branch', '--show-current')).Output
Assert-That "local branch is $Branch" ($branchName -eq $Branch) "actual: $branchName"

$null = Invoke-Git -WorkingDirectory $Repo -Arguments @('fetch', $Remote, $Branch)
$localHead = Get-Head -WorkingDirectory $Repo
$remoteHead = Get-Head -WorkingDirectory $Repo -Revision "$Remote/$Branch"

# Not "identical": the watcher's whole job is to move one side toward the
# other, so between two test runs they are legitimately one commit apart.
# What must hold is that they have NOT diverged, because a diverged pair is
# the one state the transport refuses to resolve on its own.
$comparable = ($localHead -eq $remoteHead) -or
    (Test-Ancestor -WorkingDirectory $Repo -Ancestor $localHead -Descendant $remoteHead) -or
    (Test-Ancestor -WorkingDirectory $Repo -Ancestor $remoteHead -Descendant $localHead)
Assert-That 'local and origin/<branch> have not diverged' $comparable `
    "local $localHead / remote $remoteHead$(if ($localHead -eq $remoteHead) { ' (identical)' } else { ' (one ahead of the other; the watcher closes this)' })"

# If the checkout is ahead, the probe below would diverge it from the remote
# and no fast-forward could ever happen. Wait for the watcher to push first:
# that is Case B of the watcher's contract, exercised rather than assumed.
if (-not $comparable) {
    exit $script:ExitCodes.Diverged
}
if ($localHead -ne $remoteHead) {
    Write-Detail 'Local is ahead of the remote; waiting for the watcher to push (Case B).'
    $pushDeadline = (Get-Date).AddSeconds($WatchTimeoutSeconds)
    $pushed = $false
    while ((Get-Date) -lt $pushDeadline) {
        Start-Sleep -Seconds 5
        $null = Invoke-Git -WorkingDirectory $Repo -Arguments @('fetch', $Remote, $Branch) -AllowFailure
        if ((Get-Head -WorkingDirectory $Repo) -eq (Get-Head -WorkingDirectory $Repo -Revision "$Remote/$Branch")) {
            $pushed = $true
            break
        }
    }
    Assert-That 'watcher pushed the local commit (case B)' $pushed `
        "local $(Get-Head -WorkingDirectory $Repo) / remote $(Get-Head -WorkingDirectory $Repo -Revision "$Remote/$Branch")"
    $localHead = Get-Head -WorkingDirectory $Repo
    $remoteHead = Get-Head -WorkingDirectory $Repo -Revision "$Remote/$Branch"
}

$infraRoot = Join-Path $env:APPDATA 'SAIPEN'
$pidFile = Join-Path $infraRoot 'ZAICODE_cloud-sync.pid'
$lockFile = Join-Path $infraRoot 'ZAICODE_cloud-sync.lock'
$logFile = Join-Path $infraRoot 'ZAICODE_cloud-sync.log'

$watcherPid = 0
$watcherAlive = $false
if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
    $raw = (Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if (-not [string]::IsNullOrWhiteSpace($raw) -and [int]::TryParse($raw.Trim(), [ref]$watcherPid)) {
        $watcherAlive = $null -ne (Get-Process -Id $watcherPid -ErrorAction SilentlyContinue)
    }
}
Assert-That 'watcher process is running' $watcherAlive `
    $(if ($watcherAlive) { "pid $watcherPid" } else { "no live pid in $pidFile" })

$lockHeld = $false
try {
    $probe = [System.IO.File]::Open($lockFile, [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $probe.Dispose()
}
catch {
    $lockHeld = $true
}
Assert-That 'watcher holds the single-instance lock' $lockHeld $lockFile

# --- round trip ------------------------------------------------------------

$probeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("saipen-live-probe-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
$coldDir = Join-Path ([System.IO.Path]::GetTempPath()) ("saipen-live-cold-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
$probeHead = $null

Write-Head 'ROUND TRIP (independent executor)'

$remoteUrl = (Invoke-Git -WorkingDirectory $Repo -Arguments @('remote', 'get-url', $Remote)).Output
Write-Host "  cloning $remoteUrl ($Branch) into a throwaway directory"

try {
    if (-not $SkipPush) {
        $clone = Invoke-Git -WorkingDirectory (Split-Path -Parent $probeDir) `
            -Arguments @('clone', '--branch', $Branch, '--single-branch', $remoteUrl, $probeDir) -AllowFailure
        if ($clone.ExitCode -ne 0) {
            Write-Host "  clone failed: $($clone.Output)"
            Assert-That 'independent executor can clone origin/<branch>' $false $clone.Output
        }
        else {
            Assert-That 'independent executor can clone origin/<branch>' $true $probeDir

            $identity = Invoke-Git -WorkingDirectory $probeDir -Arguments @(
                '-c', 'user.name=saipen-transport-probe',
                '-c', 'user.email=saipen-transport-probe@localhost',
                '-c', 'commit.gpgsign=false',
                'commit', '--allow-empty', '--no-gpg-sign', '-m', $ProbeMessage)

            if ($identity.ExitCode -ne 0) {
                Assert-That 'independent executor can commit' $false $identity.Output
            }
            else {
                Assert-That 'independent executor can commit' $true $identity.Output
                $probeHead = Get-Head -WorkingDirectory $probeDir
                Write-Host "  probe commit: $probeHead"

                $push = Invoke-Git -WorkingDirectory $probeDir `
                    -Arguments @('push', $Remote, "HEAD:refs/heads/$Branch") -AllowFailure
                Assert-That 'probe commit pushes to origin/<branch> without force' `
                    ($push.ExitCode -eq 0) $push.Output

                if ($push.ExitCode -eq 0) {
                    $null = Invoke-Git -WorkingDirectory $Repo -Arguments @('fetch', $Remote, $Branch) -AllowFailure
                    $aheadBefore = (Get-Head -WorkingDirectory $Repo)
                    Write-Host "  local HEAD before the watcher acts: $aheadBefore"

                    $deadline = (Get-Date).AddSeconds($WatchTimeoutSeconds)
                    $arrived = $false
                    while ((Get-Date) -lt $deadline) {
                        Start-Sleep -Seconds 5
                        $current = Get-Head -WorkingDirectory $Repo
                        if ($current -eq $probeHead) {
                            $arrived = $true
                            break
                        }
                    }
                    Assert-That 'installed watcher fast-forwarded the live checkout' $arrived `
                        $(if ($arrived) { "reached $probeHead unaided" } else { "still at $(Get-Head -WorkingDirectory $Repo) after $WatchTimeoutSeconds s" })

                    $afterStatus = Invoke-Git -WorkingDirectory $Repo -Arguments @('status', '--porcelain=v1', '--untracked-files=all')
                    Assert-That 'worktree still clean after the pull' `
                        ([string]::IsNullOrEmpty($afterStatus.Output)) $afterStatus.Output
                }
            }
        }
    }

    # --- cold recovery ------------------------------------------------------

    Write-Head 'COLD RECOVERY (fresh clone, no memory of this session)'

    # A genuinely separate clone, taken after the round trip, so it can only
    # know what the transport actually carried.
    $cold = Invoke-Git -WorkingDirectory (Split-Path -Parent $coldDir) `
        -Arguments @('clone', '--branch', $Branch, '--single-branch', $remoteUrl, $coldDir) -AllowFailure
    Assert-That 'a fresh executor can clone the transport branch' ($cold.ExitCode -eq 0) $cold.Output
    if ($cold.ExitCode -ne 0) {
        throw "cold-recovery clone failed: $($cold.Output)"
    }

    $coldHead = Get-Head -WorkingDirectory $coldDir
    Write-Host "  cold clone HEAD: $coldHead"

    Assert-That 'cold clone is at the transport branch tip' `
        ($coldHead -eq (Get-Head -WorkingDirectory $Repo)) 'fresh clone matches the live checkout'

    foreach ($relative in @('CLAUDE.md', '.claude\skills\saipen\SKILL.md', 'docs\ZAICODE_SAIPEN_CLOUD.md', '.saipen\STATE.md', '.saipen\BOARD.md', '.saipen\LOG.md')) {
        $full = Join-Path $coldDir $relative
        Assert-That "cold clone carries $relative" (Test-Path -LiteralPath $full -PathType Leaf) $full
    }

    $coldState = Join-Path $coldDir '.saipen\STATE.md'
    $stateTask = (Select-String -LiteralPath $coldState -Pattern '^task:\s*(\S+)' | Select-Object -First 1)
    $statePhase = (Select-String -LiteralPath $coldState -Pattern '^phase:\s*(\S+)' | Select-Object -First 1)
    Assert-That 'cold clone names the active ticket from STATE.md' ($null -ne $stateTask) `
        $(if ($null -ne $stateTask) { "$($stateTask.Matches[0].Groups[1].Value) in phase $(if ($null -ne $statePhase) { $statePhase.Matches[0].Groups[1].Value })" } else { 'no task line' })

    $coldBoard = Join-Path $coldDir '.saipen\BOARD.md'
    $doing = (Select-String -LiteralPath $coldBoard -Pattern '^- \[/\] (T-\d+)' | Select-Object -First 1)
    Assert-That 'cold clone names a top workable ticket on the board' ($null -ne $doing) `
        $(if ($null -ne $doing) { $doing.Matches[0].Groups[1].Value } else { 'no DOING ticket' })

    $coldSkill = Get-Content -LiteralPath (Join-Path $coldDir '.claude\skills\saipen\SKILL.md') -Raw
    Assert-That 'cold clone teaches cc and cc all' `
        (($coldSkill -match 'cc all') -and ($coldSkill -match '`cc`')) 'skill defines both shortcuts'

    $coldClaude = Get-Content -LiteralPath (Join-Path $coldDir 'CLAUDE.md') -Raw
    Assert-That 'cold clone points at origin/saipen-live transport' `
        ($coldClaude -match 'saipen-live') 'CLAUDE.md names the transport branch'
}
finally {
    if (Test-Path -LiteralPath $probeDir) {
        Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ((-not [string]::IsNullOrEmpty($coldDir)) -and (Test-Path -LiteralPath $coldDir)) {
        Remove-Item -LiteralPath $coldDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# --- verdict ---------------------------------------------------------------

Write-Head 'VERDICT'
Write-Host "  checks:  $($script:Checks)"
Write-Host "  failures: $($script:Failures.Count)"
if ($probeHead) {
    Write-Host "  probe commit: $probeHead"
}
Write-Host "  watcher log: $logFile"

if ($script:Failures.Count -gt 0) {
    Write-Host ''
    foreach ($failure in $script:Failures) {
        Write-Host "  FAILED: $failure"
    }
    exit 1
}

Write-Host ''
Write-Host '  TRANSPORT VERIFIED'
exit 0
