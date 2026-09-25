/**
 * Helpers of the ZAICODE system E2E (T-44): command runners through the real
 * launchers, ZAICODE's own read paths assembled as the app does, and the
 * worker processes that do what an agent seat does.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zaicodeProjectRuntimeState, type ZaicodeProjectRuntimeVerdict, type ZaicodeSaipenProjection } from "@zcode/shared";
import { getZaicodeSaipenProjection, resolveZaicodeSaipenHome } from "../../../desktop/src/main/zaicodeSaipenProjection.js";
import { assembleZaicodeProjectRuntime } from "../../src/zaicode/zaicodeProjectRuntime.js";
import { parseSaipenBoard, parseSaipenState, type ZaicodeSaipenSnapshot } from "../../src/zaicode/zaicodeSaipenModel.js";

export const SEAT = "e2e-worker";
export const TICKET = "T-1";
const COMMAND_TIMEOUT_MS = 120_000;
const WORKER_READY_TIMEOUT_MS = 180_000;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(file: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; verbatim?: boolean }): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        windowsVerbatimArguments: options.verbatim ?? false,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
        resolvePromise({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

/** `saipen <args>` through the launcher (the protocol's DIRECT_LAUNCHER transport). */
export function saipen(home: string, root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  if (process.platform !== "win32") return run(join(home, "bin", "saipen"), args, { cwd: root, ...(env ? { env } : {}) });
  const quoted = args.map((arg) => (/^[\w.:/\\@=+,-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, "'")}"`)).join(" ");
  return run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${join(home, "bin", "saipen.cmd")}" ${quoted}"`], {
    cwd: root,
    verbatim: true,
    ...(env ? { env } : {}),
  });
}

export async function saipenOk(home: string, root: string, args: string[]): Promise<string> {
  const result = await saipen(home, root, [...args, "--agent", SEAT]);
  if (result.code !== 0) throw new Error(`saipen ${args.join(" ")} -> exit ${result.code}: ${(result.stdout + result.stderr).trim().slice(-400)}`);
  return result.stdout;
}

export function git(root: string, args: string[]): Promise<CommandResult> {
  return run("git", ["-c", "user.email=e2e@zaicode.local", "-c", "user.name=ZAICODE E2E", ...args], { cwd: root });
}

export function json(output: string): Record<string, unknown> {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`no JSON in output: ${output.slice(0, 200)}`);
  return JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
}

/** BOOT.md's two layouts: `<home>/saipen` (a source checkout) or `<home>` itself (the skill install). */
export function saipenProtocolDir(home: string): string | null {
  for (const dir of [join(home, "saipen"), home]) if (existsSync(join(dir, "BOOT.md"))) return dir;
  return null;
}

/**
 * A fresh Git project with real SAIPEN memory and one Work ticket (T-1), the
 * way an operator bootstraps one: the protocol's own templates, this home's
 * style contract, `saipen ticket add`, a commit, `saipen validate`.
 */
export async function createZaicodeE2eProject(input: { home: string; root: string; zaicodeRoot: string }): Promise<Record<string, unknown>> {
  const { home, root } = input;
  await mkdir(join(root, ".saipen"), { recursive: true });
  await writeFile(join(root, "README.md"), "# ZAICODE E2E project\n");
  if ((await git(root, ["init", "-q"])).code !== 0) throw new Error("git init failed");
  const templates = join(home, "extensions", "templates");
  await copyFile(join(templates, "BOARD.md"), join(root, ".saipen", "BOARD.md"));
  await copyFile(join(templates, "LOG.md"), join(root, ".saipen", "LOG.md"));
  const protocol = saipenProtocolDir(home);
  if (!protocol) throw new Error(`no BOOT.md under ${home}`);
  const style = /style_contract:\s*(ded-[0-9a-f]+)/.exec(await readFile(join(protocol, "STYLE.md"), "utf8"))?.[1];
  if (!style) throw new Error("STYLE.md carries no style_contract marker");
  const version = /saipen_version:\s*(\d+)/.exec(await readFile(join(input.zaicodeRoot, ".saipen", "STATE.md"), "utf8"))?.[1] ?? "8";
  const state = (await readFile(join(templates, "STATE.md"), "utf8"))
    .replace("agent: <name>", `agent: ${SEAT}`)
    .replace(/saipen_version: \d+/, `saipen_version: ${version}`)
    .replace('style_contract: ""', `style_contract: ${style}`)
    .replace('saipen_home: ""', `saipen_home: "${home.replace(/\\/g, "/")}"`)
    .replace(/updated: .*/, `updated: "${new Date().toISOString().replace(/\.\d+Z$/, "Z")}"`);
  await writeFile(join(root, ".saipen", "STATE.md"), state);
  await saipenOk(home, root, ["ticket", "add", "P1", "write hello.txt", "--verify", "hello.txt exists"]);
  // SAIPEN writes its lineage carrier (IDENTITY.md) on first use and wants it tracked, like a real project.
  await git(root, ["add", "-A"]);
  if ((await git(root, ["commit", "-qm", "SAIPEN memory"])).code !== 0) throw new Error("initial commit failed");
  const validate = await saipen(home, root, ["validate"]);
  if (!/code: VALID/.test(validate.stdout)) throw new Error(`saipen validate: ${validate.stdout.trim().slice(-300)}`);
  return { root, home, style_contract: style, saipen_version: version };
}

// ---------------------------------------------------------------------------
// ZAICODE read paths, exactly as the app assembles them.

/** The renderer store's snapshot (file parse) plus the main-process projection. */
export async function readZaicodeSaipen(root: string): Promise<ZaicodeSaipenSnapshot> {
  const memory = join(root, ".saipen");
  const [state, board, projection] = await Promise.all([
    readFile(join(memory, "STATE.md"), "utf8"),
    readFile(join(memory, "BOARD.md"), "utf8"),
    getZaicodeSaipenProjection(root),
  ]);
  return {
    ...parseSaipenState(state),
    ...parseSaipenBoard(board),
    lastAction: null,
    lastActionTime: null,
    projection,
  };
}

export function verdictOf(root: string, saipen: ZaicodeSaipenSnapshot, workersAlive: number): ZaicodeProjectRuntimeVerdict {
  return zaicodeProjectRuntimeState(
    assembleZaicodeProjectRuntime({
      projectPath: root,
      saipen,
      running: [],
      waiting: [],
      workers: Array.from({ length: workersAlive }, () => ({ projectPath: root, exitCode: null })),
    }),
  );
}

export function projectionFacts(projection: ZaicodeSaipenProjection | null | undefined) {
  return projection
    ? {
        source: projection.source,
        phase: projection.phase,
        claimed: projection.claimedTicket,
        top: projection.topWorkableTicket,
        next: projection.nextAction,
        closure: projection.closureComplete,
      }
    : null;
}

export async function countLogEvents(root: string): Promise<number> {
  const log = await readFile(join(root, ".saipen", "LOG.md"), "utf8");
  return log.split(/\r?\n/).filter((line) => /^- .*\[E-\d+\]/.test(line)).length;
}

// ---------------------------------------------------------------------------
// Worker processes: a real agent seat does exactly these SAIPEN operations.

export type WorkerMode = "gen1" | "gen2" | "finish";

export async function workerMain(root: string, mode: WorkerMode): Promise<void> {
  const home = (await resolveZaicodeSaipenHome(root))!;
  if (mode === "gen1") {
    await saipenOk(home, root, ["claim", TICKET]);
    await saipenOk(home, root, ["checkpoint", "RUN", TICKET, "SCOUT -- empty project, one file to write"]);
    await saipenOk(home, root, ["transition", "BUILD", TICKET, "Write hello.txt"]);
    await writeFile(join(root, "hello.txt"), "partial");
    process.stdout.write("READY\n");
    // Holds the Work until the harness kills this generation.
    await new Promise((resolveForever) => setTimeout(resolveForever, 10 * 60_000));
    return;
  }
  if (mode === "gen2") {
    const next = json(await saipenOk(home, root, ["continue", "--json"]));
    if (next.ticket !== TICKET) throw new Error(`generation 2 was routed to ${String(next.ticket)}, not ${TICKET}`);
    await writeFile(join(root, "hello.txt"), "hello from generation 2\n");
    await saipenOk(home, root, ["checkpoint", "RUN", TICKET, "build -> hello.txt written by generation 2 after generation 1 was killed"]);
    await saipenOk(home, root, ["transition", "VERIFY", TICKET, "Build complete"]);
    process.stdout.write(`READY ${JSON.stringify({ routed: next.action })}\n`);
    return;
  }
  const content = await readFile(join(root, "hello.txt"), "utf8");
  if (!content.includes("generation 2")) throw new Error("hello.txt does not hold generation 2's content");
  await saipenOk(home, root, ["checkpoint", "RUN", TICKET, "verify -> PASS [target: T-1] conf: high -- hello.txt holds generation 2 content"]);
  await saipenOk(home, root, ["transition", "REVIEW", TICKET, "Verification PASS"]);
  await saipenOk(home, root, ["checkpoint", "DEC", TICKET, "SHIP -- reviewed, nothing open"]);
  await saipenOk(home, root, ["transition", "SHIP", TICKET, "Review passed"]);
  await saipenOk(home, root, ["checkpoint", "RUN", TICKET, "ship -> skipped publish (no-publish: policy -- E2E temp repo, no origin)"]);
  await saipenOk(home, root, ["ticket", "done", TICKET, "--closure-mode", "own_patch"]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "T-1 hello.txt"]);
  process.stdout.write("READY\n");
}

export function startWorker(script: string, root: string, mode: WorkerMode): { child: ChildProcess; ready: Promise<string> } {
  const child = spawn(process.execPath, ["--import", "tsx", script, "--worker", root, mode], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let errors = "";
  const ready = new Promise<string>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker ${mode} not ready in ${WORKER_READY_TIMEOUT_MS / 1000}s: ${errors.slice(-400)}`)), WORKER_READY_TIMEOUT_MS);
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const line = output.split(/\r?\n/).find((entry) => entry.startsWith("READY"));
      if (line) {
        clearTimeout(timer);
        resolveReady(line);
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      if (!output.includes("READY")) {
        clearTimeout(timer);
        reject(new Error(`worker ${mode} exited ${code} before READY: ${errors.slice(-400)}`));
      }
    });
  });
  return { child, ready };
}

export function waitExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
}

/** `--probe <root>`: a fresh process answers what ZAICODE shows (the restart check). */
export async function probeMain(root: string): Promise<void> {
  const snapshot = await readZaicodeSaipen(root);
  process.stdout.write(`${JSON.stringify({ projection: projectionFacts(snapshot.projection), verdict: verdictOf(root, snapshot, 0) })}\n`);
}
