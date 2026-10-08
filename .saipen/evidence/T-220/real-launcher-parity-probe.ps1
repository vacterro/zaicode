# T-220: the real installed launcher code against the real workspace and the real live
# package. Read-only: DescribeRuntimeSkew only runs git read commands and reads the
# package's own build-meta.json. Nothing is promoted, swapped or started.
$ErrorActionPreference = 'Stop'
$root = 'V:\___VAC\__K\__CODE\_AI_STUFF_AGENTIC\_ZAICODE'
$scratch = Join-Path $env:TEMP ('zaicode-real-parity-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/out:$scratch\ZAICODE.exe" (Join-Path $root 'tools\launcher\ZaicodeLauncher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Launcher compile failed' }
$type = [Reflection.Assembly]::LoadFrom("$scratch\ZAICODE.exe").GetType('ZaicodeLauncher')
$flags = [Reflection.BindingFlags]'Static,NonPublic,Public'
$skew = $type.GetMethod('DescribeRuntimeSkew', $flags)
$live = Join-Path $root 'zcode\packages\desktop\dist\win-unpacked\ZAICODE.exe'
$meta = Join-Path $root 'zcode\packages\desktop\dist\win-unpacked\resources\build-meta.json'
Write-Host ("LIVE_EXE_EXISTS=" + (Test-Path $live))
Write-Host ("LIVE_BUILD_META_EXISTS=" + (Test-Path $meta))
Write-Host ("INSTALLED_LAUNCHER_BYTES=" + (Get-Item (Join-Path $root 'ZAICODE.exe')).Length)
Write-Host ("SOURCE_HEAD=" + (& git -C (Join-Path $root 'zcode') rev-parse HEAD))
$text = [string]$skew.Invoke($null, @([string]$root, [string]$live))
Write-Host "----- SKEW -----"
Write-Host $text
Write-Host "----- END -----"
if ([string]::IsNullOrEmpty($text)) { Write-Host 'RESULT=NO_SKEW' } else { Write-Host ('RESULT=' + $text.Split("`n")[0]) }