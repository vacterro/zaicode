param([string]$Subject = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
. (Join-Path $Subject 'ZaicodeInstallLib.ps1')
. (Join-Path $Subject 'ZaicodeChecks.ps1')
$fixture = Join-Path $env:TEMP ('zaicode-suite-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$checks = 0
function Check([bool]$Pass, [string]$Name) { if (-not $Pass) { throw "FAIL $Name" }; $script:checks++; Write-Host "PASS $Name" }
function Put([string]$Relative, [string]$Text = 'owned program') {
  $path = Join-Path $fixture $Relative
  New-Item -ItemType Directory -Path (Split-Path $path) -Force | Out-Null
  [IO.File]::WriteAllText($path, $Text)
}
function Here([string]$Relative) { return Test-Path -LiteralPath (Join-Path $fixture $Relative) }
$layout = Get-ZaicodeLayout $fixture
$options = [pscustomobject]@{ NoShortcut = $true; NoStartMenu = $true; NoRegistration = $true; ShortcutDir = $fixture; PortableTools = $false }
$rows = @(Invoke-ZaicodeChecks $layout $options -Only @('saimail-cli', 'router'))
Check (@($rows | Where-Object { $_.Status -eq 'FAIL' }).Count -eq 2) 'missing mandatory SAIMAIL CLI and router make installation fail'
New-Item -ItemType Directory -Path (Split-Path $layout.AppExe) -Force | Out-Null
[IO.File]::WriteAllText($layout.AppExe, 'MZ')
$bootFailed = Join-Path (Split-Path (Split-Path $layout.AppExe)) 'boot-failed.json'
[IO.File]::WriteAllText($bootFailed, '{}')
Check (@(Invoke-ZaicodeChecks $layout $options -Only @('app'))[0].Status -eq 'FAIL') 'a live build whose boot check failed is not reported as installed'
(Get-Item -LiteralPath $layout.AppExe).LastWriteTimeUtc = (Get-Date).ToUniversalTime().AddMinutes(5)
Check (@(Invoke-ZaicodeChecks $layout $options -Only @('app'))[0].Status -eq 'OK') 'a newer build replaces the failed-boot record'
Remove-Item -LiteralPath (Join-Path $fixture 'zcode') -Recurse -Force

# What a bundled install leaves: three clones with history, runtimes, the app build and the workspace files.
$program = @('zcode\app.js', 'zcode\src\logs\route.js', 'zcode\.git\HEAD', 'zcode\.git\refs\heads\zaicode', 'zcode\.git\objects\pack.fixture',
  'zcode\packages\desktop\dist\win-unpacked\ZAICODE.exe', 'saipen\protocol.py', 'saipen\.git\HEAD', 'saipen\.git\refs\heads\main', 'saimail\post.py',
  '.venv\python.fixture', '.tools\python\runtime.fixture', 'tools\launcher\build.cmd', 'ZAICODE.exe', 'SAIPEN.cmd', 'SAIMAIL.cmd',
  'Uninstall-ZAICODE.cmd', 'install\ZaicodeSuite.ps1', 'README.md', '.git\HEAD', 'saimail\.saipen\STATE.md', '.claude\skills\saipen\SKILL.md')
foreach ($relative in $program) { Put $relative }
Put '.saipen\STATE.md' 'workspace protocol memory'
Put 'saimail\.saimail-workspace\mail.json' 'user mail'
Put 'install\logs\install.log' 'log'
Put 'install\install-state.json' '{}'
$state = Write-ZaicodeSuiteOwnership $layout $options
$paths = @($state.files | ForEach-Object { $_.path })
Check ($paths.Count -eq $program.Count) 'manifest holds exactly the installed program files'
Check ($paths -contains 'zcode\src\logs\route.js') 'a program folder named logs is owned like any other'
Check ($paths -contains 'saimail\.saipen\STATE.md') 'a clone''s tracked .saipen is repository content and owned'
Check (-not ($paths | Where-Object { $_ -like '.saipen\*' -or $_ -like '*.saimail-workspace*' -or $_ -like 'install\logs*' -or $_ -eq 'install\install-state.json' })) 'manifest excludes protocol state, mailbox, logs and install records'

# The person works in SAIPEN; an update rewrites the app; the launcher later swaps a staged build in.
Put 'saipen\protocol.py' 'user modified protocol'
Put 'saipen\my-notes.txt' 'foreign data'
Put 'saipen\.saipen\STATE.md' 'user state'
Put 'ZAICODE\launcher.log' 'written after install'
Put 'projects\mine.txt' 'a project'
$before = Get-ZaicodeSuiteBaseline $layout
Put 'zcode\app.js' 'installer update'
$null = Write-ZaicodeSuiteOwnership $layout $options $before
Put 'zcode\packages\desktop\dist\win-unpacked\swapped-in-later.dll' 'new build'
Put 'zcode\node_modules\pkg\index.js' 'dependency'
$outside = Join-Path $env:TEMP ('zaicode-suite-outside-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $outside | Out-Null
[IO.File]::WriteAllText((Join-Path $outside 'keep.txt'), 'not ours')
$null = & cmd.exe /d /c mklink /J (Join-Path $fixture 'zcode\node_modules\linked') $outside

$result = Remove-ZaicodeSuiteComponents $fixture @('zaicode')
Check (-not (Here 'ZAICODE.exe') -and -not (Here 'zcode\app.js') -and -not (Here 'zcode\src\logs\route.js')) 'ZAICODE alone removed, its logs-named program folder too'
Check (-not (Here 'zcode\packages\desktop\dist') -and -not (Here 'zcode\node_modules')) 'a build swapped in after the manifest and the dependencies go with the app'
Check ((Test-Path -LiteralPath (Join-Path $outside 'keep.txt'))) 'a junction inside generated files is unlinked, never deleted through'
Check (-not (Here 'zcode')) 'an untouched clone goes with its history'
Check ((Here 'saimail\post.py') -and (Here '.tools\python\runtime.fixture') -and (Here 'SAIMAIL.cmd') -and (Here 'README.md')) 'companions, runtime and workspace stay after ZAICODE removal'

$result = Remove-ZaicodeSuiteComponents $fixture @('saimail')
Check (-not (Here '.venv') -and -not (Here 'saimail\post.py')) 'SAIMAIL and its venv removed independently'
Check (Here '.tools\python\runtime.fixture') 'SAIPEN runtime survives SAIMAIL removal'

$result = Remove-ZaicodeSuiteComponents $fixture @('saipen')
Check ($result.remaining.Count -eq 0 -and -not (Here '.tools')) 'last component removes shared runtime'
Check ((Get-Content -LiteralPath (Join-Path $fixture 'saipen\protocol.py') -Raw) -eq 'user modified protocol' -and (Here 'saipen\my-notes.txt')) 'modified and foreign files preserved'
Check ((Here 'saipen\.git\HEAD') -and $result.keptHistory -contains 'saipen\.git') 'a clone the person worked in keeps its whole history'
Check (-not (Here 'README.md') -and -not (Here '.claude') -and -not (Here 'install')) 'workspace files, install records and logs go with the last part'
Check ((Here '.git\HEAD') -and $result.keptHistory -contains '.git') 'the workspace history stays while the person keeps files beside it'
Check ((Here 'ZAICODE\launcher.log') -and (Here 'projects\mine.txt')) 'files written after the install survive, even under a ZAICODE-named folder'
Check ((Here 'saipen\.saipen\STATE.md') -and (Here '.saipen\STATE.md') -and (Here 'saimail\.saimail-workspace\mail.json')) 'mail and protocol state survive whole suite removal'
Check (-not (Here 'saimail\.saipen')) 'the SAIMAIL clone''s own tracked .saipen goes with it'
$refused = $false
try { $null = Remove-ZaicodeSuiteComponents $fixture @('zaicode', 'saipen', 'saimail') } catch { $refused = $true }
Check ($refused -and (Here 'saimail\.saimail-workspace\mail.json')) 'repeated uninstall is refused without touching anything'

$target = Join-Path $env:TEMP ('zaicode-suite-outside-' + [guid]::NewGuid().ToString('N') + '.txt')
[IO.File]::WriteAllText($target, 'outside')
New-Item -ItemType Directory -Path (Join-Path $fixture 'install') -Force | Out-Null
$forged = [pscustomobject]@{ schema = 1; root = $fixture; version = '0.0.3'; components = @('zaicode'); shortcuts = @(); registered = $false
  files = @([pscustomobject]@{ component = 'zaicode'; path = '..\' + (Split-Path -Leaf $target); sha256 = Get-ZaicodeFileSha $target }) }
$forged | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $fixture 'install\ownership.json') -Encoding UTF8
$refused = $false
try { $null = Remove-ZaicodeSuiteComponents $fixture @('zaicode') } catch { $refused = $true }
Check ($refused -and (Get-Content -LiteralPath $target -Raw) -eq 'outside') 'forged traversal refused before any deletion'
Write-Host "$checks checks PASS; scratch retained: $fixture"
