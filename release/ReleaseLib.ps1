# Windows PowerShell 5.1 is part of supported Windows; no developer tools are used.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$script:StableManifest = 'https://github.com/vacterro/zaicode/releases/latest/download/stable.json'
$script:ComponentIds = @('app', 'saipen', 'saimail', 'router')

function Get-ReleaseSha256([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try { return (($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '') }
        finally { $stream.Dispose() }
    } finally { $algorithm.Dispose() }
}

function Write-ReleaseJson($Value, [string]$Path) {
    $parent = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.new'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, ($Path + '.backup')); [IO.File]::Delete($Path + '.backup') }
    else { [IO.File]::Move($temporary, $Path) }
}

function Read-ReleaseJson([string]$Path) {
    [IO.File]::ReadAllText($Path) | ConvertFrom-Json
}

function Get-ReleaseChildPath([string]$Root, [string]$Relative) {
    if (-not $Relative -or $Relative -match '(^[\\/]|:|(^|[\\/])\.\.([\\/]|$))') { throw "Invalid payload path: $Relative" }
    foreach ($segment in ($Relative -split '[\\/]' | Where-Object { $_ })) {
        if ($segment -eq '.' -or $segment -ne $segment.TrimEnd(' ', '.') -or $segment -match '^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)') { throw 'Unsafe Windows payload path.' }
    }
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $result = [IO.Path]::GetFullPath((Join-Path $rootPath $Relative))
    if (-not $result.StartsWith($rootPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Payload escapes its root.' }
    return $result
}

function Assert-ReleaseArtifactUrl([string]$Url, [bool]$TestChannel = $false) {
    $uri = [Uri]$Url
    if ($TestChannel -and $uri.Scheme -eq 'http' -and $uri.Host -eq '127.0.0.1' -and $uri.AbsolutePath.StartsWith('/releases/')) { return }
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'github.com' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
        $uri.AbsolutePath -notmatch '^/vacterro/zaicode/releases/download/zaicode-v[0-9][A-Za-z0-9._-]*/[A-Za-z0-9._-]+\.zip$') {
        throw "Untrusted release artifact: $Url"
    }
}

function Assert-ReleaseManifest($Manifest, [string]$Channel = 'stable') {
    if ($Channel -notin @('stable', 'test') -or $Manifest.schema -ne 1 -or $Manifest.product -ne 'zaicode' -or
        $Manifest.channel -ne $Channel -or $Manifest.approved -ne $true -or $Manifest.runtimeContract -ne 1 -or
        $Manifest.version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw 'Release identity or channel verification failed.' }
    $ids = @()
    foreach ($part in $Manifest.components) {
        if ($part.id -notin $script:ComponentIds -or $ids -contains $part.id -or $part.version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$' -or
            $part.sha256 -notmatch '^[a-f0-9]{64}$' -or [long]$part.size -le 0 -or [long]$part.size -gt 8GB) { throw 'Invalid component manifest.' }
        Assert-ReleaseArtifactUrl $part.url ($Channel -eq 'test')
        $ids += $part.id
    }
    if (@($script:ComponentIds | Where-Object { $_ -notin $ids }).Count) { throw 'Required component missing from manifest.' }
}

function Get-ReleaseDownload([string]$Url, [string]$Destination, [bool]$TestChannel = $false, [long]$MaximumBytes = 8GB) {
    # Redirects remain TLS protected and limited to GitHub's release asset hosts.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $current = [Uri]$Url
    for ($redirect = 0; $redirect -lt 8; $redirect++) {
        $test = $TestChannel -and $current.Scheme -eq 'http' -and $current.Host -eq '127.0.0.1'
        if (-not $test -and ($current.Scheme -ne 'https' -or $current.Host -notin @('github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'))) { throw 'Untrusted download redirect.' }
        $request = [Net.HttpWebRequest]::Create($current)
        $request.AllowAutoRedirect = $false
        $request.Timeout = 30000
        $request.ReadWriteTimeout = 60000
        $request.UserAgent = 'ZAICODE-Release/1'
        $response = $request.GetResponse()
        try {
            if ([int]$response.StatusCode -in @(301, 302, 303, 307, 308)) {
                $current = New-Object Uri($current, $response.Headers['Location'])
                continue
            }
            if ($response.ContentLength -gt $MaximumBytes) { throw 'Download exceeds the verified release size limit.' }
            $stream = [IO.File]::Create($Destination)
            $inputStream = $response.GetResponseStream()
            try {
                $buffer = New-Object byte[] 65536
                $total = 0L
                while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $total += $count
                    if ($total -gt $MaximumBytes) { throw 'Download exceeds the verified release size limit.' }
                    $stream.Write($buffer, 0, $count)
                }
            } finally { $inputStream.Dispose(); $stream.Dispose() }
            return
        } finally { $response.Dispose() }
    }
    throw 'Too many download redirects.'
}

function Assert-ReleaseDigest([string]$Path, [string]$Sha256, [long]$Size) {
    if ((Get-Item -LiteralPath $Path).Length -ne $Size -or (Get-ReleaseSha256 $Path) -ne $Sha256) {
        throw 'Artifact size or SHA-256 verification failed.'
    }
}

function Expand-ReleaseArchive([string]$Archive, [string]$Destination) {
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $total = 0L
    try {
        foreach ($entry in $zip.Entries) {
            $path = Get-ReleaseChildPath $Destination $entry.FullName
            if (-not $seen.Add($path)) { throw 'Duplicate archive path.' }
            if (($entry.ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000) { throw 'Archive symlinks are refused.' }
            $total += $entry.Length
            if ($total -gt 16GB -or $entry.Length -gt 2GB) { throw 'Archive exceeds release limits.' }
            if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($path) | Out-Null; continue }
            [IO.Directory]::CreateDirectory((Split-Path -Parent $path)) | Out-Null
            $source = $entry.Open()
            $target = [IO.File]::Open($path, [IO.FileMode]::CreateNew)
            try { $source.CopyTo($target) } finally { $source.Dispose(); $target.Dispose() }
        }
    } finally { $zip.Dispose() }
}

function Assert-ReleasePayload([string]$Directory, $Expected) {
    $metadata = Read-ReleaseJson (Join-Path $Directory 'component.json')
    if ($metadata.schema -ne 1 -or $metadata.id -ne $Expected.id -or $metadata.version -ne $Expected.version -or $metadata.runtimeContract -ne 1) { throw 'Payload component identity mismatch.' }
    $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $metadata.files) {
        $path = Get-ReleaseChildPath $Directory $file.path
        if (-not $seen.Add($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Payload inventory mismatch.' }
        Assert-ReleaseDigest $path $file.sha256 $file.size
    }
    $actual = @(Get-ChildItem -LiteralPath $Directory -File -Recurse | Where-Object { $_.FullName -ne (Join-Path $Directory 'component.json') })
    if ($actual.Count -ne $seen.Count) { throw 'Unlisted files in payload.' }
    foreach ($property in $metadata.paths.PSObject.Properties) {
        $null = Get-ReleaseChildPath $Directory $property.Value
        if ($property.Value -notmatch '^(versions|managed)/[A-Za-z0-9._/-]+$') { throw 'Invalid managed activation path.' }
    }
    return $metadata
}

function Assert-InstalledRelease([string]$InstallRoot, $State) {
    if ($State.schema -ne 1 -or $State.runtimeContract -ne 1 -or $State.channel -notin @('stable', 'test')) { throw 'Invalid installed release state.' }
    foreach ($id in $script:ComponentIds) {
        $part = $State.components.PSObject.Properties[$id].Value
        if ($part.version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$') { throw 'Invalid installed component revision.' }
        $receipt = Join-Path $InstallRoot ('install/verified-payloads/' + $id + '-' + $part.version + '.json')
        if ((Get-ReleaseSha256 $receipt) -ne $part.receiptSha256) { throw 'Installed component receipt mismatch.' }
        $metadata = Read-ReleaseJson $receipt
        if ($metadata.id -ne $id -or $metadata.version -ne $part.version) { throw 'Installed component identity mismatch.' }
        foreach ($file in $metadata.files) { Assert-ReleaseDigest (Get-ReleaseChildPath $InstallRoot $file.path) $file.sha256 $file.size }
    }
}

function Get-ReleaseStorage {
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    return Join-Path $local 'ZAICODE'
}

function Enter-ReleaseLock([string]$InstallRoot) {
    [IO.Directory]::CreateDirectory((Join-Path $InstallRoot 'install')) | Out-Null
    return [IO.File]::Open((Join-Path $InstallRoot 'install/release.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
}

function Invoke-ReleaseUpdate([string]$InstallRoot, [string[]]$Components = @('app', 'saipen', 'saimail', 'router'), [switch]$Check) {
    $lock = Enter-ReleaseLock $InstallRoot
    try {
        $statePath = Join-Path $InstallRoot 'install/install-state.json'
        $state = Read-ReleaseJson $statePath
        $channel = $state.channel
        $manifestUrl = $script:StableManifest
        if ($channel -eq 'test') {
            $manifestUrl = $state.testManifestUrl
            $uri = [Uri]$manifestUrl
            if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1' -or $uri.AbsolutePath -ne '/stable.json') { throw 'Invalid controlled test feed.' }
        } elseif ($channel -ne 'stable') { throw 'Unsupported release channel.' }
        $staging = Join-Path (Get-ReleaseStorage) ('staging/' + [Guid]::NewGuid().ToString('N').Substring(0,8))
        [IO.Directory]::CreateDirectory($staging) | Out-Null
        $manifestPath = Join-Path $staging 'manifest.json'
        $records = @()
        try {
            Get-ReleaseDownload $manifestUrl $manifestPath ($channel -eq 'test') 1MB
            if ((Get-Item -LiteralPath $manifestPath).Length -gt 1MB) { throw 'Release manifest exceeds size limit.' }
            $manifest = Read-ReleaseJson $manifestPath
            Assert-ReleaseManifest $manifest $channel
            if ([Version]($manifest.version -split '-')[0] -lt [Version]($state.version -split '-')[0]) { throw 'Stable manifest is older than the installed release.' }
            $next = $state | ConvertTo-Json -Depth 20 | ConvertFrom-Json
            $pendingPath = Join-Path $InstallRoot 'install/pending-state.json'
            if (Test-Path -LiteralPath $pendingPath) { $next = Read-ReleaseJson $pendingPath }
            $changed = $false
            foreach ($part in $manifest.components) {
                if ($part.id -notin $Components) { continue }
                $current = $next.components.PSObject.Properties[$part.id].Value
                $record = [ordered]@{ id = $part.id; title = $part.id; version = $current.version; remote = $part.version; status = 'current'; detail = 'Current verified release.' }
                if ($current.version -ne $part.version) {
                    $record.status = 'available'; $record.detail = 'Verified stable release is available.'
                    if (-not $Check) {
                        $archive = Join-Path $staging ($part.id + '.zip')
                        Get-ReleaseDownload $part.url $archive ($channel -eq 'test') $part.size
                        Assert-ReleaseDigest $archive $part.sha256 $part.size
                        $expanded = Join-Path $staging $part.id
                        Expand-ReleaseArchive $archive $expanded
                        $metadata = Assert-ReleasePayload $expanded $part
                        # Installations can live on another drive. Verify the copied tree on
                        # that drive, then rename there; a cross-volume move is not atomic.
                        $localStage = Get-ReleaseChildPath $InstallRoot ('stage/' + [Guid]::NewGuid().ToString('N').Substring(0,8))
                        [IO.Directory]::CreateDirectory((Split-Path -Parent $localStage)) | Out-Null
                        Copy-Item -LiteralPath $expanded -Destination $localStage -Recurse
                        $metadata = Assert-ReleasePayload $localStage $part
                        foreach ($property in $metadata.paths.PSObject.Properties) {
                            $source = Get-ReleaseChildPath $localStage $property.Value
                            $target = Get-ReleaseChildPath $InstallRoot $property.Value
                            if (Test-Path -LiteralPath $target) {
                                # Retry may find a verified orphan from an earlier partial staging run.
                                $prefix = $property.Value.TrimEnd('/') + '/'
                                $expectedFiles = @($metadata.files | Where-Object { $_.path.StartsWith($prefix) })
                                foreach ($file in $expectedFiles) { Assert-ReleaseDigest (Get-ReleaseChildPath $InstallRoot $file.path) $file.sha256 $file.size }
                                if (@(Get-ChildItem -LiteralPath $target -File -Recurse).Count -ne $expectedFiles.Count) { throw 'Existing immutable revision differs from this release.' }
                            } else {
                                [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
                                [IO.Directory]::Move($source, $target)
                            }
                        }
                        $receipt = Join-Path $InstallRoot ('install/verified-payloads/' + $part.id + '-' + $part.version + '.json')
                        Write-ReleaseJson $metadata $receipt
                        $next.components.PSObject.Properties[$part.id].Value = [pscustomobject]@{ version = $part.version; sha256 = $part.sha256; receiptSha256 = (Get-ReleaseSha256 $receipt); paths = $metadata.paths }
                        if ($part.id -eq 'app') { $next.version = $manifest.version }
                        $changed = $true
                        $record.status = 'updated'; $record.detail = 'Verified and staged. Activates on the next launch.'
                    }
                }
                $records += [pscustomobject]$record
            }
            if ($changed) { Write-ReleaseJson $next $pendingPath }
            return [pscustomobject]@{ schema = 1; managed = $true; components = $records; log = $manifestPath }
        } catch {
            # Keep the failed staging directory for diagnostics; it can never activate.
            Write-ReleaseJson @{ error = $_.Exception.Message; at = [DateTime]::UtcNow.ToString('o') } (Join-Path $staging 'REJECTED.json')
            throw
        }
    } finally { $lock.Dispose() }
}

function Initialize-ReleaseInstall([string]$InstallRoot) {
    $lock = Enter-ReleaseLock $InstallRoot
    try {
        $seed = Read-ReleaseJson (Join-Path $InstallRoot 'install/seed-state.json')
        Assert-InstalledRelease $InstallRoot $seed
        $path = Join-Path $InstallRoot 'install/install-state.json'
        if (Test-Path -LiteralPath $path) { Write-ReleaseJson $seed (Join-Path $InstallRoot 'install/pending-state.json') }
        else { Write-ReleaseJson $seed $path }
    } finally { $lock.Dispose() }
}

function Activate-ReleaseInstall([string]$InstallRoot) {
    $lock = Enter-ReleaseLock $InstallRoot
    try {
        $pending = Join-Path $InstallRoot 'install/pending-state.json'
        if (-not (Test-Path -LiteralPath $pending)) { return }
        $candidate = Read-ReleaseJson $pending
        Assert-InstalledRelease $InstallRoot $candidate
        foreach ($part in $candidate.components.PSObject.Properties) {
            foreach ($path in $part.Value.paths.PSObject.Properties) {
                if (-not (Test-Path -LiteralPath (Get-ReleaseChildPath $InstallRoot $path.Value))) { throw 'Staged component is missing.' }
            }
        }
        $current = Join-Path $InstallRoot 'install/install-state.json'
        Write-ReleaseJson (Read-ReleaseJson $current) (Join-Path $InstallRoot 'install/previous-state.json')
        Write-ReleaseJson $candidate $current
        [IO.File]::Delete($pending)
        Write-ReleaseJson @{ at = [DateTime]::UtcNow.ToString('o') } (Join-Path $InstallRoot 'install/activation-pending.json')
    } finally { $lock.Dispose() }
}

function Undo-ReleaseActivation([string]$InstallRoot) {
    $lock = Enter-ReleaseLock $InstallRoot
    try {
        $previous = Join-Path $InstallRoot 'install/previous-state.json'
        if (Test-Path -LiteralPath $previous) { Write-ReleaseJson (Read-ReleaseJson $previous) (Join-Path $InstallRoot 'install/install-state.json') }
        [IO.File]::Delete((Join-Path $InstallRoot 'install/activation-pending.json'))
    } finally { $lock.Dispose() }
}
