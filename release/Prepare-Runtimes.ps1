param([Parameter(Mandatory=$true)][string]$Cache, [Parameter(Mandatory=$true)][string]$RouterArchive)
$ErrorActionPreference = 'Stop'
$lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-lock.json') -Raw | ConvertFrom-Json
[IO.Directory]::CreateDirectory($Cache) | Out-Null
function Fetch-Verified([string]$Url, [string]$Path, [string]$Hash) {
    if (-not (Test-Path -LiteralPath $Path)) { Invoke-WebRequest -Uri $Url -OutFile ($Path + '.download'); Move-Item -LiteralPath ($Path + '.download') -Destination $Path }
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) { throw "Runtime digest mismatch: $Path" }
}
Fetch-Verified $lock.python.url (Join-Path $Cache 'python.zip') $lock.python.sha256
Fetch-Verified $lock.git.url (Join-Path $Cache 'git-portable.7z.exe') $lock.git.sha256
if ((Get-FileHash -LiteralPath $RouterArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.router.sha256) { throw 'Unapproved router archive.' }
Copy-Item -LiteralPath $RouterArchive -Destination (Join-Path $Cache 'router.tgz')
$wheels = @()
foreach ($wheel in $lock.pythonWheels) {
    $metadata = Invoke-RestMethod ('https://pypi.org/pypi/' + $wheel.name + '/' + $wheel.version + '/json')
    $asset = @($metadata.urls | Where-Object { $_.filename.EndsWith($wheel.wheelPattern) })
    if ($asset.Count -ne 1 -or ([Uri]$asset[0].url).Host -ne 'files.pythonhosted.org') { throw 'Pinned wheel is ambiguous or unavailable.' }
    Fetch-Verified $asset[0].url (Join-Path $Cache $asset[0].filename) $asset[0].digests.sha256
    $wheels += @{ name = $wheel.name; version = $wheel.version; filename = $asset[0].filename; url = $asset[0].url; sha256 = $asset[0].digests.sha256 }
}
$wheels | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Cache 'wheel-lock.json') -Encoding UTF8
Write-Output 'Private runtime archives verified.'
