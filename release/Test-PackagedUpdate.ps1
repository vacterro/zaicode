param(
    [Parameter(Mandatory=$true)][string]$ReleaseDirectory,
    [Parameter(Mandatory=$true)][string]$InstallDir,
    [Parameter(Mandatory=$true)][string]$Profile,
    [Parameter(Mandatory=$true)][string]$ProductDirectory,
    [Parameter(Mandatory=$true)][string]$EvidenceDirectory,
    [string]$Node = 'C:/nodejs/node.exe'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ReleaseLib.ps1')
$statePath = Join-Path $InstallDir 'install/install-state.json'
$original = Read-ReleaseJson $statePath
if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'install/no-integration'))) { throw 'This test requires an isolated /NOINTEGRATION installation.' }
[IO.Directory]::CreateDirectory($EvidenceDirectory) | Out-Null
$feed = Join-Path $EvidenceDirectory 'feed'
$build = Join-Path $EvidenceDirectory 'candidate'
$release = Join-Path $feed 'releases/0.0.4'
[IO.Directory]::CreateDirectory($release) | Out-Null
$metadata = Read-ReleaseJson (Join-Path $ReleaseDirectory 'component-app/component.json')
$oldPrefix = 'versions/' + $original.version + '/'
$newPrefix = 'versions/0.0.4/'
foreach ($property in $metadata.paths.PSObject.Properties) {
    $source = Join-Path (Join-Path $ReleaseDirectory 'component-app') $property.Value
    $property.Value = $property.Value.Replace($oldPrefix, $newPrefix)
    $target = Join-Path $build $property.Value
    [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Recurse
}
foreach ($file in $metadata.files) { $file.path = $file.path.Replace($oldPrefix, $newPrefix) }
$markerRelative = $metadata.paths.app + '/controlled-update.json'
$marker = Join-Path $build $markerRelative
Write-ReleaseJson @{ version = '0.0.4'; controlledTest = $true; productHead = $original.productHead } $marker
$metadata.files += [pscustomobject]@{ path = $markerRelative; size = (Get-Item -LiteralPath $marker).Length; sha256 = (Get-FileHash -LiteralPath $marker).Hash.ToLowerInvariant() }
$metadata.version = '0.0.4'
Write-ReleaseJson $metadata (Join-Path $build 'component.json')
$archive = Join-Path $release 'app-0.0.4.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($build, $archive, [IO.Compression.CompressionLevel]::Optimal, $false)
$process = Start-Process -FilePath $Node -ArgumentList @((Join-Path $PSScriptRoot 'test-feed.mjs'), $feed) -WindowStyle Hidden -PassThru
try {
    for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath (Join-Path $feed 'port.txt')); $attempt++) { Start-Sleep -Milliseconds 50 }
    $port = [IO.File]::ReadAllText((Join-Path $feed 'port.txt'))
    $state = $original | ConvertTo-Json -Depth 20 | ConvertFrom-Json
    $state.channel = 'test'
    $state | Add-Member -NotePropertyName testManifestUrl -NotePropertyValue "http://127.0.0.1:$port/stable.json" -Force
    Write-ReleaseJson $state $statePath
    $manifest = Read-ReleaseJson (Join-Path $ReleaseDirectory 'stable.json')
    $manifest.channel = 'test'; $manifest.approved = $true; $manifest.version = '0.0.4'
    foreach ($part in $manifest.components) {
        $part.url = "http://127.0.0.1:$port/releases/0.0.4/$($part.id).zip"
        if ($part.id -eq 'app') { $part.version = '0.0.4'; $part.url = "http://127.0.0.1:$port/releases/0.0.4/app-0.0.4.zip"; $part.size = (Get-Item -LiteralPath $archive).Length; $part.sha256 = (Get-FileHash -LiteralPath $archive).Hash.ToLowerInvariant() }
    }
    Write-ReleaseJson $manifest (Join-Path $feed 'stable.json')
    # A same-size bit flip proves the digest boundary with the real packaged payload.
    $stream = [IO.File]::Open($archive, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite)
    try { $stream.Position = 20; $byte = $stream.ReadByte(); $stream.Position = 20; $stream.WriteByte($byte -bxor 1) } finally { $stream.Dispose() }
    $before = (Get-FileHash -LiteralPath $statePath).Hash
    $rejected = $false
    try { $null = Invoke-ReleaseUpdate $InstallDir -Components @('app') } catch { $rejected = $_.Exception.Message -match 'SHA-256' }
    if (-not $rejected -or (Get-FileHash -LiteralPath $statePath).Hash -ne $before -or (Test-Path -LiteralPath (Join-Path $InstallDir 'install/pending-state.json'))) { throw 'Packaged negative control failed.' }
    $stream = [IO.File]::Open($archive, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite)
    try { $stream.Position = 20; $stream.WriteByte($byte) } finally { $stream.Dispose() }
    $check = Invoke-ReleaseUpdate $InstallDir -Check
    if (-not @($check.components | Where-Object { $_.id -eq 'app' -and $_.status -eq 'available' }).Count) { throw 'Actual packaged update not discovered.' }
    $null = Invoke-ReleaseUpdate $InstallDir -Components @('app')
    if ((Read-ReleaseJson $statePath).version -ne $original.version) { throw 'Staging altered the running version.' }
    & $Node (Join-Path $PSScriptRoot 'Test-Installed.cjs') (Join-Path $InstallDir 'ZAICODE.exe') --profile $Profile --out (Join-Path $EvidenceDirectory '../first-run') --product-dir $ProductDirectory --restart
    if ($LASTEXITCODE -ne 0) { throw 'Updated packaged application failed restart/FREE acceptance.' }
    $active = Read-ReleaseJson $statePath
    if ($active.version -ne '0.0.4' -or (Test-Path -LiteralPath (Join-Path $InstallDir 'install/activation-pending.json'))) { throw 'Verified candidate failed activation.' }
    if ((Read-ReleaseJson (Join-Path $InstallDir 'install/previous-state.json')).version -ne $original.version) { throw 'Last known-good lost.' }
    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir ('versions/' + $original.version + '/app/ZAICODE.exe')))) { throw 'Previous executable lost.' }
    Write-ReleaseJson @{ status = 'PASS'; scope = 'real packaged A to controlled B on an isolated profile, not clean Windows'; negativeControl = 'PASS'; versions = @($original.version,'0.0.4'); at = [DateTime]::UtcNow.ToString('o') } (Join-Path $EvidenceDirectory 'result.json')
    # Test channels never escape into an end-user installation.
    Undo-ReleaseActivation $InstallDir
    Write-ReleaseJson $original $statePath
} finally { if (-not $process.HasExited) { Stop-Process -Id $process.Id } }
