// T-295 (SRC-208): whose continuation a recognized `cc`/STEP actually is.
//
// One token, two possible owners. The ZAICODE session goal machinery this host
// already owns is one of them; the SAIPEN project's canonical continuation
// boundary (`saipen continue --json`) is the other. T-284 admitted every
// recognized token into the first one only, so a SAIPEN project whose session
// had no goal row -- or a completed one -- answered the operator's `cc` with
// `guard.recognizedContinueWithoutGoal` / `guard.recognizedContinueGoalComplete`.
// The unrelated local goal decided a project-domain command.
//
// This module is the single decision point and the thin launcher port:
//
// 1. A continuable session goal owns the command; the T-284 route is unchanged.
// 2. Otherwise `.saipen/` in the project root makes the SAIPEN project the
//    candidate owner -- and the DIRECTORY grants nothing by itself. The
//    launcher's own answer is the authority: an actionable continuation is
//    passed to existing Core execution admission, anything else is refused with the launcher's
//    real disposition instead of a goal-domain error.
// 3. Neither owner -> an explicit refusal. Never a model turn (T-284 rule 1).
//
// Nothing here mints operator authority: admission has already classified the
// provenance (T-283) before this module is reached, and the launcher child
// process preserves declared carriers. Only classified real-user submissions
// supply operatorText for a fresh request-local file; automatic/model calls
// declare no new carrier.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSaipenContinueChildEnv } from "./continue-carrier.js";

/** The SAIPEN project memory directory: the cheap probe, never the authority. */
export const SAIPEN_PROJECT_MEMORY_DIR = ".saipen";

export const SAIPEN_CONTINUE_TIMEOUT_MS = 15_000;
export const SAIPEN_CONTINUE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Exactly one owner per recognized command. */
export type ContinueOwner = "zaicode-goal" | "saipen-project" | "none";

/**
 * The launcher's own disposition, read from its `--json` answer. `ok` is the
 * launcher's verdict; `action`/`ticket` are what it routed to; `detail` is its
 * verbatim refusal reason when it has no eligible continuation.
 *
 * `receipt` is the operator-visible half: an authoritative SAIPEN REFUSAL is not
 * an unavailable launcher (T-295). A refusal that only the operator can clear
 * keeps `operatorActionDue` plus the launcher's own resume instruction, so the
 * side panel can say "safety valve reached -- run cc"; a tripped valve keeps
 * `safetyValveTripped`; the raw launcher code/remediation/exit status survive
 * verbatim in the fields below.
 */
export interface SaipenContinueAnswer {
  ok: boolean;
  receipt: "accepted" | "refused";
  action: string | null;
  /** The exact owner document returned by the router for this action. */
  loadPath?: string | null;
  ticket: string | null;
  detail: string;
  /** SAIPEN's own diagnostic code (`RECONCILE_REAUTH_REQUIRED`), verbatim. */
  code: string | null;
  /** SAIPEN's discriminator: a tripped valve is not an operator decision. */
  remediation: "SAFETY_VALVE_TRIPPED" | "OPERATOR_DECISION" | null;
  /** SAIPEN's resume instruction (`next_action`), the operator's actual next step. */
  nextAction: string | null;
  /** SAIPEN says only the operator can clear this (`operator_action_due`). */
  operatorActionDue: boolean;
  /** The goal safety valve is at/over its admission cap (`safety_valve_tripped`). */
  safetyValveTripped: boolean;
  /** SAIPEN's own next command, e.g. `saipen start --file <carrier path>`. */
  canonicalNextCommand: string | null;
  /** The child's exit status, preserved even on an accepted receipt. */
  exitStatus: number | null;
}

/** The canonical boundary is not reachable (no launcher, timeout, bad answer). */
export class SaipenContinueUnavailableError extends Error {
  constructor(
    message: string,
    readonly code:
      | "SAIPEN_LAUNCHER_UNAVAILABLE"
      | "SAIPEN_LAUNCHER_FAILED"
      | "SAIPEN_LAUNCHER_TIMEOUT"
      | "SAIPEN_LAUNCHER_UNREADABLE_ANSWER",
    readonly diagnostics?: { exitStatus: number | null },
  ) {
    super(message);
    this.name = "SaipenContinueUnavailableError";
  }
}

/** Does this project carry SAIPEN memory? Necessary, never sufficient. */
export function hasSaipenProjectMemory(workspacePath: string): boolean {
  if (!workspacePath) return false;
  try {
    return existsSync(join(workspacePath, SAIPEN_PROJECT_MEMORY_DIR));
  } catch {
    return false;
  }
}

/**
 * Deterministic domain selection, in this order and no other:
 *
 * 1. `sessionGoalContinuable` -> the session goal owns it (T-284 preserved).
 * 2. otherwise a SAIPEN project -> the project boundary owns it.
 * 3. otherwise -> no owner: refuse explicitly.
 *
 * A complete or absent session goal never makes a project-domain command
 * "without a goal" or "complete" — that is exactly the mislabelling T-295 fixes.
 */
export function resolveContinueOwner(input: {
  sessionGoalContinuable: boolean;
  saipenProject: boolean;
}): ContinueOwner {
  if (input.sessionGoalContinuable) return "zaicode-goal";
  return input.saipenProject ? "saipen-project" : "none";
}

/** A goal row that this host can really continue (absent/complete/limited/paused cannot). */
export function isSessionGoalContinuable(target: { status?: string | null } | null | undefined): boolean {
  if (!target) return false;
  return target.status === "active";
}

/** SAIPEN_HOME from the environment, else the project's own STATE.md. */
export function resolveSaipenHome(
  projectPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = env.SAIPEN_HOME?.trim();
  if (fromEnv) return fromEnv;
  try {
    const state = readFileSync(join(projectPath, SAIPEN_PROJECT_MEMORY_DIR, "STATE.md"), "utf8");
    const match = /^saipen_home:\s*"?([^"\r\n]+)"?\s*$/m.exec(state);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/** The launcher inside SAIPEN_HOME, with the machine installation as fallback. */
export function resolveSaipenLauncher(
  home: string | null,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const name = platform === "win32" ? "saipen.cmd" : "saipen";
  if (home) {
    const candidate = join(home, "bin", name);
    if (existsSync(candidate)) return candidate;
  }
  if (platform === "win32") {
    const machine = `C:\\ProgramData\\SAI\\SAIPEN\\bin\\${name}`;
    if (existsSync(machine)) return machine;
  }
  return null;
}

/**
 * The launcher's `--json` answer, or a typed failure; never a fabricated verdict.
 *
 * A canonical SAIPEN receipt must carry a boolean `ok` (`Result.to_dict()` always
 * does); anything else is unreadable. The verdict is authoritative on BOTH exit
 * paths: SAIPEN returns a valid JSON refusal with a NONZERO exit, so the exit
 * code is preserved and never by itself turned into an unavailable launcher. A
 * nonzero exit with an `ok:true` receipt is a contradiction -- the process failed,
 * so it authorized nothing -- and is surfaced as a refusal with its exit status,
 * never as a silent continuation.
 */
export function parseSaipenContinueAnswer(
  stdout: string,
  exitStatus: number | null = null,
): SaipenContinueAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new SaipenContinueUnavailableError(
      "the SAIPEN launcher did not answer with JSON",
      "SAIPEN_LAUNCHER_UNREADABLE_ANSWER",
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new SaipenContinueUnavailableError(
      "the SAIPEN launcher answered with a non-object",
      "SAIPEN_LAUNCHER_UNREADABLE_ANSWER",
    );
  }
  const answer = parsed as Record<string, unknown>;
  if (typeof answer.ok !== "boolean") {
    throw new SaipenContinueUnavailableError(
      "the SAIPEN launcher answered without a canonical `ok` verdict",
      "SAIPEN_LAUNCHER_UNREADABLE_ANSWER",
    );
  }
  const text = (key: string): string | null => {
    const value = answer[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  };
  const code = text("code");
  const remediation = text("remediation");
  const rawDetail = text("detail") ?? text("message");
  const nextAction = text("next_action");
  // Never an invented continuation: only an exit 0 with the launcher's own `ok`
  // admits. A refusal on exit 0 is as authoritative as one on exit 1.
  const ok = exitStatus === 0 && answer.ok === true;
  const detail = [code, rawDetail, nextAction].filter(Boolean).join(" — ");
  return {
    ok,
    receipt: ok ? "accepted" : "refused",
    action: ok ? text("action") : null,
    loadPath: ok ? text("load_path") : null,
    ticket: ok ? text("ticket") : null,
    detail:
      detail || (ok ? "" : "the SAIPEN launcher refused without a reason"),
    code,
    remediation:
      remediation === "SAFETY_VALVE_TRIPPED" || remediation === "OPERATOR_DECISION"
        ? remediation
        : null,
    nextAction,
    operatorActionDue: answer.operator_action_due === true,
    safetyValveTripped: answer.safety_valve_tripped === true,
    canonicalNextCommand: text("canonical_next_command"),
    exitStatus,
  };
}

interface LauncherOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Capture the child's result and classify it LATER. A nonzero exit is not a
 * verdict on its own: SAIPEN answers a real refusal with valid canonical JSON
 * on stdout and exit 1, so the result is handed to the receipt parser instead of
 * being turned straight into an unavailable launcher (the T-295 misclass).
 */
function runLauncherProcess(
  launcher: string,
  args: string[],
  projectPath: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<LauncherOutcome> {
  if (/["%\r\n]/.test(launcher) || /["%\r\n]/.test(projectPath)) {
    return Promise.reject(
      new SaipenContinueUnavailableError(
        "the SAIPEN launcher path cannot be passed to the shell safely",
        "SAIPEN_LAUNCHER_UNAVAILABLE",
      ),
    );
  }
  const isWindows = process.platform === "win32";
  // A `.cmd` launcher is a shell script: Node refuses to start one directly
  // (shell-injection hardening), so cmd.exe gets it as its own argv entry and
  // quotes the path itself. Building the command line by hand both lost the
  // quoting and escaped it wrongly.
  const child =
    isWindows && launcher.toLowerCase().endsWith(".cmd")
      ? spawn(process.env.ComSpec?.trim() || "cmd.exe", ["/d", "/c", launcher, ...args], {
          cwd: projectPath,
          env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(launcher, args, { cwd: projectPath, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

  return new Promise<LauncherOutcome>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, value?: LauncherOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        new SaipenContinueUnavailableError(
          `the SAIPEN launcher did not answer within ${timeoutMs}ms`,
          "SAIPEN_LAUNCHER_TIMEOUT",
        ),
      );
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < SAIPEN_CONTINUE_MAX_OUTPUT_BYTES) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < SAIPEN_CONTINUE_MAX_OUTPUT_BYTES) stderr += chunk;
    });
    child.on("error", (error) =>
      finish(
        new SaipenContinueUnavailableError(
          `the SAIPEN launcher could not be started: ${error.message}`,
          "SAIPEN_LAUNCHER_FAILED",
        ),
      ),
    );
    // Capture first: the exit status and both streams survive together so the
    // classification step can read a canonical refusal on a nonzero exit.
    child.on("close", (code) => finish(null, { stdout, stderr, exitCode: code }));
  });
}

/**
 * The default trusted boundary: `saipen continue --json` in the project root.
 *
 * The child environment is derived from this process's environment, so a carrier
 * the session was LAUNCHED with (`SAIPEN_TASK_SHA256`, `SAIPEN_TASK_FILE`)
 * reaches the launcher untouched. Only a REAL operator submission supplies
 * `operatorText`, and it then declares its own exact bytes as the carrier -- a
 * model turn or an automatic continuation declares nothing.
 */
export async function runSaipenContinueLauncher(
  projectPath: string,
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** The operator's verbatim submitted text; never model output. */
    operatorText?: string;
  } = {},
): Promise<SaipenContinueAnswer> {
  const env = options.env ?? process.env;
  const launcher = resolveSaipenLauncher(resolveSaipenHome(projectPath, env));
  if (!launcher) {
    throw new SaipenContinueUnavailableError(
      "no SAIPEN launcher resolved: set SAIPEN_HOME or initialize .saipen/ with saipen_home",
      "SAIPEN_LAUNCHER_UNAVAILABLE",
    );
  }
  const outcome = await runLauncherProcess(
    launcher,
    ["continue", "--json"],
    projectPath,
    options.timeoutMs ?? SAIPEN_CONTINUE_TIMEOUT_MS,
    await buildSaipenContinueChildEnv(env, projectPath, options.operatorText),
  );
  try {
    return parseSaipenContinueAnswer(outcome.stdout, outcome.exitCode);
  } catch (error) {
    // A nonzero exit with no canonical receipt on stdout is a REAL launcher
    // failure (crash, missing interpreter, unparsable text): keep it
    // unavailable, preserving the exit status and its own diagnostic.
    if (error instanceof SaipenContinueUnavailableError && outcome.exitCode !== 0) {
      const diagnostic = outcome.stderr.trim() || outcome.stdout.trim() || "no diagnostic";
      throw new SaipenContinueUnavailableError(
        `the SAIPEN launcher exited ${outcome.exitCode} without a canonical receipt: ${diagnostic}`,
        "SAIPEN_LAUNCHER_FAILED",
        { exitStatus: outcome.exitCode },
      );
    }
    throw error;
  }
}
