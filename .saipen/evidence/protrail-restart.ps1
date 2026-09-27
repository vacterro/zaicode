param([ValidateSet('Inspect', 'Close', 'Start')][string]$Action = 'Inspect')
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$appExe = Join-Path $workspace 'zcode\packages\desktop\dist\win-unpacked\ZAICODE.exe'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class ProtrailRestartWindows {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  public delegate bool EnumProc(IntPtr hwnd, IntPtr arg);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr arg);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
  public static Dictionary<IntPtr,string> List(uint pid) {
    var found = new Dictionary<IntPtr,string>();
    EnumWindows((hwnd,arg) => {
      uint owner; GetWindowThreadProcessId(hwnd,out owner);
      if (owner == pid && IsWindowVisible(hwnd)) {
        var text = new StringBuilder(512); GetWindowText(hwnd,text,text.Capacity);
        found[hwnd] = text.ToString();
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$appProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'ZAICODE.exe'" |
  Where-Object { $_.ExecutablePath -eq $appExe -and $_.CommandLine -notmatch ' --type=| app-server | __zcode-plugin-host ' })
if ($Action -eq 'Start') {
  if ($appProcesses.Count -ne 0) { throw 'Product is still running; staged swap is unsafe.' }
  # User requested the interactive application to reopen visibly.
  Start-Process -FilePath (Join-Path $workspace 'ZAICODE.exe') -WorkingDirectory $workspace -WindowStyle Normal -PassThru |
    Select-Object Id, Path
  exit
}
foreach ($appProcess in $appProcesses) {
  $windows = [ProtrailRestartWindows]::List($appProcess.ProcessId)
  foreach ($entry in $windows.GetEnumerator()) {
    $rect = New-Object ProtrailRestartWindows+Rect
    [void][ProtrailRestartWindows]::GetWindowRect($entry.Key, [ref]$rect)
    [pscustomobject]@{ ProcessId = $appProcess.ProcessId; Handle = $entry.Key; Title = $entry.Value; Bounds = "$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)" }
  }
  if ($Action -ne 'Close') { continue }
  $target = @($windows.GetEnumerator() | Where-Object { $_.Value -and $_.Value -ne 'ZAICODE ProTrail' }) | Select-Object -First 1
  if (-not $target) { throw 'No visible application window; refusing a blind key event.' }
  [void][ProtrailRestartWindows]::SetForegroundWindow($target.Key)
  Start-Sleep -Milliseconds 250
  if ([ProtrailRestartWindows]::GetForegroundWindow() -ne $target.Key) { throw 'Application did not take focus; no keys sent.' }
  # Existing product Shift+close path calls app.quit() and cleans up hosts.
  try {
    [ProtrailRestartWindows]::keybd_event(0x10, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 250
    if ([ProtrailRestartWindows]::GetForegroundWindow() -ne $target.Key) { throw 'Focus changed before close.' }
    [void][ProtrailRestartWindows]::PostMessage($target.Key, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 400
  } finally {
    [ProtrailRestartWindows]::keybd_event(0x10, 0, 2, [UIntPtr]::Zero)
  }
  $process = Get-Process -Id $appProcess.ProcessId -ErrorAction SilentlyContinue
  if ($process -and -not $process.WaitForExit(20000)) { throw 'Graceful quit still pending; no force kill performed.' }
  'Graceful product exit observed.'
}
