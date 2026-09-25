# ZAICODE installer library: shared by Install-ZAICODE.ps1 and ZAICODE-Doctor.ps1.
# Windows PowerShell 5.1 compatible on purpose (the one every Windows 10/11 has).
# Dot-source it; it defines functions and the install layout, runs nothing.

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$script:ZaicodeDefaults = @{
  ZaicodeRepo  = 'https://github.com/vacterro/zaicode.git'
  SaipenRepo   = 'https://github.com/vacterro/saipen.git'
  SaimailRepo  = 'https://github.com/vacterro/saimail.git'
  AppBranch    = 'main'
  RootBranch   = 'workspace'
  NodeVersion  = '24.14.0'
  PnpmVersion  = '10.33.2'
  PythonSeries = '3.13.'
  PythonPinned = '3.13.15'
  MinGitPinned = 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/MinGit-2.55.0.5-64-bit.zip'
}

# ---------------------------------------------------------------------------
# Layout: every path the installer and the doctor agree on.
# ---------------------------------------------------------------------------

function Get-ZaicodeLayout([string]$Root) {
  $root = [IO.Path]::GetFullPath($Root)
  return [ordered]@{
    Root         = $root
    Zcode        = Join-Path $root 'zcode'
    Saipen       = Join-Path $root 'saipen'
    Saimail      = Join-Path $root 'saimail'
    Venv         = Join-Path $root '.venv'
    VenvPython   = Join-Path $root '.venv\Scripts\python.exe'
    SaimailExe   = Join-Path $root '.venv\Scripts\saimail-local.exe'
    Tools        = Join-Path $root '.tools'
    GitDir       = Join-Path $root '.tools\git'
    NodeDir      = Join-Path $root '.tools\node'
    PythonDir    = Join-Path $root '.tools\python'
    PnpmDir      = Join-Path $root '.tools\pnpm10'
    RouterDir    = Join-Path $root '.tools\router'
    Launcher     = Join-Path $root 'ZAICODE.exe'
    LauncherSrc  = Join-Path $root 'tools\launcher\build.cmd'
    AppExe       = Join-Path $root 'zcode\packages\desktop\dist\win-unpacked\ZAICODE.exe'
    StagedExe    = Join-Path $root 'zcode\packages\desktop\dist-next\win-unpacked\ZAICODE.exe'
    Logs         = Join-Path $root 'install\logs'
    Report       = Join-Path $root 'install\install-report.json'
  }
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

$script:ZaicodeLogFile = $null

function Start-ZaicodeLog([string]$Dir, [string]$Name) {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $script:ZaicodeLogFile = Join-Path $Dir "$Name-$stamp.log"
  return $script:ZaicodeLogFile
}

function Write-ZaicodeLog([string]$Message, [string]$Color = 'Gray') {
  $line = '{0}  {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message
  Write-Host $line -ForegroundColor $Color
  if ($script:ZaicodeLogFile) { Add-Content -LiteralPath $script:ZaicodeLogFile -Value $line -Encoding UTF8 }
}

# ---------------------------------------------------------------------------
# Processes: every external command runs through here, output to the log.
# ---------------------------------------------------------------------------

function Invoke-ZaicodeCommand {
  param(
    [Parameter(Mandatory)] [string]$File,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = (Get-Location).Path,
    [hashtable]$Environment = @{},
    [switch]$AllowFailure
  )
  $saved = @{}
  foreach ($key in $Environment.Keys) {
    $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    [Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], 'Process')
  }
  # Windows PowerShell 5.1 turns a native command's stderr line into a terminating
  # error under 'Stop' when it is redirected; git and npm write progress there.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location -LiteralPath $WorkingDirectory
  try {
    Write-ZaicodeLog ("> {0} {1}" -f $File, ($Arguments -join ' ')) 'DarkGray'
    $output = & $File @Arguments 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    if ($script:ZaicodeLogFile -and $output) { Add-Content -LiteralPath $script:ZaicodeLogFile -Value $output -Encoding UTF8 }
    if ($code -ne 0 -and -not $AllowFailure) {
      $tail = ($output | Select-Object -Last 12) -join "`n"
      throw ("{0} exited with {1}`n{2}" -f $File, $code, $tail)
    }
    return [pscustomobject]@{ Code = $code; Output = ($output -join "`n") }
  } finally {
    Pop-Location
    $ErrorActionPreference = $previousPreference
    foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
  }
}

function Invoke-ZaicodeDownload([string]$Url, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path (Split-Path $Destination) | Out-Null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Write-ZaicodeLog "download $Url"
      Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 600
      if ((Get-Item -LiteralPath $Destination).Length -gt 0) { return }
    } catch {
      Write-ZaicodeLog ("download attempt {0} failed: {1}" -f $attempt, $_.Exception.Message) 'Yellow'
      Start-Sleep -Seconds (3 * $attempt)
    }
  }
  throw "Could not download $Url (network or proxy). Check the connection and run the installer again."
}

function Expand-ZaicodeZip([string]$Zip, [string]$Destination) {
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Destination)
}

# ---------------------------------------------------------------------------
# Prerequisites: the machine's own copy when it fits, else a portable one in .tools
# ---------------------------------------------------------------------------

function Find-ZaicodeGit($Layout) {
  $portable = Join-Path $Layout.GitDir 'cmd\git.exe'
  if (Test-Path -LiteralPath $portable) { return $portable }
  $command = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

function Install-ZaicodeGit($Layout) {
  $url = $script:ZaicodeDefaults.MinGitPinned
  try {
    $release = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -TimeoutSec 30
    $asset = $release.assets | Where-Object { $_.name -match '^MinGit-[\d.]+-64-bit\.zip$' } | Select-Object -First 1
    if ($asset) { $url = $asset.browser_download_url }
  } catch { Write-ZaicodeLog 'GitHub API unavailable: using the pinned MinGit' 'Yellow' }
  $zip = Join-Path $Layout.Tools 'downloads\mingit.zip'
  Invoke-ZaicodeDownload $url $zip
  Expand-ZaicodeZip $zip $Layout.GitDir
  return (Join-Path $Layout.GitDir 'cmd\git.exe')
}

function Get-ZaicodeNodeMajor([string]$Node) {
  try {
    $version = (& $Node --version 2>$null) -replace '^v', ''
    return [int]($version.Split('.')[0])
  } catch { return 0 }
}

function Find-ZaicodeNode($Layout) {
  $portable = Join-Path $Layout.NodeDir 'node.exe'
  if ((Test-Path -LiteralPath $portable) -and (Get-ZaicodeNodeMajor $portable) -ge 24) { return $portable }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command -and (Get-ZaicodeNodeMajor $command.Source) -ge 24) { return $command.Source }
  return $null
}

function Install-ZaicodeNode($Layout) {
  $version = $script:ZaicodeDefaults.NodeVersion
  $zip = Join-Path $Layout.Tools "downloads\node-v$version.zip"
  Invoke-ZaicodeDownload "https://nodejs.org/dist/v$version/node-v$version-win-x64.zip" $zip
  $unpacked = Join-Path $Layout.Tools 'downloads\node-unpacked'
  Expand-ZaicodeZip $zip $unpacked
  if (Test-Path -LiteralPath $Layout.NodeDir) { Remove-Item -LiteralPath $Layout.NodeDir -Recurse -Force }
  Move-Item -LiteralPath (Join-Path $unpacked "node-v$version-win-x64") -Destination $Layout.NodeDir
  Remove-Item -LiteralPath $unpacked -Recurse -Force
  return (Join-Path $Layout.NodeDir 'node.exe')
}

function Get-ZaicodePythonVersion([string]$Python) {
  try {
    $text = & $Python -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    return [version]$text
  } catch { return [version]'0.0' }
}

function Find-ZaicodePython($Layout) {
  $portable = Join-Path $Layout.PythonDir 'tools\python.exe'
  if (Test-Path -LiteralPath $portable) { return $portable }
  foreach ($name in @('python.exe', 'python3.exe')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    # The Microsoft Store stub under WindowsApps answers nothing useful.
    if ($command -and $command.Source -notmatch 'WindowsApps' -and (Get-ZaicodePythonVersion $command.Source) -ge [version]'3.11') {
      return $command.Source
    }
  }
  return $null
}

function Install-ZaicodePython($Layout) {
  $version = $script:ZaicodeDefaults.PythonPinned
  try {
    $index = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.nuget.org/v3-flatcontainer/python/index.json' -TimeoutSec 30
    $latest = $index.versions | Where-Object { $_ -like "$($script:ZaicodeDefaults.PythonSeries)*" -and $_ -notmatch '-' } | Select-Object -Last 1
    if ($latest) { $version = $latest }
  } catch { Write-ZaicodeLog 'NuGet index unavailable: using the pinned Python' 'Yellow' }
  $package = Join-Path $Layout.Tools "downloads\python-$version.zip"
  Invoke-ZaicodeDownload "https://api.nuget.org/v3-flatcontainer/python/$version/python.$version.nupkg" $package
  Expand-ZaicodeZip $package $Layout.PythonDir
  return (Join-Path $Layout.PythonDir 'tools\python.exe')
}

function Get-ZaicodePnpm($Layout) {
  return (Join-Path $Layout.PnpmDir 'node_modules\.bin\pnpm.cmd')
}

function Install-ZaicodePnpm($Layout, [string]$Node) {
  $npm = Join-Path (Split-Path $Node) 'npm.cmd'
  New-Item -ItemType Directory -Force -Path $Layout.PnpmDir | Out-Null
  Invoke-ZaicodeCommand -File $npm -Arguments @('install', '--prefix', $Layout.PnpmDir, "pnpm@$($script:ZaicodeDefaults.PnpmVersion)", '--no-audit', '--no-fund') -Environment @{ PATH = (Get-ZaicodePath $Layout $Node) } | Out-Null
  return (Get-ZaicodePnpm $Layout)
}

# PATH for build steps: this install's tools first, then the machine's.
function Get-ZaicodePath($Layout, [string]$Node) {
  $parts = @()
  if ($Node) { $parts += (Split-Path $Node) }
  foreach ($dir in @((Join-Path $Layout.PnpmDir 'node_modules\.bin'), (Join-Path $Layout.GitDir 'cmd'), (Join-Path $Layout.Venv 'Scripts'))) {
    if (Test-Path -LiteralPath $dir) { $parts += $dir }
  }
  return (($parts + @($env:PATH)) -join ';')
}

# ---------------------------------------------------------------------------
# Repositories
# ---------------------------------------------------------------------------

function Test-ZaicodeRepo([string]$Git, [string]$Dir) {
  if (-not (Test-Path -LiteralPath (Join-Path $Dir '.git'))) { return $false }
  $result = Invoke-ZaicodeCommand -File $Git -Arguments @('-C', $Dir, 'rev-parse', '--verify', 'HEAD') -AllowFailure
  return ($result.Code -eq 0)
}

# Clones `$Url` at `$Branch` into `$Dir`, or fast-forwards an existing clone. Local edits are kept (warned).
function Sync-ZaicodeRepo {
  param([string]$Git, [string]$Url, [string]$Branch, [string]$Dir, [string[]]$Exclude = @(), [string[]]$Owned = @('install'))
  if (Test-ZaicodeRepo $Git $Dir) {
    Invoke-ZaicodeCommand -File $Git -Arguments @('-C', $Dir, 'fetch', '--quiet', 'origin', $Branch) | Out-Null
    $pull = Invoke-ZaicodeCommand -File $Git -Arguments @('-C', $Dir, 'merge', '--ff-only', '--quiet', "origin/$Branch") -AllowFailure
    if ($pull.Code -ne 0) { Write-ZaicodeLog "$Dir has local changes; kept them (not updated)" 'Yellow' }
    return
  }
  # The installer's own folders may already be there (tools come first); anything else is someone's data.
  if ((Test-Path -LiteralPath $Dir) -and (Get-ChildItem -LiteralPath $Dir -Force | Where-Object { $Owned -notcontains $_.Name } | Select-Object -First 1)) {
    throw "$Dir exists and is not a clone of $Url. Move it away or choose another -InstallDir."
  }
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  Invoke-ZaicodeCommand -File $Git -Arguments @('-C', $Dir, 'init', '--quiet') | Out-Null
  Invoke-ZaicodeCommand -File $Git -Arguments @('-C', $Dir, 'remote', 'add', 'origin', $Url) | Out-Null
  if ($Exclude.Count -gt 0) {
    $patterns = @('/*') + ($Exclude | ForEach-Object { "!$_" })
    Invoke-ZaicodeCommand -File $Git -Arguments (@('-C', $Dir, 'sparse-checkout', 'set', '--no-cone') + $patterns) | Out-Null
  }
  Invoke-ZaicodeCommand -File $Git -Arguments @('-C', $Dir, 'fetch', '--quiet', '--depth', '1', 'origin', $Branch) | Out-Null
  Invoke-ZaicodeCommand -File $Git -Arguments @('-C', $Dir, 'checkout', '--quiet', '-f', '-B', $Branch, "origin/$Branch") | Out-Null
  Invoke-ZaicodeCommand -File $Git -Arguments @('-C', $Dir, 'branch', '--quiet', "--set-upstream-to=origin/$Branch", $Branch) -AllowFailure | Out-Null
}

# ---------------------------------------------------------------------------
# SAIPEN and SAIMAIL
# ---------------------------------------------------------------------------

# The clone's own bin/saipen.cmd (when it has one) names its maintainer's machine;
# SAIPEN's renderer writes one for this clone. A SAIPEN release without the
# renderer gets the same bytes the renderer writes: python + tools\saipen.py.
function Set-ZaicodeSaipenLauncher($Layout, [string]$Python) {
  $renderer = Join-Path $Layout.Saipen 'bootstrap\cli_launcher.py'
  $cli = Join-Path $Layout.Saipen 'tools\saipen.py'
  $bin = Join-Path $Layout.Saipen 'bin'
  if (-not (Test-Path -LiteralPath $cli)) { throw "this SAIPEN has no tools\saipen.py" }
  if (Test-Path -LiteralPath $renderer) {
    Invoke-ZaicodeCommand -File $Python -Arguments @($renderer, '--python', $Python, '--cli', $cli, '--out-dir', $bin) | Out-Null
    return
  }
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $text = "@echo off`r`n`"$Python`" `"$cli`" %*`r`n"
  [IO.File]::WriteAllText((Join-Path $bin 'saipen.cmd'), $text, (New-Object Text.UTF8Encoding($false)))
}

function Get-ZaicodeSaipenVersion($Layout) {
  $file = Join-Path $Layout.Saipen 'VERSION'
  if (Test-Path -LiteralPath $file) { return (Get-Content -LiteralPath $file -Raw).Trim() }
  return 'unknown'
}

function Test-ZaicodeSaipenLauncher($Layout) {
  $launcher = Join-Path $Layout.Saipen 'bin\saipen.cmd'
  if (-not (Test-Path -LiteralPath $launcher)) { return 'bin\saipen.cmd is missing' }
  $text = Get-Content -LiteralPath $launcher -Raw
  $cli = Join-Path $Layout.Saipen 'tools\saipen.py'
  if ($text.IndexOf($cli, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return 'bin\saipen.cmd points at another SAIPEN copy' }
  $match = [regex]::Match($text, '"([^"]+python[^"]*\.exe)"', 'IgnoreCase')
  if (-not $match.Success -or -not (Test-Path -LiteralPath $match.Groups[1].Value)) { return 'the Python bin\saipen.cmd names is gone' }
  return $null
}

# ZAICODE's SAIMAIL surfaces call `saimail-local`; a SAIMAIL release declares it in pyproject.toml.
function Test-ZaicodeSaimailShipsCli($Layout) {
  $project = Join-Path $Layout.Saimail 'pyproject.toml'
  if (-not (Test-Path -LiteralPath $project)) { return $false }
  return ((Get-Content -LiteralPath $project -Raw) -match '(?m)^\s*saimail-local\s*=')
}

function Get-ZaicodeSaimailVersion($Layout) {
  $project = Join-Path $Layout.Saimail 'pyproject.toml'
  if (-not (Test-Path -LiteralPath $project)) { return 'unknown' }
  $match = [regex]::Match((Get-Content -LiteralPath $project -Raw), '(?m)^version\s*=\s*"([^"]+)"')
  if ($match.Success) { return $match.Groups[1].Value }
  return 'unknown'
}

function Install-ZaicodeSaimail($Layout, [string]$Python) {
  if (-not (Test-Path -LiteralPath $Layout.VenvPython)) {
    Invoke-ZaicodeCommand -File $Python -Arguments @('-m', 'venv', $Layout.Venv) | Out-Null
  }
  Invoke-ZaicodeCommand -File $Layout.VenvPython -Arguments @('-m', 'pip', 'install', '--quiet', '--upgrade', 'pip') -AllowFailure | Out-Null
  Invoke-ZaicodeCommand -File $Layout.VenvPython -Arguments @('-m', 'pip', 'install', '--quiet', '-e', "$($Layout.Saimail)[crypto]") | Out-Null
}

# ---------------------------------------------------------------------------
# App, launcher, shortcuts
# ---------------------------------------------------------------------------

function Test-ZaicodeModules($Layout) {
  return (Test-Path -LiteralPath (Join-Path $Layout.Zcode 'node_modules\.modules.yaml'))
}

# Which pnpm-lock.yaml node_modules was installed from (content, not mtime: a no-op install touches nothing).
function Get-ZaicodeLockMarker($Layout) { return (Join-Path $Layout.Zcode 'node_modules\.zaicode-lock.sha256') }

# .NET directly: Get-FileHash lives in a script module that a PowerShell 7 PSModulePath can hide from 5.1.
function Get-ZaicodeLockHash($Layout) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead((Join-Path $Layout.Zcode 'pnpm-lock.yaml'))
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
  finally { $stream.Dispose(); $sha.Dispose() }
}

function Install-ZaicodeModules($Layout, [string]$Node) {
  Invoke-ZaicodeCommand -File (Get-ZaicodePnpm $Layout) -Arguments @('install', '--frozen-lockfile') -WorkingDirectory $Layout.Zcode -Environment @{ PATH = (Get-ZaicodePath $Layout $Node); CI = '1' } | Out-Null
  Set-Content -LiteralPath (Get-ZaicodeLockMarker $Layout) -Value (Get-ZaicodeLockHash $Layout) -Encoding ASCII
}

function Install-ZaicodeRouterPackage($Layout, [string]$Node) {
  $npm = Join-Path (Split-Path $Node) 'npm.cmd'
  New-Item -ItemType Directory -Force -Path $Layout.RouterDir | Out-Null
  $result = Invoke-ZaicodeCommand -File $npm -Arguments @('install', '--prefix', $Layout.RouterDir, '9router', '--no-audit', '--no-fund') -Environment @{ PATH = (Get-ZaicodePath $Layout $Node) } -AllowFailure
  $source = Join-Path $Layout.RouterDir 'node_modules\9router'
  if ($result.Code -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $source 'app'))) { return $null }
  return $source
}

function Build-ZaicodeApp($Layout, [string]$Node) {
  $environment = @{ PATH = (Get-ZaicodePath $Layout $Node) }
  $router = Join-Path $Layout.RouterDir 'node_modules\9router'
  if (Test-Path -LiteralPath (Join-Path $router 'app')) { $environment['ZAICODE_ROUTER_PACKAGE_SRC'] = $router }
  Invoke-ZaicodeCommand -File $Node -Arguments @('scripts/bundle-zaicode.mjs') -WorkingDirectory $Layout.Zcode -Environment $environment | Out-Null
}

function Build-ZaicodeLauncher($Layout) {
  Invoke-ZaicodeCommand -File $env:ComSpec -Arguments @('/d', '/c', $Layout.LauncherSrc) -WorkingDirectory $Layout.Root | Out-Null
}

function Get-ZaicodeShortcutPaths([string]$ShortcutDir, [switch]$StartMenu) {
  $paths = @(Join-Path $ShortcutDir 'ZAICODE.lnk')
  if ($StartMenu) { $paths += (Join-Path ([Environment]::GetFolderPath('Programs')) 'ZAICODE\ZAICODE.lnk') }
  return $paths
}

function New-ZaicodeShortcut([string]$Path, [string]$Target, [string]$WorkingDirectory, [string]$Icon, [string]$Description) {
  New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($Path)
  $link.TargetPath = $Target
  $link.WorkingDirectory = $WorkingDirectory
  if ($Icon -and (Test-Path -LiteralPath $Icon)) { $link.IconLocation = "$Icon,0" }
  $link.Description = $Description
  $link.Save()
}

function Test-ZaicodeShortcut([string]$Path, [string]$Target) {
  if (-not (Test-Path -LiteralPath $Path)) { return 'missing' }
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($Path)
  if ($link.TargetPath -ne $Target) { return "points at $($link.TargetPath)" }
  if (-not (Test-Path -LiteralPath $Target)) { return 'its target is missing' }
  return $null
}

# ---------------------------------------------------------------------------
# Subscriptions: several Claude / Codex logins, each in its own home
# ---------------------------------------------------------------------------

function Get-ZaicodeAccounts {
  $homeDir = [Environment]::GetFolderPath('UserProfile')
  $accounts = @()
  foreach ($vendor in @('claude', 'codex')) {
    $dirs = @(Get-ChildItem -LiteralPath $homeDir -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq ".$vendor" -or $_.Name -like ".$vendor-*" } | Sort-Object Name)
    foreach ($dir in $dirs) {
      if ($vendor -eq 'claude') {
        $signedIn = (Test-Path (Join-Path $dir.FullName '.credentials.json')) -or ($dir.Name -eq '.claude' -and (Test-Path (Join-Path $homeDir '.claude.json')))
        $known = $signedIn -or $dir.Name -eq '.claude' -or (Test-Path (Join-Path $dir.FullName '.claude.json'))
      } else {
        $signedIn = Test-Path (Join-Path $dir.FullName 'auth.json')
        $known = $signedIn -or $dir.Name -eq '.codex' -or (Test-Path (Join-Path $dir.FullName 'config.toml'))
      }
      if ($known) { $accounts += [pscustomobject]@{ Vendor = $vendor; Home = $dir.FullName; SignedIn = [bool]$signedIn } }
    }
  }
  return $accounts
}

# The next free ~/.claude-accountN / ~/.codex-accountN (ZAICODE's own rule), marked so ZAICODE lists it.
function New-ZaicodeAccountHome([string]$Vendor) {
  $homeDir = [Environment]::GetFolderPath('UserProfile')
  for ($index = 2; $index -lt 20; $index++) {
    $dir = Join-Path $homeDir ".$Vendor-account$index"
    if (-not (Test-Path -LiteralPath $dir) -or -not (Get-ChildItem -LiteralPath $dir -Force | Select-Object -First 1)) {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      if ($Vendor -eq 'codex') { Set-Content -LiteralPath (Join-Path $dir 'config.toml') -Value '# ZAICODE: second Codex login home' -Encoding UTF8 }
      else { Set-Content -LiteralPath (Join-Path $dir '.claude.json') -Value '{}' -Encoding ASCII }
      return $dir
    }
  }
  throw "No free .$Vendor-accountN slot"
}

function Get-ZaicodeLoginCommand([string]$Vendor, [string]$HomeDir) {
  $quoted = $HomeDir.Replace("'", "''")
  if ($Vendor -eq 'codex') { return "`$env:CODEX_HOME = '$quoted'; codex login" }
  return "`$env:CLAUDE_CONFIG_DIR = '$quoted'; claude auth login"
}
