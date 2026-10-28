param([string]$ProjectRoot)

$ErrorActionPreference = "Stop"
$projectRootWasSet = $PSBoundParameters.ContainsKey("ProjectRoot")

function Resolve-ProjectRoot([string]$explicitRoot, [bool]$explicitSet) {
    $start = (Get-Location).Path
    if ($explicitSet) {
        if ([string]::IsNullOrEmpty($explicitRoot)) {
            throw "explicit project root requires a non-empty path"
        }
        try { $root = (Resolve-Path -LiteralPath $explicitRoot -ErrorAction Stop).Path }
        catch { throw "explicit project root is not a directory: $explicitRoot" }
        if (-not (Test-Path -LiteralPath (Join-Path $root ".saipen") -PathType Container)) {
            throw "explicit project root has no .saipen: $root"
        }
        return $root
    }

    if (Get-Command git -ErrorAction SilentlyContinue) {
        $top = & git -C $start rev-parse --show-toplevel 2>$null
        $topStatus = $LASTEXITCODE
        if ($topStatus -eq 0) {
            $common = & git -C $start rev-parse --path-format=absolute --git-common-dir 2>$null
            if ($LASTEXITCODE -ne 0) { throw "cannot resolve Git common directory from $start" }
            $common = [string]($common | Select-Object -First 1)
            $top = [string]($top | Select-Object -First 1)
            $common = (Resolve-Path -LiteralPath $common -ErrorAction Stop).Path
            $commonParent = Split-Path -Parent $common
            $root = if ((Split-Path -Leaf $common).ToLowerInvariant() -eq ".git" -and
                (Test-Path -LiteralPath (Join-Path $commonParent ".saipen") -PathType Container)) {
                $commonParent
            } else { $top }
            $root = (Resolve-Path -LiteralPath $root -ErrorAction Stop).Path
            if (-not (Test-Path -LiteralPath (Join-Path $root ".saipen") -PathType Container)) {
                throw "Git project root owns no .saipen: $root; pass -ProjectRoot PATH to export another project"
            }
            return $root
        }
    }

    $cursor = [System.IO.DirectoryInfo]$start
    while ($null -ne $cursor) {
        if (Test-Path -LiteralPath (Join-Path $cursor.FullName ".saipen") -PathType Container) {
            return $cursor.FullName
        }
        $cursor = $cursor.Parent
    }
    throw "no owning .saipen found from $start"
}

try {
    $ownerRoot = Resolve-ProjectRoot $ProjectRoot $projectRootWasSet
} catch {
    Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
$saipenDir = Join-Path -Path $ownerRoot -ChildPath ".saipen"

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$baseName = "saipen_export_$timestamp"
$zipName = "$baseName.zip"
$zipPath = Join-Path -Path $ownerRoot -ChildPath $zipName

# T-1017: collision-safe export naming. Two exports within one second MUST
# both survive -- never silently overwrite a prior backup, so pick the next
# free name with a monotonic suffix instead of clobbering.
$suffix = 1
while (Test-Path -LiteralPath $zipPath) {
    $zipName = "${baseName}_${suffix}.zip"
    $zipPath = Join-Path -Path $ownerRoot -ChildPath $zipName
    $suffix++
}

# Build through a temporary artifact in the same directory, then atomically
# promote -- a failed export never leaves a partial-looking backup.
$tmpPath = Join-Path -Path $ownerRoot -ChildPath ".${baseName}.tmp.$PID.zip"
Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue

Write-Host "saipen STATE-ONLY exporter (NO implementation files)"
Write-Host "------------------------------------------------------------"
Write-Host "Archiving: $saipenDir"
try {
    # Distribution authority is separate from source authority. Exact bodies
    # below .saipen/quarantine stay local; their safe digest/status records
    # under .saipen/intake/distribution remain in the archive.
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stream = [System.IO.File]::Open(
        $tmpPath,
        [System.IO.FileMode]::CreateNew,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    try {
        $archive = [System.IO.Compression.ZipArchive]::new(
            $stream,
            [System.IO.Compression.ZipArchiveMode]::Create,
            $false
        )
        try {
            $rootPrefix = $ownerRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) +
                [System.IO.Path]::DirectorySeparatorChar
            $quarantinePrefix = (Join-Path $saipenDir "quarantine").TrimEnd(
                [System.IO.Path]::DirectorySeparatorChar
            ) + [System.IO.Path]::DirectorySeparatorChar
            foreach ($file in Get-ChildItem -LiteralPath $saipenDir -Recurse -File) {
                if ($file.FullName.StartsWith(
                    $quarantinePrefix,
                    [System.StringComparison]::OrdinalIgnoreCase
                )) { continue }
                $entryName = $file.FullName.Substring($rootPrefix.Length).Replace('\', '/')
                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $archive,
                    $file.FullName,
                    $entryName,
                    [System.IO.Compression.CompressionLevel]::Optimal
                ) | Out-Null
            }
        } finally {
            $archive.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
} catch {
    Write-Host "FAILED: $_" -ForegroundColor Red
    Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
    exit 1
}
if (-not (Test-Path $tmpPath)) {
    Write-Host "FAILED: archive not found at $tmpPath after Compress-Archive reported success" -ForegroundColor Red
    Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
    exit 1
}
try {
    Move-Item -LiteralPath $tmpPath -Destination $zipPath -Force -ErrorAction Stop
} catch {
    Write-Host "FAILED: could not promote temporary archive to ${zipPath}: $_" -ForegroundColor Red
    Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue
    exit 1
}
Write-Host "Done. Export saved to: $zipPath"
Write-Host "------------------------------------------------------------"
