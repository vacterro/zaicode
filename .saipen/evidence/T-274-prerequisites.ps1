param([string]$Part, [string]$Root)
$ErrorActionPreference = 'Stop'
. 'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/install/ZaicodeInstallLib.ps1'
$env:PATH = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
$env:GIT_TERMINAL_PROMPT = '0'
$layout = Get-ZaicodeLayout $Root
$null = Start-ZaicodeLog $layout.Logs "prerequisite-$Part"
switch ($Part) {
  'git' { $tool = Install-ZaicodeGit $layout; & $tool --version }
  'node' { $tool = Install-ZaicodeNode $layout; & $tool --version }
  'python' { $tool = Install-ZaicodePython $layout; & $tool --version; & $tool -m pip --version }
}
if ($LASTEXITCODE -ne 0) { throw "$Part did not start" }
Write-Host "PASS $Part from $tool with global development tools excluded from PATH"
