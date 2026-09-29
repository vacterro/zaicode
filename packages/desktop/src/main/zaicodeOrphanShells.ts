// Orphaned agent shells (T-133).
//
// An agent's Bash tool runs `bash -c ". <storage>/cli/exec/bash-startup/... \n <command>"`. A command that outlives
// the foreground deadline moves to the background with no end, and the agent runtime that owns it is meant to kill
// its tree when it stops. On the operator's machine that did not happen: three `node --test | grep` pipelines an
// agent started on 27.09 were still running three days and two app restarts later, their owner (a `zcode.cjs
// app-server`) long gone, and the bundled ugrep one of them held kept the launcher from pruning an old build folder
// at every start.
//
// So ZAICODE sweeps. A shell carrying the agent's startup signature whose parent process no longer exists (or whose
// parent PID now belongs to a younger process) has no owner left to read its output or stop it; it is killed with
// its whole tree. A shell whose owner lives -- this app's agents, another app's, a terminal -- is never touched,
// and nothing is ever selected by image name.
import { execFile } from "node:child_process";
import { join } from "node:path";

export interface ZaicodeProcessRow {
  pid: number;
  parentPid: number;
  name: string;
  /** Only filled for shells; empty for everything else. */
  commandLine: string;
  createdAtMs: number;
}

export interface ZaicodeOrphanShell {
  pid: number;
  parentPid: number;
  createdAtMs: number;
  commandLine: string;
}

/** The sources an agent's Bash tool puts in front of every command (upstream bash-startup-script.ts). */
export const ZAICODE_AGENT_SHELL_SIGNATURE = /[\\/]cli[\\/]exec[\\/](?:bash-startup|shell-snapshots)[\\/]/i;
const SHELL_IMAGE = /^(?:ba)?sh(?:\.exe)?$/i;
/** A shell is only swept once it is this old: an owner that is shutting down gets time to kill its own tree. */
export const ZAICODE_ORPHAN_SHELL_MIN_AGE_MS = 5 * 60_000;
const FIRST_SWEEP_DELAY_MS = 20_000;
const SWEEP_INTERVAL_MS = 30 * 60_000;
const SCAN_TIMEOUT_MS = 20_000;
const KILL_TIMEOUT_MS = 10_000;

export function isZaicodeAgentShell(row: Pick<ZaicodeProcessRow, "name" | "commandLine">): boolean {
  return SHELL_IMAGE.test(row.name) && ZAICODE_AGENT_SHELL_SIGNATURE.test(row.commandLine);
}

/**
 * The roots of orphaned agent shell trees. A root's parent is gone (not in the table, or its PID was reused by a
 * process started after the shell); its forks and children are not listed separately, because killing the root
 * with /T takes them along. Only shells born at or before `cutoffMs` are considered.
 */
export function selectZaicodeOrphanAgentShells(
  rows: readonly ZaicodeProcessRow[],
  cutoffMs: number,
): ZaicodeOrphanShell[] {
  const byPid = new Map<number, ZaicodeProcessRow>();
  for (const row of rows) byPid.set(row.pid, row);
  const orphans: ZaicodeOrphanShell[] = [];
  for (const row of rows) {
    if (!isZaicodeAgentShell(row)) continue;
    if (!(row.createdAtMs > 0) || row.createdAtMs > cutoffMs) continue;
    const parent = byPid.get(row.parentPid);
    const parentIsOwner = parent !== undefined && parent.pid !== row.pid && parent.createdAtMs <= row.createdAtMs;
    if (parentIsOwner) continue;
    orphans.push({
      pid: row.pid,
      parentPid: row.parentPid,
      createdAtMs: row.createdAtMs,
      commandLine: row.commandLine,
    });
  }
  return orphans;
}

/** Parses the scan's JSON: ConvertTo-Json writes one object (not an array) when a single row matches. */
export function parseZaicodeProcessTable(json: string): ZaicodeProcessRow[] {
  const text = json.trim();
  if (!text) return [];
  const parsed: unknown = JSON.parse(text);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const rows: ZaicodeProcessRow[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const pid = Number(record.p);
    const parentPid = Number(record.pp);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0) continue;
    rows.push({
      pid,
      parentPid,
      name: typeof record.n === "string" ? record.n : "",
      commandLine: typeof record.c === "string" ? record.c : "",
      createdAtMs: Number(record.t) || 0,
    });
  }
  return rows;
}

const SYSTEM32 = join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32");

// Command lines are only read for shells, so the table stays small; UTF-8 so a non-ASCII path survives the pipe.
const SCAN_SCRIPT = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "$epoch = [datetime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)",
  "Get-CimInstance Win32_Process | ForEach-Object {",
  "  $shell = $_.Name -match '^(ba)?sh\\.exe$'",
  "  [pscustomobject]@{",
  "    p = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name",
  "    c = if ($shell) { $_.CommandLine } else { '' }",
  "    t = if ($_.CreationDate) { [long]($_.CreationDate.ToUniversalTime() - $epoch).TotalMilliseconds } else { 0 }",
  "  }",
  "} | ConvertTo-Json -Compress",
].join("\n");

export function scanZaicodeProcessTable(): Promise<ZaicodeProcessRow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCAN_SCRIPT],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: SCAN_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(parseZaicodeProcessTable(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

export function killZaicodeProcessTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      join(SYSTEM32, "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      { timeout: KILL_TIMEOUT_MS, windowsHide: true },
      (error) => resolve(!error),
    );
  });
}

export interface ZaicodeOrphanSweepDeps {
  scan: () => Promise<readonly ZaicodeProcessRow[]>;
  kill: (pid: number) => Promise<boolean>;
  log: (message: string) => void;
  now: () => number;
}

export interface ZaicodeOrphanSweepResult {
  found: ZaicodeOrphanShell[];
  killed: number[];
  failed: number[];
}

/** One sweep: scan, pick the orphan roots born before the cutoff, kill each tree. Never throws. */
export async function sweepZaicodeOrphanAgentShells(
  appStartedAtMs: number,
  deps: ZaicodeOrphanSweepDeps,
): Promise<ZaicodeOrphanSweepResult> {
  const result: ZaicodeOrphanSweepResult = { found: [], killed: [], failed: [] };
  let rows: readonly ZaicodeProcessRow[];
  try {
    rows = await deps.scan();
  } catch (error) {
    deps.log(`[zaicode-orphans] process scan failed: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  // Shells from before this app started are fair game at once; later ones only after the owner had time to clean up.
  const cutoffMs = Math.max(appStartedAtMs, deps.now() - ZAICODE_ORPHAN_SHELL_MIN_AGE_MS);
  result.found = selectZaicodeOrphanAgentShells(rows, cutoffMs);
  for (const orphan of result.found) {
    const ok = await deps.kill(orphan.pid);
    (ok ? result.killed : result.failed).push(orphan.pid);
    const age = Math.round((deps.now() - orphan.createdAtMs) / 60_000);
    const command = orphan.commandLine.replace(/\s+/g, " ").slice(-160);
    deps.log(`[zaicode-orphans] ${ok ? "stopped" : "could not stop"} an agent shell left without its owner: pid ${orphan.pid} (parent ${orphan.parentPid} gone), ${age} min old, ...${command}`);
  }
  return result;
}

/** Sweeps once shortly after start, then every half hour. Windows only; the timers never keep the app alive. */
export function startZaicodeOrphanShellSweeps(options: {
  appStartedAtMs: number;
  log: (message: string) => void;
}): () => void {
  if (process.platform !== "win32") return () => {};
  const deps: ZaicodeOrphanSweepDeps = {
    scan: scanZaicodeProcessTable,
    kill: killZaicodeProcessTree,
    log: options.log,
    now: Date.now,
  };
  let running = false;
  const sweep = () => {
    if (running) return;
    running = true;
    void sweepZaicodeOrphanAgentShells(options.appStartedAtMs, deps).finally(() => {
      running = false;
    });
  };
  const first = setTimeout(sweep, FIRST_SWEEP_DELAY_MS);
  const every = setInterval(sweep, SWEEP_INTERVAL_MS);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
