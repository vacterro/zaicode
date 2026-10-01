# Runs the real Publish-Release.ps1 against stubbed `git` and `gh` so the
# failure path can be proved without touching a remote or a real tag.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File release/Publish-Release.Tests.ps1
#
# Two cases, both with `gh release create` failing:
#   A  `gh release view` reports no release -> the pushed tag must be deleted,
#      because a tag claiming verified distribution must not outlive it.
#   B  `gh release view` finds a release    -> the tag must be kept, so an
#      operator can inspect what landed.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ReleaseLib.ps1')

$script:Failures = @()
function Assert-That([bool]$Condition, [string]$Message) {
    if ($Condition) { Write-Output ('  PASS ' + $Message) }
    else { Write-Output ('  FAIL ' + $Message); $script:Failures += $Message }
}

$stubs = Join-Path $env:TEMP ('t161-stubs-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$root  = Join-Path $env:TEMP ('t161-run-'   + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $stubs, $root | Out-Null
try {
    # The stub directory leads PATH, so the real git and gh never run. The
    # fixture ProductDirectory is not a git repository either, so even a PATH
    # that ignored the stub could not create a tag anywhere.
    $env:PATH = $stubs + [IO.Path]::PathSeparator + $env:PATH
    $env:T161_LOG = Join-Path $root 'calls.log'
    $env:T161_HEAD = '0' * 40

    @'
@echo off
echo git %*>>"%T161_LOG%"
if "%~3"=="rev-parse" (echo %T161_HEAD%& exit /b 0)
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $stubs 'git.cmd') -Encoding Ascii

    @'
@echo off
echo gh %*>>"%T161_LOG%"
if "%~2"=="create" exit /b %T161_GH_CREATE_EXIT%
if "%~2"=="view" exit /b %T161_GH_VIEW_EXIT%
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $stubs 'gh.cmd') -Encoding Ascii

    $release = Join-Path $root 'release'
    $product = Join-Path $root 'product'
    New-Item -ItemType Directory -Path $release, $product | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'RELEASE-NOTES.md') -Destination $release

    $version = '1.0.0'
    $tag = 'zaicode-v' + $version
    $head = $env:T161_HEAD
    $components = @()
    foreach ($id in $script:ComponentIds) {
        $name = $id + '.zip'
        [IO.File]::WriteAllText((Join-Path $release $name), ('component ' + $id))
        $components += [ordered]@{
            id = $id
            version = $version
            url = 'https://github.com/vacterro/zaicode/releases/download/' + $tag + '/' + $name
            sha256 = Get-ReleaseSha256 (Join-Path $release $name)
            size = (Get-Item -LiteralPath (Join-Path $release $name)).Length
        }
    }
    $installer = 'zaicode-setup.exe'
    [IO.File]::WriteAllText((Join-Path $release $installer), 'installer bytes')
    $installerPath = Join-Path $release $installer
    $installerSha = Get-ReleaseSha256 $installerPath
    $installerSize = (Get-Item -LiteralPath $installerPath).Length

    Write-ReleaseJson ([ordered]@{
        schema = 1; product = 'zaicode'; channel = 'stable'; approved = $false
        runtimeContract = 1; version = $version; components = $components
    }) (Join-Path $release 'stable.json')
    Write-ReleaseJson ([ordered]@{
        productHead = $head; sha256 = $installerSha; size = $installerSize
        installer = $installer; version = $version
        # ReleaseLib.ps1 turns on Set-StrictMode -Version Latest, and this
        # script dot-sources it, so these two keys must already exist or
        # Publish-Release.ps1 cannot set them and never reaches the tag.
        publication = 'LOCAL_ONLY_NOT_PROMOTED'; freshWindows = 'OPERATOR_REQUIRED'
    }) (Join-Path $release 'release-metadata.json')

    $gates = [ordered]@{}
    foreach ($gate in @('installer', 'firstLaunch', 'saipen', 'saimail', 'freeFirstAnswer',
                        'restart', 'verifiedUpdate', 'badArtifactRejection',
                        'statePreservingUpgrade', 'uninstallReinstall', 'offlineRecovery',
                        'tests', 'typecheck', 'lint', 'architecture', 'verifyPrePush',
                        'productionBuild', 'installerBuild')) { $gates[$gate] = 'PASS' }
    $receipt = Join-Path $root 'clean-acceptance.json'
    Write-ReleaseJson ([ordered]@{
        schema = 1; environment = 'clean-Windows-VM'; productHead = $head
        installerSha256 = $installerSha; manualDeveloperSteps = @(); isolationVerified = $true
        gates = $gates
    }) $receipt

    $env:T161_GH_CREATE_EXIT = '1'

    function Invoke-Case([string]$ViewExit) {
        $env:T161_GH_VIEW_EXIT = $ViewExit
        Remove-Item -LiteralPath $env:T161_LOG -ErrorAction SilentlyContinue
        $message = ''
        try {
            & (Join-Path $PSScriptRoot 'Publish-Release.ps1') `
                -ReleaseDirectory $release -ProductDirectory $product -CleanAcceptanceReceipt $receipt `
                6> $null
        } catch { $message = $_.Exception.Message }
        return @{ Message = $message; Calls = (Get-Content -LiteralPath $env:T161_LOG -Raw) }
    }

    Write-Output 'case A: gh release view reports no release'
    $a = Invoke-Case '1'
    $mark = $script:Failures.Count
    Assert-That ($a.Calls -match ('git -C \S+ push origin :refs/tags/' + [Regex]::Escape($tag))) `
        'the pushed tag is deleted'
    Assert-That ($a.Calls -match ('git -C \S+ tag -d ' + [Regex]::Escape($tag))) `
        'the local tag is deleted so a retry re-creates it'
    Assert-That ($a.Message -match 'no release exists') `
        'the throw says why the tag is gone'
    Assert-That ($a.Calls -notmatch 'gh release create .*--draft') `
        'no hidden second publish was attempted'
    if ($script:Failures.Count -gt $mark) {
        Write-Output ('  throw: ' + $a.Message)
        Write-Output ('  calls: ' + ($a.Calls -replace "`r?`n", ' | '))
    }

    Write-Output 'case B: gh release view finds a release'
    $b = Invoke-Case '0'
    $mark = $script:Failures.Count
    Assert-That ($b.Calls -notmatch ':refs/tags/') 'the tag is kept'
    Assert-That ($b.Message -match 'a release exists') `
        'the throw keeps the release for inspection'
    if ($script:Failures.Count -gt $mark) {
        Write-Output ('  throw: ' + $b.Message)
        Write-Output ('  calls: ' + ($b.Calls -replace "`r?`n", ' | '))
    }

    Write-Output ''
    if ($script:Failures.Count) {
        Write-Output ('FAILED: ' + $script:Failures.Count + ' assertion(s)')
        exit 1
    }
    Write-Output 'OK'
    exit 0
} finally {
    $env:T161_LOG = $null; $env:T161_HEAD = $null
    $env:T161_GH_CREATE_EXIT = $null; $env:T161_GH_VIEW_EXIT = $null
    Remove-Item -LiteralPath $stubs, $root -Recurse -Force -ErrorAction SilentlyContinue
}