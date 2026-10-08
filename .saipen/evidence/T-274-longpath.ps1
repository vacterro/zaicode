$ErrorActionPreference = 'Stop'
[AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling', $false)
[AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths', $false)
$root = Join-Path $env:TEMP ('zaicode-longpath-' + [guid]::NewGuid().ToString('N'))
$target = $root
while ($target.Length -lt 310) { $target = Join-Path $target 'deep-segment-long-path' }
[IO.Directory]::CreateDirectory($target) | Out-Null
$file = Join-Path $target 'program.txt'
[IO.File]::WriteAllText($file, 'fixture')
$files = @(Get-ChildItem -LiteralPath $root -Recurse -File)
Write-Host "Enumerated $($files.Count) files; target length $($file.Length)"
. 'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/install/ZaicodeSuite.ps1'
Write-Host (Get-ZaicodeFileSha $file)
Remove-Item -LiteralPath $file -Force
if (Test-Path -LiteralPath $file) { throw 'Long path deletion failed' }
Write-Host 'PASS Windows PowerShell 5.1 .NET long path enumeration, hash and file removal'
