import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RouterHealth } from "./zaicodeRouterSupervisor.js";

const execute = promisify(execFile);

/** PID of this listener; null proves absence, undefined means inspection was unavailable/ambiguous. */
export async function localRouterListenerPid(url: string, excluded: readonly number[] = []): Promise<number | null | undefined> {
  const port = Number(new URL(url).port || 80);
  try {
    if (process.platform === "win32") {
      const command = `$listener = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess); if ($listener.Count) { $listener[0] } else { $candidate = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '9router' -and $_.Name -match '^(node|ZAICODE)\\.exe$' -and $_.ProcessId -notin @(${excluded.join(",") || "0"}) }); if ($candidate.Count) { 'unknown' } else { 'absent' } }`;
      const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 4000 });
      const value = stdout.trim();
      return value === "absent" ? null : /^\d+$/.test(value) ? Number(value) : undefined;
    }
    try {
      const { stdout } = await execute("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 3000 });
      const pid = Number(stdout.trim().split(/\s+/)[0]);
      if (pid > 0) return pid;
    } catch { /* Inspect the process list before proving absence. */ }
    const { stdout } = await execute("ps", ["-eo", "pid=,args="], { timeout: 3000 });
    return stdout.split(/\r?\n/).some((line) => /9router/.test(line) && !excluded.includes(Number(line.trim().split(/\s+/)[0]))) ? undefined : null;
  } catch { return undefined; }
}

/** A healthy API binds the observed process; its later disappearance is distinct from a transient socket failure. */
export class ZaicodeRouterHealthProbe {
  #observedPid: number | null = null;
  constructor(private readonly url: string, private readonly listener: () => Promise<number | null | undefined>, private readonly ownedPid: () => number | null = () => null) {}
  async probe(): Promise<RouterHealth> {
    try {
      const response = await fetch(`${this.url}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return "api-unhealthy";
      if (this.#observedPid === null) this.#observedPid = (await this.listener()) ?? null;
      return "healthy";
    } catch {
      const pid = this.ownedPid() ?? this.#observedPid;
      if (pid !== null) {
        try { process.kill(pid, 0); return "connection-failure"; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { this.#observedPid = null; return "process-unavailable"; } }
      }
      const listener = await this.listener();
      if (typeof listener === "number") this.#observedPid = listener;
      return listener === null ? "process-unavailable" : "connection-failure";
    }
  }
}
