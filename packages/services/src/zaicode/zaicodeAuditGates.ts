import { execFile, type ExecFileException } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ZaicodeAuditLoopRun } from "@zcode/shared";

/**
 * The deterministic acceptance gates a cycle runs (T-289, SRC-202 Phase 2).
 *
 * The commands come from ONE place: a trusted configuration file inside the
 * workspace, `<workspace>/.zcode/audit-gates.json`. They never come from a
 * reviewer's text, a model's suggestion or a chat message, and there is no
 * shell: every gate is an argv array handed to `execFile`, so a metacharacter
 * inside an argument stays an argument. Each run is bounded by a timeout and an
 * output cap, and its full evidence -- real exit code, start, end, timeout,
 * bounded stdout/stderr, source fingerprint -- is persisted next to the cycle's
 * evidence package.
 *
 * A gate set that cannot be resolved is NOT a pass. "Nothing ran" and "the
 * tests passed" must never look the same to the loop, which is why an unusable
 * configuration reports a failing gate rather than an empty list.
 */

export const ZAICODE_AUDIT_GATE_CONFIG_RELATIVE_PATH = ".zcode/audit-gates.json";
export const ZAICODE_AUDIT_GATE_DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const ZAICODE_AUDIT_GATE_MAX_OUTPUT_BYTES = 64 * 1024;
export const ZAICODE_AUDIT_GATE_REPORT_FILE = "gates.json";

export interface ZaicodeAuditGateSpec {
  id: string;
  /** The executable, resolved by the OS lookup -- never a shell string. */
  command: string;
  args: string[];
  timeoutMs: number;
}

export interface ZaicodeAuditGateEvidence {
  id: string;
  command: string;
  args: string[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** The real exit code; null when the process never produced one. */
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** True when the output cap was reached and the tail was dropped. */
  outputTruncated: boolean;
  /** The workspace content identity the gate ran against. */
  sourceFingerprint: string;
  error: string | null;
}

export interface ZaicodeAuditGateReport {
  schemaVersion: 1;
  loopId: string;
  cycle: number;
  sourceFingerprint: string;
  configPath: string;
  /** Non-null when the gate set could not be trusted or parsed at all. */
  configError: string | null;
  gates: ZaicodeAuditGateEvidence[];
  ranAt: string;
}

export interface ZaicodeAuditGateConfigRead {
  gates: ZaicodeAuditGateSpec[];
  configPath: string;
  /** Non-null means NO gate may be considered passed. */
  error: string | null;
}

function clampTimeoutMs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.round(value), 60 * 60_000);
}

/**
 * Read the trusted gate configuration. Anything unexpected is an error, never a
 * partial gate list: a half-parsed gate set could silently drop the one gate
 * that mattered.
 */
export function readZaicodeAuditGateConfig(workspacePath: string): ZaicodeAuditGateConfigRead {
  const configPath = join(workspacePath, ...ZAICODE_AUDIT_GATE_CONFIG_RELATIVE_PATH.split("/"));
  if (!existsSync(configPath)) {
    return { gates: [], configPath, error: `no trusted gate configuration exists at ${configPath}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    return { gates: [], configPath, error: `the gate configuration is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const list = (raw as { gates?: unknown } | null)?.gates;
  if (!Array.isArray(list)) return { gates: [], configPath, error: "the gate configuration has no `gates` array" };
  const gates: ZaicodeAuditGateSpec[] = [];
  const problems: string[] = [];
  list.forEach((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const command = typeof record.command === "string" ? record.command.trim() : "";
    const args = Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string") : null;
    if (!id) problems.push(`gate ${index} has no id`);
    else if (!command) problems.push(`gate ${id} has no command`);
    else if (args === null) problems.push(`gate ${id} has no args array (a shell string is not accepted)`);
    else gates.push({ id, command, args, timeoutMs: clampTimeoutMs(record.timeoutMs, ZAICODE_AUDIT_GATE_DEFAULT_TIMEOUT_MS) });
  });
  if (problems.length > 0) return { gates: [], configPath, error: problems.join("; ") };
  if (gates.length === 0) return { gates: [], configPath, error: "the gate configuration lists no gate" };
  return { gates, configPath, error: null };
}

function runGate(spec: ZaicodeAuditGateSpec, workspacePath: string, sourceFingerprint: string): Promise<ZaicodeAuditGateEvidence> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(
      spec.command,
      spec.args,
      {
        cwd: workspacePath,
        timeout: spec.timeoutMs,
        maxBuffer: ZAICODE_AUDIT_GATE_MAX_OUTPUT_BYTES,
        windowsHide: true,
        encoding: "utf8",
      },
      (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
        const endedAt = Date.now();
        // A gate that could not be spawned is a FAILURE, never a pass: the loop
        // must not read "the binary is missing" as "the checks passed".
        const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({
          id: spec.id,
          command: spec.command,
          args: spec.args,
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          durationMs: endedAt - startedAt,
          exitCode,
          timedOut: error?.killed === true,
          stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8"),
          stderr: typeof stderr === "string" ? stderr : stderr.toString("utf8"),
          outputTruncated: (error as { code?: string } | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          sourceFingerprint,
          error: error && typeof error.code !== "number" ? (error.message ?? String(error.code ?? "spawn failed")) : null,
        });
      },
    );
  });
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export interface ZaicodeAuditGateRunnerDeps {
  logWarn?: (message: string, error?: unknown) => void;
}

/**
 * The runner the host injects into the loop. Its return shape is the loop's
 * contract; the full evidence record is persisted beside the cycle's evidence
 * package, so a reviewer's claim can never substitute for a real exit code.
 *
 * ponytail: no external cancel path -- a gate ends by its own timeout. Add an
 * abort switch here when the operator surface grows "stop the gates".
 */
export function createZaicodeAuditGateRunner(
  deps: ZaicodeAuditGateRunnerDeps = {},
): (run: ZaicodeAuditLoopRun) => Promise<{ command: string; exitCode: number }[]> {
  return async (run) => {
    const config = readZaicodeAuditGateConfig(run.workspacePath);
    const report: ZaicodeAuditGateReport = {
      schemaVersion: 1,
      loopId: run.loopId,
      cycle: run.cycle,
      sourceFingerprint: run.sourceFingerprint,
      configPath: config.configPath,
      configError: config.error,
      gates: [],
      ranAt: new Date().toISOString(),
    };
    const reportPath = run.evidence ? join(dirname(run.evidence.manifestFile), ZAICODE_AUDIT_GATE_REPORT_FILE) : null;
    const persist = () => {
      if (!reportPath) return;
      try {
        writeJsonAtomic(reportPath, report);
      } catch (error) {
        deps.logWarn?.(`ZAICODE audit gates: could not persist the gate report to ${reportPath}`, error);
      }
    };
    if (config.error) {
      deps.logWarn?.(`ZAICODE audit gates: no usable gate set for ${run.workspacePath}: ${config.error}`);
      persist();
      return [{ command: "audit-gates: configuration unusable", exitCode: 1 }];
    }
    for (const spec of config.gates) {
      report.gates.push(await runGate(spec, run.workspacePath, run.sourceFingerprint));
    }
    persist();
    return report.gates.map((gate) => ({
      command: `${gate.command} ${gate.args.join(" ")}`.trim(),
      exitCode: gate.exitCode ?? 1,
    }));
  };
}
