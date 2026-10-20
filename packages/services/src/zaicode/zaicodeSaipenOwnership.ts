import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ZaicodeAuditLoopOwnershipAnswer } from "./zaicodeAuditLoopService.js";

/**
 * Canonical SAIPEN Ownership & Admission Adapter (T-291, Workstream 1).
 *
 * Connects the ZAICODE Audit Loop to SAIPEN's authoritative launcher query
 * (`saipen status --json`), ensuring governed projects mutate source only when
 * proven unowned or authorized.
 *
 * Rules (SRC-202 / T-291):
 * 1. An unowned authorized SAIPEN project can proceed.
 * 2. A project with a foreign owner refuses remediation (SAIPEN_OWNERSHIP_REJECTED).
 * 3. An unavailable authority fails closed (OWNERSHIP_QUERY_UNAVAILABLE).
 * 4. A stale authority snapshot (drifted disk state or generation) is refused.
 * 5. A non-SAIPEN workspace preserves its existing policy.
 * 6. Never invent approval from the absence of a BOARD row for a claimed ticket.
 * 7. Never compare SAIPEN owner strings directly with unrelated ZAICODE agent IDs.
 * 8. Recheck authority immediately before source-changing remediation.
 */

export const SAIPEN_STATUS_TIMEOUT_MS = 15_000;
export const SAIPEN_STATUS_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface ZaicodeSaipenOwnershipDeps {
  /** Test/custom hook to execute the launcher. */
  runLauncher?: (launcher: string, args: string[], projectPath: string) => Promise<string>;
  /** Test/custom hook to resolve SAIPEN_HOME. */
  resolveHome?: (projectPath: string) => Promise<string | null>;
  /** Timestamp provider. */
  now?: () => number;
  /** Logger for diagnostics. */
  logger?: { warn(message: string, error?: unknown): void; info?(message: string): void };
  /** Explicitly authorized SAIPEN owner name for this runner, if any. */
  authorizedOwner?: string | null;
}

export interface ParsedBoardDoingTicket {
  id: string;
  description: string;
  owner: string | null;
  claimTime: string | null;
  claimSession: string | null;
}

/**
 * Parse tickets in the ## DOING section of BOARD.md.
 */
export function parseBoardDoingTickets(boardText: string): ParsedBoardDoingTicket[] {
  const doingStart = boardText.indexOf("## DOING");
  if (doingStart < 0) return [];
  const afterDoing = boardText.slice(doingStart + "## DOING".length);
  const nextSectionMatch = /\r?\n## [A-Z]+/.exec(afterDoing);
  const doingSection = nextSectionMatch ? afterDoing.slice(0, nextSectionMatch.index) : afterDoing;

  const lines = doingSection.split(/\r?\n/);
  const tickets: ParsedBoardDoingTicket[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- [") || !trimmed.includes("]")) continue;
    const match = /^- \[[/ x]\]\s+(T-\d+)\s+([^|]*)(?:\|(.*))?$/.exec(trimmed);
    if (!match) continue;
    const id = match[1];
    const rawDesc = match[2];
    if (!id || rawDesc === undefined) continue;
    const description = rawDesc.trim();
    const fieldsStr = match[3] ?? "";
    const fields: Record<string, string> = {};
    for (const part of fieldsStr.split("|")) {
      const fieldMatch = /^\s*([a-zA-Z0-9_]+)\s*:\s*(.*?)\s*$/.exec(part);
      if (fieldMatch && fieldMatch[1] && fieldMatch[2] !== undefined) {
        fields[fieldMatch[1]] = fieldMatch[2];
      }
    }
    tickets.push({
      id,
      description,
      owner: fields.owner || null,
      claimTime: fields.claim_time || null,
      claimSession: fields.claim_session || null,
    });
  }
  return tickets;
}

/**
 * Resolve SAIPEN_HOME from process environment or `.saipen/STATE.md`.
 */
export async function resolveSaipenHome(
  projectPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (env.SAIPEN_HOME?.trim()) return env.SAIPEN_HOME.trim();
  try {
    const statePath = join(projectPath, ".saipen", "STATE.md");
    if (!existsSync(statePath)) return null;
    const state = readFileSync(statePath, "utf8");
    const match = /^saipen_home:\s*"?([^"\r\n]+)"?\s*$/m.exec(state);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Locate the saipen launcher executable in SAIPEN_HOME.
 */
export function resolveSaipenLauncher(home: string): string | null {
  const launcherName = process.platform === "win32" ? "saipen.cmd" : "saipen";
  const primary = join(home, "bin", launcherName);
  if (existsSync(primary)) return primary;

  // Well-known machine installation path fallback on Windows
  if (process.platform === "win32") {
    const machineFallback = "C:\\ProgramData\\SAI\\SAIPEN\\bin\\saipen.cmd";
    if (existsSync(machineFallback)) return machineFallback;
  }
  return null;
}

/**
 * Default production launcher runner invoking `saipen status --json`.
 */
export function runLauncherDefault(
  launcher: string,
  args: string[],
  projectPath: string,
  timeoutMs = SAIPEN_STATUS_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (/["%\r\n]/.test(launcher) || /["%\r\n]/.test(projectPath)) {
      reject(new Error("path contains characters that cannot be passed to the SAIPEN launcher safely"));
      return;
    }

    const isWindows = process.platform === "win32";
    const quotedArgs = args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg));
    const command = `""${launcher}" ${quotedArgs.join(" ")}"`;

    const child = isWindows
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
          cwd: projectPath,
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(launcher, args, {
          cwd: projectPath,
          stdio: ["ignore", "pipe", "pipe"],
        });

    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`saipen status did not answer in ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < SAIPEN_STATUS_MAX_OUTPUT_BYTES) {
        output += chunk.toString("utf8");
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !output.includes("{")) {
        reject(new Error(`saipen launcher exited with code ${code}`));
        return;
      }
      resolve(output);
    });
  });
}

/**
 * Query SAIPEN ownership and authority for a workspace.
 */
export async function querySaipenOwnership(
  workspacePath: string,
  deps: ZaicodeSaipenOwnershipDeps = {},
): Promise<ZaicodeAuditLoopOwnershipAnswer> {
  const saipenDir = join(workspacePath, ".saipen");
  if (!existsSync(saipenDir)) {
    // Non-SAIPEN workspace preserves its existing policy
    return {
      authoritative: true,
      foreign: false,
      detail: "workspace is not governed by SAIPEN (no .saipen memory)",
    };
  }

  const statePath = join(saipenDir, "STATE.md");
  const boardPath = join(saipenDir, "BOARD.md");
  if (!existsSync(statePath)) {
    return {
      authoritative: false,
      foreign: false,
      detail: "governed workspace is missing .saipen/STATE.md",
    };
  }
  if (!existsSync(boardPath)) {
    return {
      authoritative: false,
      foreign: false,
      detail: "governed workspace is missing .saipen/BOARD.md",
    };
  }

  // Pre-query snapshot for freshness validation
  let stateStatBefore;
  let boardStatBefore;
  let stateContent: string;
  try {
    stateStatBefore = statSync(statePath);
    boardStatBefore = statSync(boardPath);
    stateContent = readFileSync(statePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      authoritative: false,
      foreign: false,
      detail: `failed to read pre-query workspace state: ${detail}`,
    };
  }

  const lastEventMatch = /^last_event:\s*"?(\d+)"?\s*$/m.exec(stateContent);
  const stateLastEvent = lastEventMatch?.[1] ?? null;

  // Resolve launcher
  const home = deps.resolveHome
    ? await deps.resolveHome(workspacePath)
    : await resolveSaipenHome(workspacePath);

  const launcher = home ? resolveSaipenLauncher(home) : null;
  if (!launcher) {
    return {
      authoritative: false,
      foreign: false,
      detail: `SAIPEN launcher executable could not be resolved (home=${home ?? "none"})`,
    };
  }

  // Run launcher query
  const runner = deps.runLauncher ?? runLauncherDefault;
  let output: string;
  try {
    output = await runner(launcher, ["status", "--json", "--project-root", workspacePath], workspacePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.logger?.warn?.(`ZAICODE audit loop: SAIPEN status query failed: ${detail}`);
    return {
      authoritative: false,
      foreign: false,
      detail: `SAIPEN status query failed: ${detail}`,
    };
  }

  // Extract JSON payload
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return {
      authoritative: false,
      foreign: false,
      detail: "SAIPEN launcher output contains no valid JSON object",
    };
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return {
      authoritative: false,
      foreign: false,
      detail: "SAIPEN launcher output JSON is unparsable",
    };
  }

  // Gate on SAIPEN response validity
  if (raw.ok !== true) {
    const code = typeof raw.code === "string" ? raw.code : "UNKNOWN";
    const reason = typeof raw.detail === "string" ? raw.detail : typeof raw.reason === "string" ? raw.reason : "failed";
    return {
      authoritative: false,
      foreign: false,
      detail: `SAIPEN reported ok: false (${code}: ${reason})`,
    };
  }

  if (raw.recovery_pending === true || raw.recovery_conflict === true) {
    return {
      authoritative: false,
      foreign: false,
      detail: "SAIPEN has an unfinished recovery operation in progress",
    };
  }

  if (Array.isArray(raw.board_errors) && raw.board_errors.length > 0) {
    return {
      authoritative: false,
      foreign: false,
      detail: `SAIPEN reports board error(s): ${raw.board_errors.join("; ")}`,
    };
  }

  // Post-query freshness check: ensure files did not drift while querying
  try {
    const stateStatAfter = statSync(statePath);
    const boardStatAfter = statSync(boardPath);
    if (
      stateStatAfter.mtimeMs !== stateStatBefore.mtimeMs ||
      stateStatAfter.size !== stateStatBefore.size ||
      boardStatAfter.mtimeMs !== boardStatBefore.mtimeMs ||
      boardStatAfter.size !== boardStatBefore.size
    ) {
      return {
        authoritative: false,
        foreign: false,
        detail: "workspace state was modified concurrently during authority query (stale snapshot)",
      };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      authoritative: false,
      foreign: false,
      detail: `failed to verify post-query freshness: ${detail}`,
    };
  }

  // Execution generation freshness
  if (stateLastEvent && raw.log_tail_event != null && String(raw.log_tail_event) !== String(stateLastEvent)) {
    return {
      authoritative: false,
      foreign: false,
      detail: `stale status response: log tail event (${raw.log_tail_event}) does not match STATE.md last_event (${stateLastEvent})`,
    };
  }

  // Evaluate ownership from BOARD and status
  let boardText: string;
  try {
    boardText = readFileSync(boardPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      authoritative: false,
      foreign: false,
      detail: `failed to re-read BOARD.md: ${detail}`,
    };
  }

  const doingTickets = parseBoardDoingTickets(boardText);
  const claimedTicket =
    typeof raw.claimed_ticket === "string" &&
    raw.claimed_ticket.trim() &&
    raw.claimed_ticket.trim().toLowerCase() !== "none"
      ? raw.claimed_ticket.trim()
      : null;

  if (claimedTicket) {
    const matching = doingTickets.find((t) => t.id === claimedTicket);
    if (!matching) {
      // Invariant 8: Do not invent approval from the absence of a BOARD row
      return {
        authoritative: false,
        foreign: false,
        detail: `claimed ticket ${claimedTicket} is absent from BOARD.md ## DOING`,
      };
    }

    const owner = matching.owner;
    const claimTime = matching.claimTime;

    if (deps.authorizedOwner && owner === deps.authorizedOwner) {
      return {
        authoritative: true,
        foreign: false,
        detail: `${claimedTicket} is claimed by authorized owner '${owner}'`,
      };
    }

    if (owner) {
      return {
        authoritative: true,
        foreign: true,
        detail: `${claimedTicket} is claimed by owner '${owner}'${claimTime ? ` at ${claimTime}` : ""}`,
      };
    }

    return {
      authoritative: true,
      foreign: false,
      detail: `${claimedTicket} is in ## DOING without an owner`,
    };
  }

  // No claimed ticket reported by status
  if (doingTickets.length > 0) {
    return {
      authoritative: false,
      foreign: false,
      detail: `status reports no claimed ticket, but BOARD.md contains ${doingTickets.length} ticket(s) in ## DOING`,
    };
  }

  // Genuinely unowned and authorized
  return {
    authoritative: true,
    foreign: false,
    detail: "unowned authorized SAIPEN project (no active claim in ## DOING)",
  };
}

/**
 * Factory for injecting into ZaicodeAuditLoopService dependencies.
 */
export function createZaicodeSaipenOwnershipQuery(
  deps: ZaicodeSaipenOwnershipDeps = {},
): (workspacePath: string) => Promise<ZaicodeAuditLoopOwnershipAnswer> {
  return (workspacePath: string) => querySaipenOwnership(workspacePath, deps);
}
