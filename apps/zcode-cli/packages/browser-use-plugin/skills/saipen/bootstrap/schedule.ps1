# saipen scheduled inject manager -- Windows Task Scheduler wrapper.
# install (default) -- create/update the 'saipen-inject' task: inject one clean
#                      committed clone state every 15 minutes.
# remove            -- delete the task.
# status            -- task state, last result, next run, log tail.
# run-now           -- trigger the task once immediately.
# The task runs as the current user, only while logged on, no password stored.
# Silent by design: the action is wscript.exe running a generated .vbs that
# spawns powershell.exe with a hidden window (style 0). wscript is a GUI
# subsystem binary, so no console window is ever created -- nothing flashes.

param([string]$Command = "install")

$ErrorActionPreference = "Stop"

$TaskName = "saipen-inject"
$LegacyTaskName = "saipen-autoinject"
$Runner = Join-Path $PSScriptRoot "schedule-run.ps1"
$RuntimeDir = Join-Path $env:LOCALAPPDATA "saipen"
$VbsPath = Join-Path $RuntimeDir "schedule-run-hidden.vbs"
$PublishedSource = Join-Path $RuntimeDir "scheduled-source"
$LogFile = Join-Path $RuntimeDir "inject.log"

function Write-AtomicFile([string]$Path, [byte[]]$Bytes) {
  $directory = Split-Path -Parent $Path
  [System.IO.Directory]::CreateDirectory($directory) | Out-Null
  $temporary = Join-Path $directory (".{0}.{1}.tmp" -f
    [System.IO.Path]::GetFileName($Path), [System.Guid]::NewGuid().ToString("N"))
  try {
    [System.IO.File]::WriteAllBytes($temporary, $Bytes)
    if ([System.IO.File]::Exists($Path)) {
      [System.IO.File]::Replace($temporary, $Path, $null)
    } else {
      [System.IO.File]::Move($temporary, $Path)
    }
  } finally {
    if ([System.IO.File]::Exists($temporary)) {
      [System.IO.File]::Delete($temporary)
    }
  }
}

function Get-SchedulerTask([string]$Name) {
  $queryErrors = @()
  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue `
    -ErrorVariable +queryErrors
  $unexpected = @($queryErrors | Where-Object {
    $_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound
  })
  if ($unexpected.Count -gt 0) {
    throw "could not query $Name`: $($unexpected[0].Exception.Message)"
  }
  return $task
}

function Remove-SchedulerTask([string]$Name) {
  try {
    $task = Get-SchedulerTask $Name
  } catch {
    Write-Host "FATAL: $($_.Exception.Message)" -ForegroundColor Red
    return $false
  }
  if (-not $task) {
    Write-Host "Not present: $Name" -ForegroundColor DarkGray
    return $true
  }
  schtasks /Delete /TN $Name /F 2>&1 | ForEach-Object { Write-Host $_ }
  $deleteRc = $LASTEXITCODE
  if ($deleteRc -ne 0) {
    Write-Host "FATAL: could not remove $Name (schtasks rc $deleteRc)" -ForegroundColor Red
    return $false
  }
  Write-Host "Removed: $Name" -ForegroundColor Yellow
  return $true
}

function Get-CanonicalWrapperBody {
  return "Set sh = CreateObject(`"WScript.Shell`")`r`n" +
         "rc = sh.Run(`"powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"`"$Runner`"`"`"`, 0, True)`r`n" +
         "WScript.Quit rc`r`n"
}

function Get-TaskXmlTexts([xml]$Xml, [string]$Name) {
  return @($Xml.SelectNodes("//*[local-name()='$Name']") |
    ForEach-Object { $_.InnerText })
}

function Get-SchedulerHealth {
  $task = Get-SchedulerTask $TaskName
  $legacy = Get-SchedulerTask $LegacyTaskName
  $reasons = @()
  $wrapperExists = Test-Path -LiteralPath $VbsPath
  $publishedSourceExists = Test-Path -LiteralPath $PublishedSource

  if (-not $task -and -not $legacy -and -not $wrapperExists -and
      -not $publishedSourceExists) {
    return [pscustomobject]@{
      Status = "NOT_INSTALLED"; Reasons = @(); Task = $null; Legacy = $null
    }
  }
  if (-not $task) { $reasons += "canonical task missing: $TaskName" }
  if (-not $task -and $publishedSourceExists) {
    $reasons += "orphan scheduled source present: $PublishedSource"
  }
  if (@($task).Count -gt 1) {
    $reasons += "multiple canonical tasks found: $TaskName"
  } elseif ($task -and [string]$task.State -eq "Disabled") {
    $reasons += "canonical task is disabled: $TaskName"
  }
  if ($legacy) { $reasons += "duplicate legacy task present: $LegacyTaskName" }
  if ($task -and @($task).Count -eq 1) {
    try {
      [xml]$taskXml = Export-ScheduledTask -TaskName $TaskName
      $exec = @(Get-TaskXmlTexts $taskXml "Command")
      $arguments = @(Get-TaskXmlTexts $taskXml "Arguments")
      $userId = @(Get-TaskXmlTexts $taskXml "UserId")
      $logonType = @(Get-TaskXmlTexts $taskXml "LogonType")
      $settingsEnabled = @($taskXml.SelectNodes(
        "//*[local-name()='Settings']/*[local-name()='Enabled']") |
        ForEach-Object { $_.InnerText })
      $multiple = @(Get-TaskXmlTexts $taskXml "MultipleInstancesPolicy")
      $limit = @(Get-TaskXmlTexts $taskXml "ExecutionTimeLimit")
      $start = @(Get-TaskXmlTexts $taskXml "StartWhenAvailable")
      $batteryStart = @(Get-TaskXmlTexts $taskXml "DisallowStartIfOnBatteries")
      $batteryStop = @(Get-TaskXmlTexts $taskXml "StopIfGoingOnBatteries")
      $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      if ($userId.Count -ne 1 -or $userId[0] -ne $currentSid -or
          $logonType.Count -ne 1 -or $logonType[0] -ne "InteractiveToken") {
        $reasons += "task principal is not the current interactive user"
      }
      # Whether schtasks keeps or strips the quotes install passes to /TR is a
      # HOST detail, not a contract: Windows 10 Pro 19045 stores
      # `"C:\...\schedule-run-hidden.vbs"` verbatim, and demanding the bare
      # form reported a freshly and correctly installed task as DEGRADED.
      # So exactly one layer of surrounding double quotes is removed, and the
      # result must then equal the canonical path EXACTLY -- extra arguments,
      # another path or another executable still fail, which is the
      # anti-laundering property this check exists for.
      $storedArgument = if ($arguments.Count -eq 1) { $arguments[0].Trim() } else { $null }
      if ($storedArgument -and $storedArgument.Length -ge 2 -and
          $storedArgument.StartsWith('"') -and $storedArgument.EndsWith('"')) {
        $storedArgument = $storedArgument.Substring(1, $storedArgument.Length - 2)
      }
      if ($exec.Count -ne 1 -or
          $exec[0] -ine "wscript.exe" -or $arguments.Count -ne 1 -or
          $storedArgument -ne $VbsPath) {
        $reasons += "task action does not execute the canonical VBS wrapper"
      }
      $triggers = @($taskXml.SelectNodes("//*[local-name()='Triggers']/*"))
      $interval = @()
      $duration = @()
      $endBoundary = @()
      $stopAtDurationEnd = @()
      $triggerEnabled = @()
      if ($triggers.Count -eq 1 -and $triggers[0].LocalName -eq "TimeTrigger") {
        $interval = @($triggers[0].SelectNodes(
          "./*[local-name()='Repetition']/*[local-name()='Interval']") |
          ForEach-Object { $_.InnerText })
        $duration = @($triggers[0].SelectNodes(
          "./*[local-name()='Repetition']/*[local-name()='Duration']") |
          ForEach-Object { $_.InnerText })
        $endBoundary = @($triggers[0].SelectNodes("./*[local-name()='EndBoundary']"))
        $stopAtDurationEnd = @($triggers[0].SelectNodes(
          "./*[local-name()='Repetition']/*[local-name()='StopAtDurationEnd']") |
          ForEach-Object { $_.InnerText })
        $triggerEnabled = @($triggers[0].SelectNodes(
          "./*[local-name()='Enabled']") | ForEach-Object { $_.InnerText })
      }
      if ($triggers.Count -ne 1 -or $triggers[0].LocalName -ne "TimeTrigger" -or
          $interval.Count -ne 1 -or $interval[0] -ne "PT15M" -or
          $duration.Count -ne 0 -or $endBoundary.Count -ne 0 -or
          $stopAtDurationEnd.Count -gt 1 -or
          ($stopAtDurationEnd.Count -eq 1 -and $stopAtDurationEnd[0] -ine "false") -or
          $triggerEnabled.Count -gt 1 -or
          ($triggerEnabled.Count -eq 1 -and $triggerEnabled[0] -ine "true")) {
        $reasons += "task trigger is not the canonical 15-minute interval"
      }
      # schtasks + Set-ScheduledTask omit <Enabled> when the task is enabled
      # (it is the default), so the canonical shape has zero or one <Enabled>
      # whose value is "true"; "false" or a duplicate is a real drift.
      if ($settingsEnabled.Count -gt 1 -or
          ($settingsEnabled.Count -eq 1 -and $settingsEnabled[0] -ine "true") -or
          $multiple.Count -ne 1 -or $multiple[0] -ne "IgnoreNew" -or
          $limit.Count -ne 1 -or $limit[0] -ne "PT10M" -or
          $start.Count -ne 1 -or $start[0] -ine "true" -or
          $batteryStart.Count -ne 1 -or $batteryStart[0] -ine "false" -or
          $batteryStop.Count -ne 1 -or $batteryStop[0] -ine "false") {
        $reasons += "task settings differ from the canonical runtime policy"
      }
    } catch {
      $reasons += "task definition unreadable: $($_.Exception.Message)"
    }
  }
  if (-not $wrapperExists) {
    $reasons += "VBS wrapper missing: $VbsPath"
  } else {
    try {
      $wrapperBody = [System.IO.File]::ReadAllText($VbsPath)
      if ($wrapperBody -cne (Get-CanonicalWrapperBody)) {
        $reasons += "VBS wrapper differs from the canonical command body"
      }
    } catch {
      $reasons += "VBS wrapper unreadable: $($_.Exception.Message)"
    }
    if (-not (Test-Path -LiteralPath $Runner)) {
      $reasons += "referenced runner missing: $Runner"
    }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "inject.ps1"))) {
    $reasons += "injector missing next to scheduler runner"
  }
  $status = if ($reasons.Count -eq 0) { "HEALTHY" } else { "DEGRADED" }
  return [pscustomobject]@{
    Status = $status; Reasons = $reasons; Task = $task; Legacy = $legacy
  }
}

switch ($Command) {
  "install" {
    if (-not (Test-Path $Runner)) {
      Write-Host "FATAL: $Runner missing" -ForegroundColor Red; exit 1
    }
    if (-not (Test-Path (Join-Path $PSScriptRoot "inject.ps1"))) {
      Write-Host "FATAL: inject.ps1 missing next to $PSScriptRoot" -ForegroundColor Red; exit 1
    }
    # schtasks /SC MINUTE /MO N is the battle-tested way to repeat every N
    # minutes INDEFINITELY. New-ScheduledTaskTrigger -RepetitionDuration
    # cannot say "forever": [TimeSpan]::MaxValue serializes past the Task
    # Scheduler range check (HRESULT 0x80041318) and any finite value stops
    # repeating. Default principal = current logged-on user, interactive.
    # wscript.exe (a GUI subsystem binary) never allocates a console, and the
    # generated .vbs spawns powershell.exe with window style 0 -- the task is
    # fully invisible. A path that may contain spaces is handled by the
    # VBScript "" escape around the -File argument.
    $vbsBody = Get-CanonicalWrapperBody
    $taskTouched = $false
    $wrapperWritten = $false
    $wrapperExisted = $false
    $previousWrapper = $null
    $previousTaskXml = $null
    try {
      # Snapshot an existing install before /F replaces it. Failed upgrades
      # restore both task XML and wrapper bytes instead of deleting a working
      # scheduler that happened to predate this run.
      $existingTask = Get-SchedulerTask $TaskName
      if ($existingTask) {
        $previousTaskXml = Export-ScheduledTask -TaskName $TaskName
      }
      $wrapperExisted = [System.IO.File]::Exists($VbsPath)
      if ($wrapperExisted) {
        $previousWrapper = [System.IO.File]::ReadAllBytes($VbsPath)
      }
      # Build settings before changing machine state so cmdlet errors leave no
      # partial task or generated wrapper behind.
      $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
      $unicode = [System.Text.Encoding]::Unicode
      $preamble = $unicode.GetPreamble()
      $encodedBody = $unicode.GetBytes($vbsBody)
      $vbsBytes = New-Object byte[] ($preamble.Length + $encodedBody.Length)
      [System.Buffer]::BlockCopy($preamble, 0, $vbsBytes, 0, $preamble.Length)
      [System.Buffer]::BlockCopy($encodedBody, 0, $vbsBytes, $preamble.Length, $encodedBody.Length)
      Write-AtomicFile $VbsPath $vbsBytes
      $wrapperWritten = $true
      $tr = "wscript.exe `"$VbsPath`""
      $taskTouched = $true
      schtasks /Create /TN $TaskName /TR $tr /SC MINUTE /MO 15 /F 2>&1 | ForEach-Object { Write-Host $_ }
      $createRc = $LASTEXITCODE
      if ($createRc -ne 0) { throw "schtasks /Create failed (rc $createRc)" }
      # Tighten the defaults: kill a hung run at 10 minutes (a git credential
      # wait or a dead network must never occupy a 72-hour default), never stack
      # overlapping runs, and fire a missed run at the next logon.
      Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null
      if (-not (Remove-SchedulerTask $LegacyTaskName)) {
        throw "legacy task migration failed"
      }
    } catch {
      $reason = $_.Exception.Message
      $rollbackFailures = @()
      $taskRollbackOk = $true
      if ($taskTouched) {
        if ($null -ne $previousTaskXml) {
          try {
            Register-ScheduledTask -TaskName $TaskName -Xml $previousTaskXml -Force | Out-Null
          } catch {
            $rollbackFailures += "$TaskName task XML"
            $taskRollbackOk = $false
          }
        } elseif (-not (Remove-SchedulerTask $TaskName)) {
          $rollbackFailures += $TaskName
          $taskRollbackOk = $false
        }
      }
      # If task restoration failed, keep the new wrapper so the remaining new
      # task is still runnable. The nonzero result names incomplete rollback.
      if ($wrapperWritten -and $taskRollbackOk) {
        try {
          if ($wrapperExisted) {
            Write-AtomicFile $VbsPath $previousWrapper
          } elseif (Test-Path -LiteralPath $VbsPath) {
            Remove-Item -LiteralPath $VbsPath -Force -ErrorAction Stop
          }
        } catch {
          $rollbackFailures += $VbsPath
        }
      }
      if ($rollbackFailures.Count -gt 0) {
        Write-Host "FATAL: scheduler install failed ($reason); rollback incomplete: $($rollbackFailures -join ', ')" -ForegroundColor Red
        exit 1
      }
      Write-Host "FATAL: scheduler install rolled back: $reason" -ForegroundColor Red
      exit 1
    }
    Write-Host "Installed: $TaskName -- every 15 min, log -> $LogFile" -ForegroundColor Green
  }
  "remove" {
    $failed = $false
    foreach ($name in @($TaskName, $LegacyTaskName)) {
      if (-not (Remove-SchedulerTask $name)) { $failed = $true }
    }
    if ($failed) {
      Write-Host "FATAL: scheduler cleanup incomplete; wrapper preserved for any remaining task" -ForegroundColor Red
      exit 1
    }
    foreach ($path in @($VbsPath, $PublishedSource)) {
      if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Recurse -Force
        Write-Host "Removed: $path" -ForegroundColor DarkGray
      }
    }
    if (Test-Path -LiteralPath $RuntimeDir) {
      Get-ChildItem -LiteralPath $RuntimeDir -Force |
        Where-Object {
          $_.Name -like "scheduled-source-previous*" -or
          $_.Name -like "source-*" -or
          $_.Name -like "inject-*.log"
        } |
        ForEach-Object {
          Remove-Item -LiteralPath $_.FullName -Recurse -Force
          Write-Host "Removed: $($_.FullName)" -ForegroundColor DarkGray
        }
    }
  }
  "status" {
    try {
      $health = Get-SchedulerHealth
    } catch {
      Write-Host "FATAL: $($_.Exception.Message)" -ForegroundColor Red
      exit 1
    }
    if ($health.Status -eq "NOT_INSTALLED") {
      Write-Host "STATUS: NOT_INSTALLED"
      Write-Host "Install: powershell -ExecutionPolicy Bypass -File $($MyInvocation.MyCommand.Path) install" -ForegroundColor DarkGray
      exit 1
    }
    if ($health.Status -eq "DEGRADED") {
      Write-Host "STATUS: DEGRADED" -ForegroundColor Yellow
      foreach ($reason in $health.Reasons) { Write-Host "REASON: $reason" }
      exit 2
    }
    try {
      $info = Get-ScheduledTaskInfo -TaskName $TaskName
    } catch {
      Write-Host "STATUS: DEGRADED" -ForegroundColor Yellow
      Write-Host "REASON: task info unavailable: $($_.Exception.Message)"
      exit 2
    }
    Write-Host "STATUS: HEALTHY" -ForegroundColor Green
    Write-Host ("State            : {0}" -f $health.Task.State)
    Write-Host ("Last run result  : {0}" -f $info.LastTaskResult)
    Write-Host ("Last run time    : {0}" -f $info.LastRunTime)
    Write-Host ("Next run time    : {0}" -f $info.NextRunTime)
    if (Test-Path $LogFile) {
      Write-Host ("Log ({0}), tail:" -f $LogFile)
      Get-Content -LiteralPath $LogFile -Tail 12
    }
  }
  "run-now" {
    try {
      $health = Get-SchedulerHealth
    } catch {
      Write-Host "FATAL: $($_.Exception.Message)" -ForegroundColor Red
      exit 1
    }
    if ($health.Status -ne "HEALTHY") {
      Write-Host "REFUSED: scheduler status is $($health.Status)" -ForegroundColor Red
      foreach ($reason in $health.Reasons) { Write-Host "REASON: $reason" }
      if ($health.Status -eq "DEGRADED") { exit 2 }
      exit 1
    }
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Triggered: $TaskName (log -> $LogFile)" -ForegroundColor Green
  }
  default {
    Write-Host "usage: schedule.ps1 [install|remove|status|run-now] (default: install)" -ForegroundColor Yellow
    exit 1
  }
}
