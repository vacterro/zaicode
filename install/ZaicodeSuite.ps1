# Suite ownership: used by the existing setup and the component uninstaller.
# Every deletion is an unchanged file from the install's own manifest.
[AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling', $false)
[AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths', $false)

function Assert-ZaicodeSuiteRoot([string]$Root) {
  $full = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  if ($full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\', '/') -or $full -eq [Environment]::GetFolderPath('UserProfile').TrimEnd('\', '/') -or $full -eq $env:SystemRoot.TrimEnd('\', '/')) { throw "Not an installation folder: $full" }
  $cursor = $full
  while ($cursor -and (Test-Path -LiteralPath $cursor)) {
    if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked installation path refused: $cursor" }
    $parent = Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }; $cursor = $parent
  }
  return $full
}

function Get-ZaicodeOwnedPath([string]$Root, [string]$Relative) {
  if ([string]::IsNullOrWhiteSpace($Relative) -or $Relative.Contains(':') -or [IO.Path]::IsPathRooted($Relative) -or ($Relative -split '[\\/]') -contains '..') { throw "Invalid owned path: $Relative" }
  $full = [IO.Path]::GetFullPath((Join-Path $Root $Relative))
  if (-not $full.StartsWith($Root.TrimEnd('\', '/') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Owned path escapes installation: $Relative" }
  $cursor = $full
  while ($cursor -and $cursor.Length -gt $Root.Length) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Linked owned path refused: $cursor" }
    $cursor = Split-Path -Parent $cursor
  }
  return $full
}

function Get-ZaicodeFileSha([string]$Path) {
  $hash = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $hash.Dispose() }
}

function Get-ZaicodeSuiteRegistryKey([string]$Root) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $id = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant())))).Replace('-', '').Substring(0, 16) }
  finally { $hash.Dispose() }
  return "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZAICODE-Suite-$id"
}

function Read-ZaicodeSuiteOwnership([string]$Root) {
  $manifest = Get-ZaicodeOwnedPath $Root 'install\ownership.json'
  if (-not (Test-Path -LiteralPath $manifest)) { return $null }
  $state = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  if ($state.schema -ne 1 -or $state.root -ne $Root) { throw 'The suite ownership record does not belong to this folder.' }
  foreach ($id in $state.components) { if ($id -notin @('zaicode', 'saipen', 'saimail')) { throw 'Invalid suite component record.' } }
  return $state
}

function Get-ZaicodeSuiteOwnershipOptions($State) {
  return [pscustomobject]@{
    NoRegistration = -not $State.registered
    NoShortcut = $State.shortcuts.Count -eq 0
    NoStartMenu = $(if ($State.PSObject.Properties['noStartMenu']) { $State.noStartMenu } else { $true })
    ShortcutDir = $(if ($State.PSObject.Properties['shortcutDir']) { $State.shortcutDir } else { [Environment]::GetFolderPath('Desktop') })
  }
}

# User data the suite never claims, wherever it sits: mail and app profiles. Protocol memory is
# the person's at the root; inside the SAIPEN and SAIMAIL clones .saipen is tracked repository
# content. Anything a person adds later (an agent's .claude folder too) is foreign to the install
# baseline and stays without a name rule.
$script:ZaicodeSuiteDataNames = @('.saimail-workspace', 'mail', 'userData')
# Records the installer and updater rewrite; they are removed with the last part, never hashed.
$script:ZaicodeSuiteMachineState = @('install\ownership.json', 'install\install-report.json', 'install\install-state.json', 'install\update-state.json', 'install\payload-pending.json', 'install\ownership-pending.json')

function Test-ZaicodeSuiteDataDir([string]$Relative, [string]$Name) {
  return ($script:ZaicodeSuiteDataNames -contains $Name) -or $Relative -in @('.saipen', 'install\logs', '.zaicode')
}

# Which part a path belongs to; everything outside the three programs is the shared workspace.
function Get-ZaicodeSuitePathComponent([string]$Relative) {
  $top = ($Relative -split '\\')[0]
  if ($top -eq 'zcode' -or $top -like 'ZAICODE*' -or $Relative -like 'tools\launcher\*') { return 'zaicode' }
  if ($top -eq 'saipen' -or $top -eq 'SAIPEN.cmd') { return 'saipen' }
  if ($top -eq 'saimail' -or $top -eq '.venv' -or $top -eq 'SAIMAIL.cmd') { return 'saimail' }
  return 'shared'
}

# Every regular file under the root outside user data; links are never entered.
function Get-ZaicodeSuiteFiles([string]$Root) {
  $files = New-Object 'System.Collections.Generic.List[string]'
  $pending = New-Object 'System.Collections.Generic.Stack[string]'; $pending.Push($Root)
  while ($pending.Count -gt 0) {
    foreach ($entry in (Get-ChildItem -LiteralPath $pending.Pop() -Force)) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
      $relative = $entry.FullName.Substring($Root.Length + 1)
      if ($entry.PSIsContainer) { if (-not (Test-ZaicodeSuiteDataDir $relative $entry.Name)) { $pending.Push($entry.FullName) }; continue }
      if ($script:ZaicodeSuiteMachineState -notcontains $relative) { $files.Add($relative) }
    }
  }
  return , $files
}

function Get-ZaicodeSuiteBaseline($Layout) {
  $root = Assert-ZaicodeSuiteRoot $Layout.Root
  $owned = @{}
  $state = Read-ZaicodeSuiteOwnership $root
  if ($state) { foreach ($row in $state.files) { $null = Get-ZaicodeOwnedPath $root $row.path; $owned[$row.path] = $row.sha256 } }
  $before = @{}
  foreach ($relative in (Get-ZaicodeSuiteFiles $root)) {
    $before[$relative] = if ($owned.ContainsKey($relative)) { Get-ZaicodeFileSha (Join-Path $root $relative) } else { 'foreign' }
  }
  return $before
}

function Get-ZaicodeSuiteInstallBaseline($Layout) {
  $root = Assert-ZaicodeSuiteRoot $Layout.Root
  $journal = Get-ZaicodeOwnedPath $root 'install\ownership-pending.json'
  if (Test-Path -LiteralPath $journal) {
    $saved = Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json
    if ($saved.root -ne $root) { throw 'This unfinished installation belongs to another folder.' }
    $before = @{}; foreach ($property in $saved.before.PSObject.Properties) { $before[$property.Name] = $property.Value }
    return $before
  }
  $before = Get-ZaicodeSuiteBaseline $Layout
  if (-not (Test-Path -LiteralPath $Layout.State)) {
    New-Item -ItemType Directory -Path (Split-Path $journal) -Force | Out-Null
    @{ root = $root; before = $before } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $journal -Encoding UTF8
  }
  return $before
}

function Write-ZaicodeSuiteOwnership($Layout, $Options, [hashtable]$Before = $null, [switch]$KeepSelection) {
  $root = Assert-ZaicodeSuiteRoot $Layout.Root
  $manifest = Get-ZaicodeOwnedPath $root 'install\ownership.json'
  $previous = Read-ZaicodeSuiteOwnership $root
  $previousFiles = @{}
  if ($previous) { foreach ($row in $previous.files) { $previousFiles[$row.path] = $row.sha256 } }
  $versionFile = Join-Path $root 'VERSION'
  $version = if (Test-Path -LiteralPath $versionFile) { (Get-Content -LiteralPath $versionFile -Raw).Trim() } else { '0.0.3' }
  $state = [ordered]@{ schema = 1; root = $root; version = $version; components = @('zaicode', 'saipen', 'saimail'); files = @(); shortcuts = @(); registered = (-not $Options.NoRegistration) }
  $state.shortcutDir = $Options.ShortcutDir; $state.noStartMenu = $Options.NoStartMenu
  if ($KeepSelection -and $previous) { $state.components = @($previous.components) }
  # What the installer or updater put here. Files that were here before it (Before = foreign) are never claimed.
  $rows = New-Object 'System.Collections.Generic.List[object]'
  foreach ($relative in (Get-ZaicodeSuiteFiles $root)) {
    $component = Get-ZaicodeSuitePathComponent $relative
    if ($component -ne 'shared' -and $state.components -notcontains $component) { continue }
    if ($Before -and $Before.ContainsKey($relative) -and -not $previousFiles.ContainsKey($relative)) { continue }
    $sha = Get-ZaicodeFileSha (Join-Path $root $relative)
    # A file the person changed before this run stays recorded with the installed hash, so it is still theirs.
    if ($previousFiles.ContainsKey($relative) -and (-not $Before -or ($Before.ContainsKey($relative) -and $Before[$relative] -ne $previousFiles[$relative]))) { $sha = $previousFiles[$relative] }
    $rows.Add([ordered]@{ component = $component; path = $relative; sha256 = $sha })
  }
  $state.files = @($rows.ToArray())
  if ($KeepSelection -and $previous) { $state.shortcuts = @($previous.shortcuts) }
  elseif (-not $Options.NoShortcut) { $state.shortcuts = @(Get-ZaicodeShortcutPaths $Options.ShortcutDir -StartMenu:(-not $Options.NoStartMenu)) }
  $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifest -Encoding UTF8
  if ($state.registered) {
    $key = Get-ZaicodeSuiteRegistryKey $root
    New-Item -Path $key -Force | Out-Null
    $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $command = '"' + $shell + '" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $root 'install\Uninstall-ZAICODE.ps1') + '" -Interactive'
    $name = if ($state.components.Count -eq 3) { 'ZAICODE + SAIPEN + SAIMAIL' } else { ($state.components -join ' + ').ToUpperInvariant() }
    foreach ($pair in @(@('DisplayName', $name), @('DisplayVersion', $version), @('Publisher', 'vacterro'), @('InstallLocation', $root), @('UninstallString', $command), @('DisplayIcon', $Layout.Launcher))) { New-ItemProperty -LiteralPath $key -Name $pair[0] -Value $pair[1] -PropertyType String -Force | Out-Null }
    New-ItemProperty -LiteralPath $key -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -LiteralPath $key -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
  }
  return $state
}

function Install-ZaicodeSuiteEntryPoints($Layout, [string]$Source, [string[]]$Components = @('zaicode', 'saipen', 'saimail')) {
  foreach ($name in @('Uninstall-ZAICODE.ps1', 'ZaicodeSuite.ps1')) {
    $from = Join-Path $Source $name; $to = Join-Path $Layout.Root "install\$name"
    if ([IO.Path]::GetFullPath($from) -ne [IO.Path]::GetFullPath($to)) { Copy-Item -LiteralPath $from -Destination $to -Force }
  }
  $shell = '%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe'
  $commands = @{
    # start returns at once: the uninstaller may remove this very file and its folder.
    'Uninstall-ZAICODE.cmd' = 'start "" /d "%TEMP%" "' + $shell + '" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0install\Uninstall-ZAICODE.ps1" -Interactive'
    'SAIPEN.cmd' = 'call "%~dp0saipen\bin\saipen.cmd" %*'
    'SAIMAIL.cmd' = '"%~dp0.venv\Scripts\saimail-local.exe" %*'
  }
  foreach ($name in $commands.Keys) {
    if (($name -eq 'SAIPEN.cmd' -and $Components -notcontains 'saipen') -or ($name -eq 'SAIMAIL.cmd' -and $Components -notcontains 'saimail')) { continue }
    [IO.File]::WriteAllText((Join-Path $Layout.Root $name), "@echo off`r`n" + $commands[$name] + "`r`n", (New-Object Text.UTF8Encoding($false)))
  }
}

function Install-ZaicodeSuitePayload($Layout, [string]$Zip, [string]$Sha256) {
  if (-not $Zip) { return $false }
  if (-not $Sha256 -or (Get-ZaicodeFileSha $Zip) -ne $Sha256.ToLowerInvariant()) { throw 'The bundled suite payload checksum does not match. Run Setup again from a fresh download.' }
  if (Test-Path -LiteralPath $Layout.State) { Write-ZaicodeLog 'Existing install: using the source update/repair path.'; return $false }
  $pendingFile = Get-ZaicodeOwnedPath $Layout.Root 'install\payload-pending.json'
  $resuming = Test-Path -LiteralPath $pendingFile
  if ($resuming) {
    $pending = Get-Content -LiteralPath $pendingFile -Raw | ConvertFrom-Json
    if ($pending.root -ne $Layout.Root -or $pending.sha256 -ne $Sha256) { throw 'This folder contains a different unfinished installation. Your files were kept.' }
    if ($pending.PSObject.Properties['stage'] -and $pending.stage -eq 'extracted') {
      $python = Find-ZaicodePython $Layout
      if (-not $python) { throw 'The bundled Python runtime is missing.' }
      Install-ZaicodeSaimail $Layout $python -Offline
      Set-ZaicodeSaipenLauncher $Layout $python
      return $true
    }
  } elseif ((Test-Path -LiteralPath $Layout.Root) -and (Get-ChildItem -LiteralPath $Layout.Root -Force | Where-Object { $_.Name -ne 'install' } | Select-Object -First 1)) { throw 'Choose an empty folder for this bundled suite. Your existing files were kept.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
  $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  try {
    foreach ($entry in $archive.Entries) {
      if (-not $entry.Name) { continue }
      $target = Get-ZaicodeOwnedPath $Layout.Root $entry.FullName
      if ($entry.FullName.EndsWith('.zaicode-installing', [StringComparison]::OrdinalIgnoreCase)) { throw 'Reserved temporary path in suite payload.' }
      if (-not $names.Add($target)) { throw 'Duplicate paths in the suite payload.' }
    }
    # Fail before the first file with a fix the person can apply, not halfway with a .NET error.
    $longest = ($archive.Entries | ForEach-Object { $_.FullName.Length } | Measure-Object -Maximum).Maximum
    $longPaths = $false
    try { $longPaths = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction Stop).LongPathsEnabled -eq 1 } catch { }
    if (-not $longPaths -and $Layout.Root.Length + 1 + $longest -gt 259) { throw ("The install folder path is too long for this Windows ({0} characters, at most {1}). Choose a shorter folder, for example C:\ZAICODE." -f $Layout.Root.Length, (258 - $longest)) }
    if (-not $resuming) {
      $needed = [long](($archive.Entries | Measure-Object -Property Length -Sum).Sum * 1.1)
      $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($Layout.Root))
      if ($drive.AvailableFreeSpace -lt $needed) { throw ("Not enough free space on {0}: {1:n1} GB needed, {2:n1} GB free." -f $drive.Name, ($needed / 1GB), ($drive.AvailableFreeSpace / 1GB)) }
    }
    New-Item -ItemType Directory -Path (Split-Path $pendingFile) -Force | Out-Null
    @{ root = $Layout.Root; sha256 = $Sha256 } | ConvertTo-Json | Set-Content -LiteralPath $pendingFile -Encoding UTF8
    Write-ZaicodeProgress @{ type = 'phase'; id = 'payload'; title = 'Installing bundled ZAICODE + SAIPEN + SAIMAIL' }
    $count = 0
    foreach ($entry in $archive.Entries) {
      if (-not $entry.Name) { continue }
      $target = Get-ZaicodeOwnedPath $Layout.Root $entry.FullName
      if (Test-Path -LiteralPath $target) {
        $hash = [Security.Cryptography.SHA256]::Create(); $source = $entry.Open()
        try { $expected = ([BitConverter]::ToString($hash.ComputeHash($source))).Replace('-', '').ToLowerInvariant() }
        finally { $source.Dispose(); $hash.Dispose() }
        if (-not $resuming -or (Get-ZaicodeFileSha $target) -ne $expected) { throw "An existing file was changed; it was kept: $($entry.FullName)" }
      } else {
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        $temporary = Get-ZaicodeOwnedPath $Layout.Root ($entry.FullName + '.zaicode-installing')
        $source = $entry.Open(); $destination = [IO.File]::Create($temporary)
        try { $source.CopyTo($destination) } finally { $source.Dispose(); $destination.Dispose() }
        Move-Item -LiteralPath $temporary -Destination $target
      }
      $count++
      if ($count % 250 -eq 0) { Write-ZaicodeProgress @{ type = 'phase'; id = 'payload'; title = "Installing bundled files: $count / $($archive.Entries.Count)" } }
    }
  } finally { $archive.Dispose() }
  $python = Find-ZaicodePython $Layout
  if (-not $python) { throw 'The bundled Python runtime is missing.' }
  @{ root = $Layout.Root; sha256 = $Sha256; stage = 'extracted' } | ConvertTo-Json | Set-Content -LiteralPath $pendingFile -Encoding UTF8
  Install-ZaicodeSaimail $Layout $python -Offline
  Set-ZaicodeSaipenLauncher $Layout $python
  return $true
}

# Build output, dependencies and caches the programs regenerate: removed whole, never hashed,
# because an update or a staged-build swap rewrites them after the manifest was taken.
function Get-ZaicodeSuiteGeneratedDirs([string]$Root, [string[]]$Components, [bool]$Last) {
  $dirs = New-Object 'System.Collections.Generic.List[string]'
  $relative = @()
  if ($Components -contains 'zaicode') { $relative += @('zcode\packages\desktop\dist', 'zcode\packages\desktop\dist-next', '.zaicode\smoke') }
  if ($Components -contains 'saimail') { $relative += '.venv' }
  if ($Last) { $relative += '.tools' }
  foreach ($path in $relative) { $full = Get-ZaicodeOwnedPath $Root $path; if (Test-Path -LiteralPath $full) { $dirs.Add($full) } }
  $clones = @(@{ id = 'zaicode'; dir = 'zcode' }, @{ id = 'saipen'; dir = 'saipen' }, @{ id = 'saimail'; dir = 'saimail' }) | Where-Object { $Components -contains $_.id }
  foreach ($clone in $clones) {
    $base = Get-ZaicodeOwnedPath $Root $clone.dir
    if (-not (Test-Path -LiteralPath $base)) { continue }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'; $pending.Push($base)
    while ($pending.Count -gt 0) {
      foreach ($entry in (Get-ChildItem -LiteralPath $pending.Pop() -Force -Directory)) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        if ($entry.Name -in @('node_modules', '__pycache__')) { if (-not $dirs.Contains($entry.FullName)) { $dirs.Add($entry.FullName) }; continue }
        if ($entry.Name -ne '.git' -and -not $dirs.Contains($entry.FullName) -and -not (Test-ZaicodeSuiteDataDir $entry.FullName.Substring($Root.Length + 1) $entry.Name)) { $pending.Push($entry.FullName) }
      }
    }
  }
  return , $dirs
}

function Test-ZaicodeSuiteUnder([string]$Path, [System.Collections.Generic.List[string]]$Dirs) {
  foreach ($dir in $Dirs) { if ($Path.StartsWith($dir + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true } }
  return $false
}

# rd removes a junction or link as a link and never deletes through it; \\?\ passes MAX_PATH.
function Remove-ZaicodeSuiteTree([string]$Path) {
  $info = New-Object Diagnostics.ProcessStartInfo (Join-Path $env:SystemRoot 'System32\cmd.exe'), ('/d /c rd /s /q "\\?\' + $Path + '"')
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.RedirectStandardError = $true
  $process = [Diagnostics.Process]::Start($info); $null = $process.StandardError.ReadToEnd(); $process.WaitForExit()
  return -not (Test-Path -LiteralPath $Path)
}

# A clone's history is the person's work when they edited it or committed in it; then .git stays whole.
function Test-ZaicodeSuiteCloneTouched([string]$Root, [string]$Clone, [hashtable]$Owned, [System.Collections.Generic.List[string]]$Generated, [string[]]$Skip) {
  $base = if ($Clone) { Get-ZaicodeOwnedPath $Root $Clone } else { $Root }
  if (-not (Test-Path -LiteralPath (Join-Path $base '.git'))) { return $false }
  $prefix = if ($Clone) { "$Clone\" } else { '' }
  foreach ($relative in (Get-ZaicodeSuiteFiles $Root)) {
    if ($prefix -and -not $relative.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
    $inner = $relative.Substring($prefix.Length)
    if (-not $prefix -and ($Skip -contains ($relative -split '\\')[0])) { continue }
    if (Test-ZaicodeSuiteUnder (Join-Path $Root $relative) $Generated) { continue }
    if ($inner -like '.git\*') {
      if (-not ($inner -eq '.git\HEAD' -or $inner -like '.git\refs\heads\*' -or $inner -eq '.git\refs\stash')) { continue }
    }
    if (-not $Owned.ContainsKey($relative)) { return $true }
    if ((Get-ZaicodeFileSha (Join-Path $Root $relative)) -ne $Owned[$relative]) { return $true }
  }
  return $false
}

function Remove-ZaicodeSuiteComponents([string]$InstallDir, [string[]]$Components) {
  $root = Assert-ZaicodeSuiteRoot $InstallDir
  $manifest = Get-ZaicodeOwnedPath $root 'install\ownership.json'
  $state = Read-ZaicodeSuiteOwnership $root
  if (-not $state) { throw 'This folder has no suite ownership record. Nothing was removed.' }
  foreach ($id in $Components) { if ($id -notin @('zaicode', 'saipen', 'saimail')) { throw "Unknown component: $id" } }
  $Components = @($Components | Where-Object { $state.components -contains $_ })
  $remaining = @($state.components | Where-Object { $Components -notcontains $_ })
  $last = $remaining.Count -eq 0
  $selected = @($state.files | Where-Object { $Components -contains $_.component -or ($last -and $_.component -eq 'shared') })
  # Validate the whole plan before the first mutation; forged paths and links fail closed.
  $owned = @{}
  foreach ($row in $state.files) { $null = Get-ZaicodeOwnedPath $root $row.path; $owned[$row.path] = $row.sha256 }
  $generated = Get-ZaicodeSuiteGeneratedDirs $root $Components $last
  # Each removed program's clone history goes with it unless the person worked in it.
  $keptHistory = New-Object 'System.Collections.Generic.List[string]'
  $clones = @(@{ id = 'zaicode'; dir = 'zcode' }, @{ id = 'saipen'; dir = 'saipen' }, @{ id = 'saimail'; dir = 'saimail' }) | Where-Object { $Components -contains $_.id }
  foreach ($clone in $clones) {
    $git = Join-Path (Get-ZaicodeOwnedPath $root $clone.dir) '.git'
    if (-not (Test-Path -LiteralPath $git)) { continue }
    if (Test-ZaicodeSuiteCloneTouched $root $clone.dir $owned $generated @()) { $keptHistory.Add($git) } else { $generated.Add($git) }
  }
  if ($last -and (Test-Path -LiteralPath (Join-Path $root '.git'))) {
    $programs = @('zcode', 'saipen', 'saimail', '.venv', '.tools', '.git')
    if (Test-ZaicodeSuiteCloneTouched $root '' $owned $generated $programs) { $keptHistory.Add((Join-Path $root '.git')) } else { $generated.Add((Get-ZaicodeOwnedPath $root '.git')) }
  }
  $fullPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($row in $selected) { $null = $fullPaths.Add((Get-ZaicodeOwnedPath $root $row.path)) }
  foreach ($process in (Get-CimInstance Win32_Process -ErrorAction Stop)) {
    if ($process.ProcessId -eq $PID -or -not $process.ExecutablePath) { continue }
    $usesComponent = $false
    foreach ($id in $Components) {
      $scope = if ($id -eq 'zaicode') { 'zcode' } else { $id }
      if ($process.CommandLine -and $process.CommandLine.Replace('/', '\').IndexOf((Join-Path $root "$scope\"), [StringComparison]::OrdinalIgnoreCase) -ge 0) { $usesComponent = $true }
    }
    if ($fullPaths.Contains($process.ExecutablePath) -or $usesComponent -or (Test-ZaicodeSuiteUnder $process.ExecutablePath $generated)) { throw "Close $($process.Name) (PID $($process.ProcessId)) and try again. Nothing was removed." }
  }
  $emptyCandidates = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $note = { param($path) $parent = Split-Path -Parent $path; while ($parent.Length -gt $root.Length) { $null = $emptyCandidates.Add($parent); $parent = Split-Path -Parent $parent } }
  $removed = 0; $preserved = 0; $leftover = 0
  foreach ($dir in $generated) { if (Remove-ZaicodeSuiteTree $dir) { & $note $dir } else { $leftover++ } }
  $kept = New-Object 'System.Collections.Generic.List[object]'
  $selectedPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($row in $selected) { $null = $selectedPaths.Add($row.path) }
  foreach ($row in $state.files) {
    if (-not $selectedPaths.Contains($row.path)) { $kept.Add($row); continue }
    $file = Get-ZaicodeOwnedPath $root $row.path
    if (Test-ZaicodeSuiteUnder $file $generated) { $removed++; continue }
    if (Test-ZaicodeSuiteUnder $file $keptHistory) { continue }
    if (-not (Test-Path -LiteralPath $file)) { continue }
    if ((Get-ZaicodeFileSha $file) -ne $row.sha256) { $preserved++; continue }
    Remove-Item -LiteralPath $file -Force -ErrorAction Stop; $removed++
    & $note $file
  }
  if ($Components -contains 'zaicode') {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($link in $state.shortcuts) { if ((Test-Path -LiteralPath $link) -and $shell.CreateShortcut($link).TargetPath -eq (Join-Path $root 'ZAICODE.exe')) { Remove-Item -LiteralPath $link -Force } }
    $state.shortcuts = @()
  }
  $state.files = @($kept.ToArray()); $state.components = $remaining
  $key = Get-ZaicodeSuiteRegistryKey $root
  if ($last) {
    # Nothing of the suite is left: its own records and logs go too; data and edited files stay.
    foreach ($name in $script:ZaicodeSuiteMachineState) { $file = Get-ZaicodeOwnedPath $root $name; if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force; & $note $file } }
    $logs = Get-ZaicodeOwnedPath $root 'install\logs'
    if (Test-Path -LiteralPath $logs) { Get-ChildItem -LiteralPath $logs -Filter '*.log' -File | Remove-Item -Force; $null = $emptyCandidates.Add($logs); & $note $logs }
  } else {
    $state | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifest -Encoding UTF8
  }
  foreach ($folder in ($emptyCandidates | Sort-Object Length -Descending)) {
    $checked = Get-ZaicodeOwnedPath $root $folder.Substring($root.Length + 1)
    if ((Test-Path -LiteralPath $checked) -and -not (Get-ChildItem -LiteralPath $checked -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $checked -Force }
  }
  if ($state.registered -and (Test-Path -LiteralPath $key)) {
    if ($last) { Remove-Item -LiteralPath $key -Recurse -Force }
    else { Set-ItemProperty -LiteralPath $key -Name DisplayName -Value ($remaining -join ' + ').ToUpperInvariant() }
  }
  $rootRemoved = $false
  if ($last -and -not (Get-ChildItem -LiteralPath $root -Force | Select-Object -First 1)) {
    try { Set-Location -LiteralPath (Split-Path -Parent $root); [Environment]::CurrentDirectory = (Split-Path -Parent $root); Remove-Item -LiteralPath $root -Force; $rootRemoved = $true } catch { }
  }
  return [pscustomobject]@{ removed = $removed; preservedModifiedFiles = $preserved; leftoverFolders = $leftover; keptHistory = @($keptHistory | ForEach-Object { $_.Substring($root.Length + 1) }); remaining = $remaining; folderRemoved = $rootRemoved; dataKept = $true }
}
