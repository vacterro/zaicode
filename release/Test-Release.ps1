param([Parameter(Mandatory=$true)][string]$EvidenceDirectory, [string]$Node = 'C:/nodejs/node.exe')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ReleaseLib.ps1')
[IO.Directory]::CreateDirectory($EvidenceDirectory) | Out-Null
$root = Join-Path $EvidenceDirectory 'installed'
$feed = Join-Path $EvidenceDirectory 'feed'
[IO.Directory]::CreateDirectory($feed) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $root 'install/verified-payloads')) | Out-Null
function Assert([bool]$Condition, [string]$Description) { if (-not $Condition) { throw "FAIL: $Description" }; Write-Output "PASS: $Description" }
function Build-FixturePart([string]$Id, [string]$Version, [string]$Path) {
    $source = Join-Path $EvidenceDirectory ('source-' + $Id + '-' + $Version)
    $relative = "managed/$Id/$Version"
    if ($Id -eq 'app') { $relative = "versions/$Version/app" }
    $directory = Join-Path $source $relative
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $file = Join-Path $directory 'runtime.txt'; [IO.File]::WriteAllText($file, "$Id revision $Version")
    $paths = [ordered]@{}; $paths[$Id] = $relative
    $metadata = @{ schema = 1; runtimeContract = 1; id = $Id; version = $Version; paths = $paths; files = @(@{ path = "$relative/runtime.txt"; size = (Get-Item $file).Length; sha256 = (Get-FileHash $file).Hash.ToLowerInvariant() }) }
    Write-ReleaseJson $metadata (Join-Path $source 'component.json')
    $archive = Join-Path $Path ($Id + '-' + $Version + '.zip')
    [IO.Compression.ZipFile]::CreateFromDirectory($source, $archive)
    return @{ source = $source; metadata = $metadata; archive = $archive; sha256 = (Get-FileHash $archive).Hash.ToLowerInvariant(); size = (Get-Item $archive).Length }
}
$state = [ordered]@{ schema = 1; runtimeContract = 1; version = '0.0.3'; channel = 'test'; testManifestUrl = ''; components = [ordered]@{} }
foreach ($id in $script:ComponentIds) {
    $part = Build-FixturePart $id '0.0.3' $feed
    foreach ($relative in $part.metadata.paths.Values) {
        $target = Join-Path $root $relative
        [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
        Copy-Item -LiteralPath (Join-Path $part.source $relative) -Destination $target -Recurse
    }
    $receipt = Join-Path $root "install/verified-payloads/$id-0.0.3.json"
    Write-ReleaseJson $part.metadata $receipt
    $state.components[$id] = @{ version = '0.0.3'; sha256 = $part.sha256; receiptSha256 = (Get-FileHash $receipt).Hash.ToLowerInvariant(); paths = $part.metadata.paths }
}
$process = Start-Process -FilePath $Node -ArgumentList @((Join-Path $PSScriptRoot 'test-feed.mjs'), $feed) -WindowStyle Hidden -PassThru
try {
    for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path (Join-Path $feed 'port.txt')); $attempt++) { Start-Sleep -Milliseconds 50 }
    $port = [IO.File]::ReadAllText((Join-Path $feed 'port.txt'))
    $state.testManifestUrl = "http://127.0.0.1:$port/stable.json"
    Write-ReleaseJson $state (Join-Path $root 'install/seed-state.json')
    Initialize-ReleaseInstall $root
    $durable = Join-Path $EvidenceDirectory 'user-state'; [IO.Directory]::CreateDirectory($durable) | Out-Null
    foreach ($name in @('settings', 'sessions', 'provider-config', 'sounds', 'icons', 'folders', 'pins', 'slots', 'mail-identity', 'project-history')) { [IO.File]::WriteAllText((Join-Path $durable $name), "preserve $name") }
    $before = @(Get-ChildItem $durable -File | ForEach-Object { (Get-FileHash $_.FullName).Hash }) -join ','
    function Write-FixtureManifest([string]$Version, [switch]$Corrupt) {
        $components = @()
        $release = Join-Path $feed "releases/$Version"; [IO.Directory]::CreateDirectory($release) | Out-Null
        foreach ($id in $script:ComponentIds) {
            $part = Build-FixturePart $id $Version $release
            $components += @{ id = $id; version = $Version; sha256 = $part.sha256; size = $part.size; url = "http://127.0.0.1:$port/releases/$Version/$id-$Version.zip" }
            if ($Corrupt -and $id -eq 'router') {
                $bytes = [IO.File]::ReadAllBytes($part.archive); $bytes[20] = $bytes[20] -bxor 1; [IO.File]::WriteAllBytes($part.archive, $bytes)
            }
        }
        Write-ReleaseJson @{ schema = 1; product = 'zaicode'; approved = $true; channel = 'test'; runtimeContract = 1; version = $Version; components = $components } (Join-Path $feed 'stable.json')
    }
    Write-FixtureManifest '0.0.4'
    $report = Invoke-ReleaseUpdate $root -Check
    Assert (@($report.components | Where-Object status -eq 'available').Count -eq 4) 'update discovered through controlled feed'
    Assert (-not (Test-Path (Join-Path $root 'install/pending-state.json'))) 'check does not stage or activate'
    $report = Invoke-ReleaseUpdate $root -Components @('saipen')
    Assert ((Read-ReleaseJson (Join-Path $root 'install/pending-state.json')).components.saipen.version -eq '0.0.4') 'independent SAIPEN verified staging'
    Assert ((Read-ReleaseJson (Join-Path $root 'install/install-state.json')).components.saipen.version -eq '0.0.3') 'currently running state remains unchanged'
    $null = Invoke-ReleaseUpdate $root -Components @('app', 'saimail', 'router')
    Activate-ReleaseInstall $root
    Assert ((Read-ReleaseJson (Join-Path $root 'install/install-state.json')).version -eq '0.0.4') 'atomic A to B activation'
    Assert ((Read-ReleaseJson (Join-Path $root 'install/previous-state.json')).version -eq '0.0.3') 'last known-good retained'
    $activeHash = (Get-FileHash (Join-Path $root 'install/install-state.json')).Hash
    Write-FixtureManifest '0.0.5' -Corrupt
    $rejected = $false
    try { $null = Invoke-ReleaseUpdate $root } catch { $rejected = $_.Exception.Message -match 'SHA-256' }
    Assert $rejected 'same-size corrupted artifact rejected by SHA-256'
    Assert ((Get-FileHash (Join-Path $root 'install/install-state.json')).Hash -eq $activeHash) 'bad artifact cannot change active state'
    Assert (-not (Test-Path (Join-Path $root 'install/pending-state.json'))) 'partial transaction cannot activate'
    Undo-ReleaseActivation $root
    Assert ((Read-ReleaseJson (Join-Path $root 'install/install-state.json')).version -eq '0.0.3') 'activation rollback restores A'
    $after = @(Get-ChildItem $durable -File | ForEach-Object { (Get-FileHash $_.FullName).Hash }) -join ','
    Assert ($before -eq $after) 'all durable state preserved'
    foreach ($url in @('http://github.com/vacterro/zaicode/releases/download/zaicode-v1.0.0/a.zip', 'https://github.com/attacker/zaicode/releases/download/zaicode-v1.0.0/a.zip', 'https://github.com/vacterro/zaicode/archive/refs/heads/master.zip')) {
        $rejected = $false; try { Assert-ReleaseArtifactUrl $url } catch { $rejected = $true }; Assert $rejected 'untrusted artifact source rejected'
    }
    $rejected = $false; try { $null = Get-ReleaseChildPath $root '../outside' } catch { $rejected = $true }; Assert $rejected 'archive traversal refused'
    Stop-Process -Id $process.Id
    $rejected = $false; try { $null = Invoke-ReleaseUpdate $root -Check } catch { $rejected = $true }; Assert $rejected 'offline check retains current installation'
    Write-ReleaseJson @{ status = 'PASS'; scope = 'controlled updater fixture; not clean Windows acceptance'; at = [DateTime]::UtcNow.ToString('o'); preservedStateSha256 = $before } (Join-Path $EvidenceDirectory 'result.json')
} finally { if (-not $process.HasExited) { Stop-Process -Id $process.Id } }
