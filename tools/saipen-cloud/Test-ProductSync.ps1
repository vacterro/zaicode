<#
.SYNOPSIS
    Proves the watcher's product pass and self-update against real Git
    repositories in a temporary folder. Touches nothing outside that folder.

.DESCRIPTION
    Builds a throwaway outer repository (branch saipen-live) with a nested
    product checkout (zcode/, branch zaicode), each with its own bare origin,
    then drives tools\saipen-cloud\ZaicodeSaipenLiveWatcher.ps1 through every
    product case and checks the resulting Git state, not just the log:

        P-A  remote ahead, clean                   -> fast-forwarded
        P-A  remote ahead, unrelated dirt          -> fast-forwarded, dirt kept byte for byte
        P-H  remote ahead, incoming file is dirty  -> held, nothing changed
        P-L  local ahead                           -> nothing pushed
        P-E  diverged                              -> nothing merged or pushed
        P-B  other branch                          -> nothing merged
        --   no product checkout / -NoProduct      -> skipped cleanly
        SU   newer committed watcher               -> installed copy replaced, one successor starts
        SU   repository watcher with a parse error -> refused, running copy kept

    Runs under Windows PowerShell 5.1 and PowerShell 7. Exit 0 only when every
    check passes.

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\saipen-cloud\Test-ProductSync.ps1
#>
[CmdletBinding()]
param(
    [string]$Watcher,
    [switch]$Keep
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 leaves $PSScriptRoot empty while a param() default is
# being evaluated, so the default resolves here. PowerShell 7 tolerates both.
if (-not $Watcher) {
    $Watcher = Join-Path $PSScriptRoot 'ZaicodeSaipenLiveWatcher.ps1'
}

$script:Failures = 0
$script:Checks = 0
$shell = (Get-Process -Id $PID).Path

function Check {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    $script:Checks += 1
    if ($Condition) {
        Write-Host "PASS  $Name"
    }
    else {
        $script:Failures += 1
        Write-Host "FAIL  $Name $Detail"
    }
}

# Native git with the 5.1 stderr trap disarmed; throws on a non-zero exit.
function G {
    param([string]$Path, [Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $global:LASTEXITCODE = 0
        $out = & git -C $Path @GitArgs 2>&1
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
    $text = ''
    if ($null -ne $out) {
        $text = (@($out) | ForEach-Object { $_.ToString() }) -join "`n"
    }
    if ($code -ne 0) {
        throw "git $($GitArgs -join ' ') in $Path failed ($code): $text"
    }
    return $text.Trim()
}

function Write-File {
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text)
}

function Read-File {
    param([string]$Path)
    return [System.IO.File]::ReadAllText($Path)
}

$root = Join-Path ([System.IO.Path]::GetTempPath()) ("zaicode-product-sync-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $root | Out-Null
Write-Host "Scratch: $root"

try {
    # --- fixture: outer repo + nested product repo, each with a bare origin --
    $outerOrigin = Join-Path $root 'outer-origin.git'
    $productOrigin = Join-Path $root 'product-origin.git'
    $outer = Join-Path $root 'outer'
    $product = Join-Path $outer 'zcode'
    $publisher = Join-Path $root 'publisher'

    G $root init -q --bare $outerOrigin | Out-Null
    G $root init -q --bare $productOrigin | Out-Null

    G $root init -q -b saipen-live $outer | Out-Null
    foreach ($repo in @($outer)) {
        G $repo config user.name 'Test' | Out-Null
        G $repo config user.email 'test@example.invalid' | Out-Null
        G $repo config core.autocrlf false | Out-Null
    }
    $toolsDir = Join-Path (Join-Path $outer 'tools') 'saipen-cloud'
    New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
    Copy-Item -LiteralPath $Watcher -Destination (Join-Path $toolsDir 'ZaicodeSaipenLiveWatcher.ps1')
    Write-File (Join-Path $outer '.gitignore') "/zcode/`n"
    G $outer add -A | Out-Null
    G $outer commit -q -m 'outer seed' | Out-Null
    G $outer remote add origin $outerOrigin | Out-Null
    G $outer push -q -u origin saipen-live | Out-Null

    G $root init -q -b zaicode $publisher | Out-Null
    G $publisher config user.name 'Cloud' | Out-Null
    G $publisher config user.email 'cloud@example.invalid' | Out-Null
    G $publisher config core.autocrlf false | Out-Null
    Write-File (Join-Path $publisher 'a.txt') "a1`n"
    Write-File (Join-Path $publisher 'b.txt') "b1`n"
    G $publisher add -A | Out-Null
    G $publisher commit -q -m 'product seed' | Out-Null
    G $publisher remote add origin $productOrigin | Out-Null
    G $publisher push -q -u origin zaicode | Out-Null

    # -c core.autocrlf=false on the clone itself, not on $product afterwards:
    # Git for Windows ships a system config with core.autocrlf=true, so a clone
    # made before the local override checks out CRLF against an LF blob and every
    # case reads as HELD. The cloud ran this on Linux, where the setting is absent.
    # G $product config core.autocrlf false (the next line) is too late: it changes
    # what git compares, not the bytes already written into the working tree.
    G $root -c core.autocrlf=false clone -q -b zaicode $productOrigin $product | Out-Null
    G $product config user.name 'Operator' | Out-Null
    G $product config user.email 'operator@example.invalid' | Out-Null
    G $product config core.autocrlf false | Out-Null

    $case = 0
    function Invoke-WatcherOnce {
        param([string[]]$Extra = @())
        $script:case += 1
        $log = Join-Path $root ("once-$($script:case).log")
        $lock = Join-Path $root ("once-$($script:case).lock")
        $pidPath = Join-Path $root ("once-$($script:case).pid")
        $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $Watcher,
            '-Repo', $outer, '-LogFile', $log, '-LockFile', $lock, '-PidFile', $pidPath, '-Once') + $Extra
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & $shell @arguments 2>&1 | Out-Null
            $code = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previous
        }
        $text = ''
        if (Test-Path -LiteralPath $log) {
            $text = Read-File $log
        }
        return [pscustomobject]@{ Exit = $code; Log = $text }
    }

    function Publish {
        param([string]$File, [string]$Text, [string]$Message)
        Write-File (Join-Path $publisher $File) $Text
        G $publisher add -A | Out-Null
        G $publisher commit -q -m $Message | Out-Null
        G $publisher push -q origin zaicode | Out-Null
        return (G $publisher rev-parse HEAD)
    }

    # --- P-A clean ---------------------------------------------------------
    $remote = Publish 'a.txt' "a2`n" 'cloud fix 1'
    $run = Invoke-WatcherOnce
    Check 'P-A clean: exit 0' ($run.Exit -eq 0)
    Check 'P-A clean: product fast-forwarded to the remote' ((G $product rev-parse HEAD) -eq $remote)
    Check 'P-A clean: logged' ($run.Log -match 'Product: fast-forwarded')

    # --- P-A with unrelated dirt (the operator's T-84 situation) -----------
    Write-File (Join-Path $product 'a.txt') "a2 local edit`n"
    Write-File (Join-Path $product 'scratch.txt') "untracked`n"
    $remote = Publish 'b.txt' "b2`n" 'cloud fix 2'
    $run = Invoke-WatcherOnce
    Check 'P-A dirty: fast-forwarded past unrelated dirt' ((G $product rev-parse HEAD) -eq $remote)
    Check 'P-A dirty: modified file kept byte for byte' ((Read-File (Join-Path $product 'a.txt')) -eq "a2 local edit`n")
    Check 'P-A dirty: untracked file kept' ((Read-File (Join-Path $product 'scratch.txt')) -eq "untracked`n")
    Check 'P-A dirty: incoming file updated' ((Read-File (Join-Path $product 'b.txt')) -eq "b2`n")
    Check 'P-A dirty: dirt counted in the log' ($run.Log -match '2 uncommitted path\(s\) left as they were')

    # --- P-H: incoming change touches a dirty file --------------------------
    $before = G $product rev-parse HEAD
    $remote = Publish 'a.txt' "a3 cloud`n" 'cloud fix 3 touches a.txt'
    $run = Invoke-WatcherOnce
    Check 'P-H: HEAD unchanged' ((G $product rev-parse HEAD) -eq $before)
    Check 'P-H: dirty file untouched' ((Read-File (Join-Path $product 'a.txt')) -eq "a2 local edit`n")
    Check 'P-H: HELD logged with the path' ($run.Log -match 'HELD: .* \(a\.txt\)')

    # The operator finishes the local work: the held commit then arrives.
    Write-File (Join-Path $product 'a.txt') "a2`n"
    Remove-Item -LiteralPath (Join-Path $product 'scratch.txt')
    $run = Invoke-WatcherOnce
    Check 'P-H released: fast-forwarded once the file is clean' ((G $product rev-parse HEAD) -eq $remote)

    # --- P-L: local ahead is never pushed ------------------------------------
    Write-File (Join-Path $product 'c.txt') "local only`n"
    G $product add -A | Out-Null
    G $product commit -q -m 'local product commit' | Out-Null
    $originBefore = G $root --git-dir=$productOrigin rev-parse zaicode
    $run = Invoke-WatcherOnce
    Check 'P-L: origin not moved (no push)' ((G $root --git-dir=$productOrigin rev-parse zaicode) -eq $originBefore)
    Check 'P-L: LOCAL_AHEAD logged' ($run.Log -match 'ahead of origin/zaicode\. Not pushed')

    # --- P-E: diverged --------------------------------------------------------
    $localHead = G $product rev-parse HEAD
    $remote = Publish 'd.txt' "cloud d`n" 'cloud fix 4'
    $run = Invoke-WatcherOnce
    Check 'P-E: local HEAD kept' ((G $product rev-parse HEAD) -eq $localHead)
    Check 'P-E: origin kept' ((G $root --git-dir=$productOrigin rev-parse zaicode) -eq $remote)
    Check 'P-E: DIVERGED logged' ($run.Log -match 'DIVERGED: local')

    # Reconcile by hand the way the doc says (merge, never force), for the next cases.
    G $product merge -q --no-edit origin/zaicode | Out-Null
    G $product push -q origin zaicode | Out-Null
    G $publisher pull -q --ff-only origin zaicode | Out-Null

    # --- P-B: another branch --------------------------------------------------
    G $product checkout -q -b feature | Out-Null
    $before = G $product rev-parse HEAD
    Publish 'e.txt' "e`n" 'cloud fix 5' | Out-Null
    $run = Invoke-WatcherOnce
    Check 'P-B: other branch left alone' ((G $product rev-parse HEAD) -eq $before)
    Check 'P-B: WAIT_BRANCH logged' ($run.Log -match "product branch is 'feature', expected 'zaicode'")
    G $product checkout -q zaicode | Out-Null

    # --- skipped cleanly ------------------------------------------------------
    $run = Invoke-WatcherOnce -Extra @('-NoProduct')
    Check '-NoProduct: no product line' (-not ($run.Log -match 'Product:'))
    $run = Invoke-WatcherOnce -Extra @('-ProductRepo', (Join-Path $root 'nowhere'))
    Check 'absent product checkout: exit 0' ($run.Exit -eq 0)
    Check 'absent product checkout: said once' ($run.Log -match 'no product checkout at')

    # --- outer pass regression (Invoke-Git gained -Path/-Raw in T-90) ---------
    $second = Join-Path $root 'outer-second'
    G $root clone -q -b saipen-live $outerOrigin $second | Out-Null
    G $second config user.name 'Cloud' | Out-Null
    G $second config user.email 'cloud@example.invalid' | Out-Null
    Write-File (Join-Path $second 'state.md') "cloud checkpoint`n"
    G $second add -A | Out-Null
    G $second commit -q -m 'cloud checkpoint' | Out-Null
    G $second push -q origin saipen-live | Out-Null
    $run = Invoke-WatcherOnce -Extra @('-NoProduct')
    Check 'outer A: fast-forwarded to the cloud checkpoint' ((G $outer rev-parse HEAD) -eq (G $second rev-parse HEAD))

    Write-File (Join-Path $outer 'local.md') "local checkpoint`n"
    G $outer add -A | Out-Null
    G $outer commit -q -m 'local checkpoint' | Out-Null
    $run = Invoke-WatcherOnce -Extra @('-NoProduct')
    Check 'outer B: local checkpoint pushed' ((G $root --git-dir=$outerOrigin rev-parse saipen-live) -eq (G $outer rev-parse HEAD))

    Write-File (Join-Path $outer 'wip.md') "uncommitted`n"
    $productBefore = G $product rev-parse HEAD
    $remote = Publish 'f.txt' "f`n" 'cloud fix 6'
    $run = Invoke-WatcherOnce
    Check 'outer C: a dirty outer tree pauses the outer pass' ($run.Log -match 'Paused: working tree has 1 uncommitted path')
    Check 'outer C: the product pass still runs' ((G $product rev-parse HEAD) -eq $remote -and $productBefore -ne $remote)
    Remove-Item -LiteralPath (Join-Path $outer 'wip.md')

    # --- SU: self-update ------------------------------------------------------
    $installDir = Join-Path $root 'appdata'
    New-Item -ItemType Directory -Path $installDir | Out-Null
    $installed = Join-Path $installDir 'ZaicodeSaipenLiveWatcher.ps1'
    Copy-Item -LiteralPath $Watcher -Destination $installed
    $repoCopy = Join-Path $toolsDir 'ZaicodeSaipenLiveWatcher.ps1'

    function Start-LoopWatcher {
        param([string]$Tag)
        $log = Join-Path $root "loop-$Tag.log"
        $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $installed),
            '-Repo', ('"{0}"' -f $outer), '-IntervalSeconds', '1', '-NoProduct',
            '-LogFile', ('"{0}"' -f $log), '-LockFile', ('"{0}"' -f (Join-Path $root "loop-$Tag.lock")),
            '-PidFile', ('"{0}"' -f (Join-Path $root "loop-$Tag.pid")))
        if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
            Start-Process -FilePath $shell -ArgumentList $arguments -WindowStyle Hidden | Out-Null
        }
        else {
            Start-Process -FilePath $shell -ArgumentList $arguments | Out-Null
        }
        return $log
    }

    function Wait-For {
        param([string]$Path, [string]$Pattern, [int]$Seconds = 40)
        $deadline = (Get-Date).AddSeconds($Seconds)
        while ((Get-Date) -lt $deadline) {
            if ((Test-Path -LiteralPath $Path) -and ((Read-File $Path) -match $Pattern)) {
                return $true
            }
            Start-Sleep -Milliseconds 500
        }
        return $false
    }

    function Stop-LoopWatcher {
        param([string]$Tag)
        $pidPath = Join-Path $root "loop-$Tag.pid"
        if (Test-Path -LiteralPath $pidPath) {
            $watcherPid = (Get-Content -LiteralPath $pidPath | Select-Object -First 1)
            if ($watcherPid) {
                Stop-Process -Id ([int]$watcherPid) -Force -ErrorAction SilentlyContinue
            }
        }
        Start-Sleep -Milliseconds 500
    }

    # A committed, newer watcher replaces the installed copy and restarts once.
    Add-Content -LiteralPath $repoCopy -Value "`n# self-update marker $([guid]::NewGuid().ToString('N'))"
    G $outer add -A | Out-Null
    G $outer commit -q -m 'newer watcher' | Out-Null
    G $outer push -q origin saipen-live | Out-Null
    $log = Start-LoopWatcher 'su'
    $updated = Wait-For $log 'Self-update: installed'
    $restarted = $updated -and (Wait-For $log '(?s)Self-update: installed.*Watcher up')
    Check 'SU: newer committed watcher installed over the running copy' $updated
    Check 'SU: exactly one successor came up' ($restarted -and ([regex]::Matches((Read-File $log), 'Self-update: installed').Count -eq 1))
    Check 'SU: installed copy now equals the repository copy' (
        (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $repoCopy -Algorithm SHA256).Hash)
    Start-Sleep -Seconds 3
    Check 'SU: no restart loop' ([regex]::Matches((Read-File $log), 'Watcher up').Count -eq 2)
    Stop-LoopWatcher 'su'

    # A repository watcher that does not parse is refused; the running copy stays.
    $goodHash = (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash
    Add-Content -LiteralPath $repoCopy -Value "`nfunction Broken {"
    G $outer add -A | Out-Null
    G $outer commit -q -m 'broken watcher' | Out-Null
    G $outer push -q origin saipen-live | Out-Null
    $log = Start-LoopWatcher 'bad'
    Check 'SU refused: parse errors reported' (Wait-For $log 'Self-update refused')
    Check 'SU refused: running copy unchanged' ((Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -eq $goodHash)
    Stop-LoopWatcher 'bad'
}
finally {
    if (-not $Keep) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ''
if ($script:Failures -eq 0) {
    Write-Host "PRODUCT SYNC VERIFIED: $($script:Checks) checks, 0 failures."
    exit 0
}
Write-Host "PRODUCT SYNC NOT VERIFIED: $($script:Failures) of $($script:Checks) checks failed."
exit 1
