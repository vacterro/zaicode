param(
    [Parameter(Mandatory=$true)][string]$ProductDirectory,
    [Parameter(Mandatory=$true)][string]$AppDirectory,
    [Parameter(Mandatory=$true)][string]$SaipenRepository,
    [Parameter(Mandatory=$true)][string]$SaimailRepository,
    [Parameter(Mandatory=$true)][string]$RuntimeCache,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [Parameter(Mandatory=$true)][string]$Makensis,
    [string]$Version = '0.0.3'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-lock.json') -Raw | ConvertFrom-Json
$productHead = (& git -C $ProductDirectory rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $productHead -notmatch '^[a-f0-9]{40}$') { throw 'Product commit is unavailable.' }
if (& git -C $ProductDirectory status --porcelain --untracked-files=normal) { throw 'Commit the product source before building authoritative release metadata.' }
if (-not (Test-Path -LiteralPath (Join-Path $AppDirectory 'ZAICODE.exe'))) { throw 'Production Electron build is missing.' }
[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$payload = Join-Path $OutputDirectory 'payload'
if (Test-Path -LiteralPath $payload) { throw 'Build output already exists; use a new output directory.' }
[IO.Directory]::CreateDirectory($payload) | Out-Null
$parts = [ordered]@{
    app = [ordered]@{ version = $Version; paths = [ordered]@{ app = "versions/$Version/app"; python = "versions/$Version/runtime/python"; git = "versions/$Version/runtime/git" } }
    saipen = [ordered]@{ version = ($lock.saipen.version + '-' + $lock.saipen.revision.Substring(0,12)); paths = [ordered]@{ saipen = ('managed/saipen/' + $lock.saipen.revision) } }
    saimail = [ordered]@{ version = ($lock.saimail.version + '-' + $lock.saimail.revision.Substring(0,12)); paths = [ordered]@{ saimail = ('managed/saimail/' + $lock.saimail.revision) } }
    router = [ordered]@{ version = $lock.router.version; paths = [ordered]@{ router = ('managed/router/' + $lock.router.version) } }
}
foreach ($part in $parts.Values) { foreach ($path in $part.paths.Values) { [IO.Directory]::CreateDirectory((Join-Path $payload $path)) | Out-Null } }
Copy-Item -Path (Join-Path $AppDirectory '*') -Destination (Join-Path $payload $parts.app.paths.app) -Recurse
foreach ($runtime in @('python')) {
    $archive = Join-Path $RuntimeCache ($runtime + '.zip')
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.$runtime.sha256) { throw 'Runtime archive hash mismatch.' }
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, (Join-Path $payload $parts.app.paths.$runtime))
}
$gitArchive = Join-Path $RuntimeCache 'git-portable.7z.exe'
if ((Get-FileHash -LiteralPath $gitArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.git.sha256) { throw 'Portable Git archive hash mismatch.' }
& $gitArchive -y ('-o' + (Join-Path $payload $parts.app.paths.git)) | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Private Git/Bash extraction failed.' }
if (-not (Test-Path -LiteralPath (Join-Path $payload ($parts.app.paths.git + '/bin/bash.exe')))) { throw 'Private Bash is missing.' }
$python = Join-Path $payload $parts.app.paths.python
[IO.File]::WriteAllText((Join-Path $python 'python313._pth'), "python313.zip`n.`nLib/site-packages`nimport site`n")
$site = Join-Path $python 'Lib/site-packages'
[IO.Directory]::CreateDirectory($site) | Out-Null
foreach ($wheel in (Get-Content -LiteralPath (Join-Path $RuntimeCache 'wheel-lock.json') -Raw | ConvertFrom-Json)) {
    $archive = Join-Path $RuntimeCache $wheel.filename
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $wheel.sha256) { throw 'Python wheel hash mismatch.' }
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $site)
}
function Export-Commit([string]$Repository, [string]$Revision, [string]$Destination, [string[]]$Paths) {
    $archive = Join-Path $OutputDirectory ([Guid]::NewGuid().ToString('N') + '.source.zip')
    & git -C $Repository archive --format=zip ('--output=' + $archive) $Revision -- @Paths
    if ($LASTEXITCODE -ne 0) { throw 'Committed component export failed.' }
    [IO.Compression.ZipFile]::ExtractToDirectory($archive, $Destination)
    [IO.File]::Delete($archive)
}
$saipen = Join-Path $payload $parts.saipen.paths.saipen
Export-Commit $SaipenRepository $lock.saipen.revision $saipen @('tools', 'saipen', 'src', 'extensions', 'bootstrap', 'bin', 'assets', 'guides', 'KNOWLEDGE', 'GUIDE.md', 'VERSION', 'LICENSE', 'THIRD_PARTY_NOTICES.md')
$saimail = Join-Path $payload $parts.saimail.paths.saimail
Export-Commit $SaimailRepository $lock.saimail.revision $saimail @('saimail', 'sailang', 'lab', 'saimail_local.py', 'saimail_host.py', 'saimail_project.py', 'VERSION', 'LICENSE', 'pyproject.toml')
[IO.File]::WriteAllText((Join-Path $saipen 'saipen-entry.py'), "import pathlib, runpy, sys`nroot = pathlib.Path(__file__).resolve().parent`nsys.path.insert(0, str(root / 'tools'))`nrunpy.run_path(str(root / 'tools' / 'saipen.py'), run_name='__main__')`n")
[IO.File]::WriteAllText((Join-Path $saimail 'saimail-entry.py'), "import pathlib, sys`nsys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))`nfrom saimail_local import main`nraise SystemExit(main())`n")
[IO.File]::WriteAllText((Join-Path $saipen 'bin/saipen.cmd'), "@echo off`r`n`"%~dp0..\..\..\..\tools\ZAICODE-runtime.exe`" /saipen %*`r`n")
[IO.File]::WriteAllText((Join-Path $saipen 'bin/saipen'), '#!/bin/sh' + "`n" + 'exec "$(dirname "$0")/../../../../tools/ZAICODE-runtime.exe" /saipen "$@"' + "`n", (New-Object Text.UTF8Encoding($false)))
# Bootstrap launchers exported from the maintainer checkout contain absolute machine paths;
# only the canonical direct launcher above is distributed as an entry point.
$router = Join-Path $payload $parts.router.paths.router
$routerArchive = Join-Path $RuntimeCache 'router.tgz'
if ((Get-FileHash -LiteralPath $routerArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.router.sha256) { throw 'Router archive mismatch.' }
& tar -xf $routerArchive --strip-components=1 -C $router
if ($LASTEXITCODE -ne 0) { throw 'Router extraction failed.' }
$tools = Join-Path $payload 'tools'; [IO.Directory]::CreateDirectory($tools) | Out-Null
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$references = @('/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll')
& $compiler /nologo /optimize+ /target:winexe @references ('/out:' + (Join-Path $payload 'ZAICODE.exe')) (Join-Path $PSScriptRoot 'ReleaseHost.cs')
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
& $compiler /nologo /optimize+ /target:exe @references ('/out:' + (Join-Path $tools 'ZAICODE-runtime.exe')) (Join-Path $PSScriptRoot 'ReleaseHost.cs')
if ($LASTEXITCODE -ne 0) { throw 'Runtime wrapper compilation failed.' }
Copy-Item -LiteralPath (Join-Path $tools 'ZAICODE-runtime.exe') -Destination (Join-Path $tools 'saimail-local.exe')
$install = Join-Path $payload 'install'; [IO.Directory]::CreateDirectory($install) | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'ReleaseLib.ps1'), (Join-Path $PSScriptRoot 'Update-ZAICODE.ps1') -Destination $install

$artifacts = @()
$receipts = Join-Path $install 'verified-payloads'; [IO.Directory]::CreateDirectory($receipts) | Out-Null
foreach ($id in $parts.Keys) {
    $part = $parts[$id]
    $component = Join-Path $OutputDirectory ('component-' + $id); [IO.Directory]::CreateDirectory($component) | Out-Null
    $files = @()
    foreach ($relative in $part.paths.Values) {
        $source = Join-Path $payload $relative
        $target = Join-Path $component $relative
        [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Recurse
        foreach ($file in (Get-ChildItem -LiteralPath $source -File -Recurse)) {
            $files += [ordered]@{ path = $file.FullName.Substring($payload.Length + 1).Replace('\','/'); sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); size = $file.Length }
        }
    }
    $metadata = [ordered]@{ schema = 1; runtimeContract = 1; id = $id; version = $part.version; paths = $part.paths; files = $files }
    $json = $metadata | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText((Join-Path $component 'component.json'), $json)
    [IO.File]::WriteAllText((Join-Path $receipts ($id + '-' + $part.version + '.json')), $json)
    $filename = 'ZAICODE-' + $id + '-' + $part.version + '.zip'
    $archive = Join-Path $OutputDirectory $filename
    [IO.Compression.ZipFile]::CreateFromDirectory($component, $archive, [IO.Compression.CompressionLevel]::Optimal, $false)
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    $part['sha256'] = $hash
    $part['receiptSha256'] = (Get-FileHash -LiteralPath (Join-Path $receipts ($id + '-' + $part.version + '.json')) -Algorithm SHA256).Hash.ToLowerInvariant()
    $artifacts += [ordered]@{ id = $id; version = $part.version; url = ('https://github.com/vacterro/zaicode/releases/download/zaicode-v' + $Version + '/' + $filename); sha256 = $hash; size = (Get-Item -LiteralPath $archive).Length }
}
$seed = [ordered]@{ schema = 1; runtimeContract = 1; channel = 'stable'; version = $Version; productHead = $productHead; components = $parts }
[IO.File]::WriteAllText((Join-Path $install 'seed-state.json'), ($seed | ConvertTo-Json -Depth 12))
$manifest = [ordered]@{ schema = 1; product = 'zaicode'; approved = $false; channel = 'stable'; runtimeContract = 1; version = $Version; productHead = $productHead; builtAt = [DateTime]::UtcNow.ToString('o'); windows = @('Windows 10 x64', 'Windows 11 x64'); components = $artifacts }
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'stable.json'), ($manifest | ConvertTo-Json -Depth 10))
$installer = Join-Path $OutputDirectory ('ZAICODE-Setup-' + $Version + '.exe')
# NSIS's source reader has a MAX_PATH limit even when the build checkout uses
# long paths. A temporary developer-side drive alias avoids changing payloads.
$usedDrives = @([IO.Directory]::GetLogicalDrives() | ForEach-Object { $_.Substring(0,1) })
$drive = @('Z','Y','X','W','U','T','S','R','Q','P','O','N' | Where-Object { $_ -notin $usedDrives })[0]
if (-not $drive) { throw 'No free temporary build drive is available.' }
$subst = Join-Path $env:SystemRoot 'System32/subst.exe'
& $subst ($drive + ':') $payload
if ($LASTEXITCODE -ne 0) { throw 'Temporary NSIS source mapping failed.' }
try {
    & $Makensis ('/DVERSION=' + $Version) ('/DPAYLOAD=' + $drive + ':\') ('/DOUTPUT=' + $installer) (Join-Path $PSScriptRoot 'ZAICODE.nsi')
    if ($LASTEXITCODE -ne 0) { throw 'Primary installer build failed.' }
} finally { & $subst ($drive + ':') /D }
$metadata = [ordered]@{ version = $Version; channel = 'stable'; productHead = $productHead; builtAt = $manifest.builtAt; installer = (Split-Path -Leaf $installer); size = (Get-Item -LiteralPath $installer).Length; sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant(); components = $parts; sources = $lock; publication = 'LOCAL_ONLY_NOT_PROMOTED'; freshWindows = 'OPERATOR_REQUIRED' }
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'release-metadata.json'), ($metadata | ConvertTo-Json -Depth 14))
Write-Output $installer
