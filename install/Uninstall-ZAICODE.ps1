<# Removes selected suite programs. User projects, mail, settings and modified files are kept. #>
[CmdletBinding()]
param([string]$InstallDir = '', [string[]]$Component = @('zaicode'), [switch]$All, [switch]$Interactive)
$ErrorActionPreference = 'Stop'
if (-not $InstallDir) { $InstallDir = Split-Path -Parent $PSScriptRoot }
. (Join-Path $PSScriptRoot 'ZaicodeSuite.ps1')
$wanted = @($Component | ForEach-Object { $_ -split ',' })
if ($All) { $wanted = @('zaicode', 'saipen', 'saimail') }
if ($Interactive) {
  # Never hold the install folder open: the last removal deletes it.
  [Environment]::CurrentDirectory = [IO.Path]::GetTempPath(); Set-Location -LiteralPath ([IO.Path]::GetTempPath())
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $form = New-Object Windows.Forms.Form
  $form.Text = 'Remove ZAICODE components'
  $form.ClientSize = New-Object Drawing.Size(520, 305)
  $form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = 'FixedSingle'; $form.MaximizeBox = $false
  $form.BackColor = [Drawing.ColorTranslator]::FromHtml('#332E22'); $form.ForeColor = [Drawing.ColorTranslator]::FromHtml('#D4C89A')
  $form.Font = New-Object Drawing.Font('Verdana', 11, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
  $intro = New-Object Windows.Forms.Label
  $intro.Text = 'Choose the programs to remove. Shared runtimes stay while SAIPEN or SAIMAIL remains. Your projects, mail, settings and modified files are kept.'
  $intro.Location = New-Object Drawing.Point(16, 16); $intro.Size = New-Object Drawing.Size(485, 55); $form.Controls.Add($intro)
  $InstallDir = Assert-ZaicodeSuiteRoot $InstallDir
  $state = Read-ZaicodeSuiteOwnership $InstallDir
  if (-not $state) { throw 'No suite ownership record. Nothing was removed.' }
  $installed = @($state.components)
  $boxes = @{}
  $index = 0
  foreach ($id in @('zaicode', 'saipen', 'saimail')) {
    $box = New-Object Windows.Forms.CheckBox
    $what = @{ zaicode = 'the desktop app'; saipen = 'the agent work protocol (SAIPEN.cmd)'; saimail = 'agent mail (SAIMAIL.cmd)' }[$id]
    $box.Text = $id.ToUpperInvariant() + '  -  ' + $what + $(if ($installed -notcontains $id) { ' (not installed)' } else { '' }); $box.Tag = $id; $box.Enabled = $installed -contains $id
    $box.Checked = $box.Enabled -and $wanted -contains $id
    $box.Location = New-Object Drawing.Point(20, (83 + 30 * $index)); $box.Size = New-Object Drawing.Size(460, 26)
    $form.Controls.Add($box); $boxes[$id] = $box; $index++
  }
  $allButton = New-Object Windows.Forms.Button
  $allButton.Text = 'Select whole suite'; $allButton.Location = New-Object Drawing.Point(16, 185); $allButton.Size = New-Object Drawing.Size(180, 28)
  $allButton.Add_Click({ foreach ($box in $boxes.Values) { $box.Checked = $box.Enabled } }); $form.Controls.Add($allButton)
  $status = New-Object Windows.Forms.Label
  $status.Location = New-Object Drawing.Point(16, 218); $status.Size = New-Object Drawing.Size(485, 35); $form.Controls.Add($status)
  $remove = New-Object Windows.Forms.Button
  $remove.Text = 'Remove selected'; $remove.Location = New-Object Drawing.Point(270, 265); $remove.Size = New-Object Drawing.Size(140, 28); $form.Controls.Add($remove)
  $cancel = New-Object Windows.Forms.Button
  $cancel.Text = 'Cancel'; $cancel.Location = New-Object Drawing.Point(420, 265); $cancel.Size = New-Object Drawing.Size(85, 28); $cancel.DialogResult = 'Cancel'; $form.Controls.Add($cancel)
  $form.AcceptButton = $cancel; $form.CancelButton = $cancel
  $timer = New-Object Windows.Forms.Timer; $timer.Interval = 150
  $script:removalProcess = $null; $script:removalSelection = @()
  $timer.Add_Tick({
    if (-not $script:removalProcess -or -not $script:removalProcess.HasExited) { return }
    $timer.Stop()
    $output = $script:removalProcess.StandardOutput.ReadToEnd(); $errorOutput = $script:removalProcess.StandardError.ReadToEnd()
    if ($script:removalProcess.ExitCode -eq 0) {
      $result = $output | ConvertFrom-Json
      $status.Text = 'Removed. Your data was kept. Remaining: ' + $(if ($result.remaining.Count) { $result.remaining -join ', ' } else { 'none' }) + $(if ($result.preservedModifiedFiles) { '. Kept ' + $result.preservedModifiedFiles + ' file(s) you changed.' } else { '' })
      foreach ($box in $boxes.Values) { if ($script:removalSelection -contains $box.Tag) { $box.Checked = $false; $box.Enabled = $false } }
      $cancel.Text = 'Close'
    } else { $status.Text = $errorOutput.Trim() }
    $script:removalProcess.Dispose(); $script:removalProcess = $null
    $remove.Enabled = $true; $allButton.Enabled = $true; $cancel.Enabled = $true
  })
  $form.Add_FormClosing({ if ($script:removalProcess -and -not $script:removalProcess.HasExited) { $_.Cancel = $true } })
  $uninstallScript = $MyInvocation.MyCommand.Path
  $remove.Add_Click({
    $selected = @($boxes.Values | Where-Object { $_.Checked -and $_.Enabled } | ForEach-Object { [string]$_.Tag })
    if ($selected.Count -eq 0) { $status.Text = 'Select at least one component.'; return }
    $remove.Enabled = $false; $allButton.Enabled = $false; $cancel.Enabled = $false
    $status.Text = 'Removing selected programs... You can minimize this window.'
    try {
      $info = New-Object Diagnostics.ProcessStartInfo
      $info.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $info.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $uninstallScript + '" -InstallDir "' + $InstallDir + '" -Component ' + ($selected -join ',')
      $info.WorkingDirectory = [IO.Path]::GetTempPath(); $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
      $script:removalSelection = $selected; $script:removalProcess = [Diagnostics.Process]::Start($info); $timer.Start()
    } catch { $status.Text = $_.Exception.Message; $remove.Enabled = $true; $allButton.Enabled = $true; $cancel.Enabled = $true }
  })
  $null = $form.ShowDialog(); $timer.Dispose(); $form.Dispose(); exit 0
}
try { Remove-ZaicodeSuiteComponents $InstallDir $wanted | ConvertTo-Json -Depth 4; exit 0 }
catch { Write-Error $_.Exception.Message; exit 1 }
