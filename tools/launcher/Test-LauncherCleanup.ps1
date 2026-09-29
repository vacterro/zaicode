# Proof for the launcher's build cleanup (T-123).
#
# The launcher moves the previous build to win-unpacked.previous before it swaps in a staged one and has to
# delete the one before that. The bundled 9router ships paths past MAX_PATH, and the long-path fallback
# called Directory.Delete on a \\?\ path, which .NET Framework rejects ("Illegal characters in path"), so
# every swap left a win-unpacked.previous-STAMP folder of ~250 MB behind (ten of them, 2.6 GB).
#
# This compiles the launcher to a scratch exe (the live ZAICODE.exe is never touched), builds a tree with a
# 488-character path, and checks: (RED) the old fallback still throws under the launcher's own compiler;
# (GREEN) RemoveLongPathDirectory deletes that tree; PruneAsideBuilds removes exactly the 14-digit-stamp
# leftovers and nothing else.
#
# Run with Windows PowerShell 5.1:  powershell.exe -NoProfile -File tools\launcher\Test-LauncherCleanup.ps1
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$scratch = Join-Path $env:TEMP ("zaicode-launcher-cleanup-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $scratch | Out-Null
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$failures = @()
function Check([string]$name, [bool]$ok) {
    if ($ok) { Write-Host "PASS  $name" } else { Write-Host "FAIL  $name"; $script:failures += $name }
}

& $csc /nologo /target:winexe /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/out:$scratch\launcher-probe.exe" (Join-Path $root 'tools\launcher\ZaicodeLauncher.cs') | Out-Null
Check 'the launcher compiles' (Test-Path "$scratch\launcher-probe.exe")

@'
using System;
using System.IO;
internal static class OldFallback
{
    private static int Main(string[] args)
    {
        try { Directory.Delete(@"\\?\" + args[0], true); return 0; }
        catch (Exception error) { Console.WriteLine(error.Message); return 1; }
    }
}
'@ | Set-Content -Encoding ASCII "$scratch\OldFallback.cs"
& $csc /nologo /target:exe "/out:$scratch\OldFallback.exe" "$scratch\OldFallback.cs" | Out-Null

function New-DeepTree([string]$base) {
    $deep = $base
    1..4 | ForEach-Object { $deep = "$deep\" + ('x' * 90) }
    cmd /c mkdir "\\?\$deep" | Out-Null
    return $deep
}

$type = [Reflection.Assembly]::LoadFrom("$scratch\launcher-probe.exe").GetType('ZaicodeLauncher')
$flags = [Reflection.BindingFlags]'Static,NonPublic,Public'

# RED: what the launcher used to do.
$old = Join-Path $scratch 'old'
$null = New-DeepTree $old
$oldOutput = (& "$scratch\OldFallback.exe" $old) -join ' '
Check "the old fallback throws 'Illegal characters in path' ($oldOutput)" ($oldOutput -match 'Illegal characters')
Check 'and leaves the tree behind' ([IO.Directory]::Exists("\\?\$old"))

# GREEN: the new remover.
$returned = $type.GetMethod('RemoveLongPathDirectory', $flags).Invoke($null, @([string]$old))
Check 'RemoveLongPathDirectory deletes a 488-character path' ($returned -eq $true -and -not [IO.Directory]::Exists("\\?\$old"))

# The prune: only the launcher's own 14-digit stamps go.
$ws = Join-Path $scratch 'ws'
$dist = Join-Path $ws 'zcode\packages\desktop\dist'
foreach ($name in 'win-unpacked', 'win-unpacked.previous', 'win-unpacked.previous-before-p1', 'win-unpacked.previous-2026010100000x', 'win-unpacked.previous-20260101000000') {
    New-Item -ItemType Directory -Force (Join-Path $dist $name) | Out-Null
}
$null = New-DeepTree (Join-Path $dist 'win-unpacked.previous-20260101000000')
$null = $type.GetMethod('PruneAsideBuilds', $flags).Invoke($null, @([string]$ws))
$deadline = (Get-Date).AddSeconds(60)
while ((Test-Path (Join-Path $dist 'win-unpacked.previous-20260101000000')) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
Check 'the stamped leftover is pruned' (-not (Test-Path (Join-Path $dist 'win-unpacked.previous-20260101000000')))
foreach ($name in 'win-unpacked', 'win-unpacked.previous', 'win-unpacked.previous-before-p1', 'win-unpacked.previous-2026010100000x') {
    Check "$name is left alone" (Test-Path (Join-Path $dist $name))
}

$null = $type.GetMethod('RemoveLongPathDirectory', $flags).Invoke($null, @([string]$scratch))
if ($failures.Count -gt 0) { Write-Host "$($failures.Count) check(s) did not hold"; exit 1 }
Write-Host 'all checks held'
