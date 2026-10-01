param(
    [Parameter(Mandatory=$true)][string]$ReleaseDirectory,
    [Parameter(Mandatory=$true)][string]$ProductDirectory,
    [Parameter(Mandatory=$true)][string]$CleanAcceptanceReceipt
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ReleaseLib.ps1')
$metadata = Read-ReleaseJson (Join-Path $ReleaseDirectory 'release-metadata.json')
$receipt = Read-ReleaseJson $CleanAcceptanceReceipt
$required = @('installer','firstLaunch','saipen','saimail','freeFirstAnswer','restart','verifiedUpdate','badArtifactRejection','statePreservingUpgrade','uninstallReinstall','offlineRecovery','tests','typecheck','lint','architecture','verifyPrePush','productionBuild','installerBuild')
if ($receipt.schema -ne 1 -or $receipt.environment -notin @('clean-Windows-VM','Windows-Sandbox','fresh-Windows-profile') -or
    $receipt.productHead -ne $metadata.productHead -or $receipt.installerSha256 -ne $metadata.sha256 -or
    @($receipt.manualDeveloperSteps).Count -ne 0 -or $receipt.isolationVerified -ne $true) {
    throw 'OPERATOR_REQUIRED: genuine clean Windows acceptance bound to this installer is missing.'
}
foreach ($gate in $required) {
    if ($receipt.gates.PSObject.Properties[$gate].Value -ne 'PASS') { throw ('Release gate did not pass: ' + $gate) }
}
$head = (& git -C $ProductDirectory rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -ne $metadata.productHead) { throw 'Product checkout does not match release metadata.' }
if (& git -C $ProductDirectory status --porcelain --untracked-files=normal) { throw 'Product checkout must be clean.' }
$installer = Join-Path $ReleaseDirectory $metadata.installer
Assert-ReleaseDigest $installer $metadata.sha256 $metadata.size
$manifest = Read-ReleaseJson (Join-Path $ReleaseDirectory 'stable.json')
$manifest.approved = $true
Assert-ReleaseManifest $manifest
$assets = @($installer)
foreach ($part in $manifest.components) {
    $path = Join-Path $ReleaseDirectory ([IO.Path]::GetFileName(([Uri]$part.url).AbsolutePath))
    Assert-ReleaseDigest $path $part.sha256 $part.size
    $assets += $path
}
$publish = Join-Path $ReleaseDirectory 'publish'
[IO.Directory]::CreateDirectory($publish) | Out-Null
$promoted = Join-Path $publish 'stable.json'
Write-ReleaseJson $manifest $promoted
$assets += $promoted
$publicMetadata = $metadata | ConvertTo-Json -Depth 20 | ConvertFrom-Json
$publicMetadata.publication = 'PUBLISHED'
$publicMetadata.freshWindows = 'PASS'
$publicMetadata | Add-Member -NotePropertyName releaseUrl -NotePropertyValue ('https://github.com/vacterro/zaicode/releases/tag/zaicode-v' + $metadata.version) -Force
Write-ReleaseJson $publicMetadata (Join-Path $publish 'release-metadata.json')
$assets += Join-Path $publish 'release-metadata.json'
$notes = Join-Path $PSScriptRoot 'RELEASE-NOTES.md'
$tag = 'zaicode-v' + $metadata.version
& git -C $ProductDirectory tag -a $tag $head -m ('ZAICODE ' + $metadata.version + ' verified stable distribution')
if ($LASTEXITCODE -ne 0) { throw 'Release tag creation failed.' }
& git -C $ProductDirectory push origin ('refs/tags/' + $tag)
if ($LASTEXITCODE -ne 0) { throw 'Release tag push failed.' }
& gh release create $tag --repo vacterro/zaicode --verify-tag --title ('ZAICODE ' + $metadata.version) --notes-file $notes @assets
if ($LASTEXITCODE -ne 0) {
    # The tag is pushed BEFORE the release because --verify-tag refuses to run
    # without it, so the ordering is fixed and compensation is the only answer.
    # A tag claiming verified distribution must not outlive the artifacts it
    # describes -- but a half-uploaded release keeps its tag, so an operator can
    # see what landed. Delete only when gh reports no release for the tag.
    & gh release view $tag --repo vacterro/zaicode *> $null
    if ($LASTEXITCODE -ne 0) {
        & git -C $ProductDirectory push origin (':refs/tags/' + $tag)
        & git -C $ProductDirectory tag -d $tag
        throw ('Release publication failed and no release exists for ' + $tag + '; the pushed tag was removed so it claims nothing.')
    }
    throw ('Release publication failed; a release exists for ' + $tag + ', so its tag was kept. Inspect before retry.')
}
Write-ReleaseJson $publicMetadata (Join-Path $ReleaseDirectory 'release-metadata.json')
Write-Output $publicMetadata.releaseUrl
