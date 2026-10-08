const { execFileSync } = require('node:child_process');
const start = Date.now();
const command = "$listener = @(Get-NetTCPConnection -LocalPort 29220 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess); if ($listener.Count) { $listener[0] } else { $candidate = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '9router' -and $_.Name -match '^(node|ZAICODE)\\.exe$' }); if ($candidate.Count) { 'unknown' } else { 'absent' } }";
try { console.log(JSON.stringify({ at: new Date().toISOString(), stdout: execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',command], { encoding: 'utf8', timeout: 4000 }).trim(), elapsedMs: Date.now()-start })); }
catch(error) { console.log(JSON.stringify({ error: String(error), elapsedMs: Date.now()-start })); process.exitCode = 1; }
