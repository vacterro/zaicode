/**
 * ZAICODE full-system headless E2E (T-44, SRC-033 analysis 1).
 *
 * Drives the non-GUI chain end to end against real owners -- a fresh Git
 * project with real SAIPEN memory, the real SAIPEN launcher, real SAIMAIL
 * workspaces, real worker processes, the live 9router -- and asserts at every
 * checkpoint what ZAICODE's own read paths answer (the desktop main-process
 * SAIPEN projection, the renderer's read-model verdict, the SAIMAIL reader,
 * the Router transport, the agent CLI /goal verdict).
 *
 *   cold start -> project detected -> SAIPEN projected -> engines -> START
 *   (/goal cc all verdict) -> Work claimed by a worker -> STATE/BOARD/LOG move
 *   -> SAIMAIL telegram from another seat -> worker killed + next generation
 *   resumes the same Work -> router outage and recovery -> ZAICODE read path
 *   restarted in a new process -> VERIFY -> DONE -> goal verdict passes.
 *
 * GUI-only steps (START click, live panels, app window restart) are listed in
 * the report for the operator; they stay T-9.
 *
 * Run from packages/ui:
 *   node --import tsx test/e2e/zaicodeSystem.e2e.ts [--out DIR] [--keep]
 * Needs: SAIPEN (SAIPEN_HOME, else the home the ZAICODE workspace STATE names),
 * git and saimail-local on PATH. Exit code 1 when any step FAILs.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { ZaicodeProjectRuntimeVerdict } from "@zcode/shared";
import { saipenGoalVerdict } from "../../../../apps/zcode-cli/packages/core/src/runtime/methods/saipen-goal-verdict.js";
import { callZaicodeRouter } from "../../../desktop/src/main/zaicodeRouterTransport.js";
import { resolveZaicodeSaipenHome } from "../../../desktop/src/main/zaicodeSaipenProjection.js";
import { buildSaimailSnapshot, parseSaimailIndex } from "../../src/zaicode/zaicodeSaimailModel.js";
import {
  SEAT,
  TICKET,
  countLogEvents,
  git,
  json,
  probeMain,
  projectionFacts,
  readZaicodeSaipen,
  run,
  saipen,
  saipenOk,
  startWorker as startWorkerOf,
  verdictOf,
  waitExit,
  workerMain,
  type WorkerMode,
} from "./zaicodeSystemKit.js";
import type { ZaicodeSaipenSnapshot } from "../../src/zaicode/zaicodeSaipenModel.js";

const SCRIPT = fileURLToPath(import.meta.url);
const ZAICODE_ROOT = resolve(dirname(SCRIPT), "../../../../..");
const HELPER_SEAT = "e2e-helper";
const ROUTER_DEAD_URL = "http://127.0.0.1:9";
const ROUTER_FAIL_FAST_MS = 15_000;
const startWorker = (root: string, mode: WorkerMode) => startWorkerOf(SCRIPT, root, mode);
// ---------------------------------------------------------------------------
// Harness.

type Verdict = "PASS" | "FAIL" | "SKIP";

interface StepRecord {
  id: string;
  name: string;
  verdict: Verdict;
  ms: number;
  facts: Record<string, unknown>;
  error?: string;
}

class SkipStep extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const GUI_STEPS = [
  "Open the project in ZAICODE: the sidebar strip tint and the composer chip show the read-model verdict (pending T-1).",
  "Press START on the project row: a primary session opens and sends `/goal cc all` with the selected engine.",
  "While the agent works: the composer NEXT/THEN lines and the SAIPEN pane follow each checkpoint within one poll (3 s).",
  "SAIMAIL header button rings for the telegram; the desk lists it under the current Work.",
  "Close ZAICODE mid-run and start it again: the same project, verdict and SAIPEN state come back; detached workers are listed.",
];

async function harness(argv: string[]): Promise<number> {
  const keep = argv.includes("--keep");
  const outIndex = argv.indexOf("--out");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = outIndex >= 0 && argv[outIndex + 1] ? resolve(argv[outIndex + 1]!) : join(tmpdir(), `zaicode-e2e-report-${stamp}`);
  const base = await mkdtemp(join(tmpdir(), "zaicode-e2e-"));
  const root = join(base, "project");
  const mail = join(base, "mail");
  const steps: StepRecord[] = [];
  const workers: ChildProcess[] = [];
  let home = "";

  async function step(id: string, name: string, body: () => Promise<Record<string, unknown>>) {
    const started = Date.now();
    try {
      const facts = await body();
      steps.push({ id, name, verdict: "PASS", ms: Date.now() - started, facts });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push({ id, name, verdict: error instanceof SkipStep ? "SKIP" : "FAIL", ms: Date.now() - started, facts: {}, error: message });
    }
    const last = steps[steps.length - 1]!;
    process.stdout.write(`${last.verdict.padEnd(4)} ${id.padEnd(22)} ${String(last.ms).padStart(6)} ms  ${last.error ?? ""}\n`);
  }

  await step("cold-start", "Fresh Git project gets SAIPEN memory; one Work ticket", async () => {
    home = (await resolveZaicodeSaipenHome(ZAICODE_ROOT)) ?? "";
    check(home && existsSync(join(home, "BOOT.md")), `no SAIPEN home (SAIPEN_HOME or ${ZAICODE_ROOT}/.saipen/STATE.md saipen_home)`);
    await mkdir(join(root, ".saipen"), { recursive: true });
    await writeFile(join(root, "README.md"), "# ZAICODE E2E project\n");
    check((await git(root, ["init", "-q"])).code === 0, "git init failed");
    const templates = join(home, "extensions", "templates");
    await copyFile(join(templates, "BOARD.md"), join(root, ".saipen", "BOARD.md"));
    await copyFile(join(templates, "LOG.md"), join(root, ".saipen", "LOG.md"));
    const style = /style_contract:\s*(ded-[0-9a-f]+)/.exec(await readFile(join(home, "STYLE.md"), "utf8"))?.[1];
    check(style, "STYLE.md carries no style_contract marker");
    const version = /saipen_version:\s*(\d+)/.exec(await readFile(join(ZAICODE_ROOT, ".saipen", "STATE.md"), "utf8"))?.[1] ?? "8";
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
    check((await git(root, ["commit", "-qm", "SAIPEN memory"])).code === 0, "initial commit failed");
    const validate = await saipen(home, root, ["validate"]);
    check(/code: VALID/.test(validate.stdout), `saipen validate: ${validate.stdout.trim().slice(-300)}`);
    return { root, home, style_contract: style, saipen_version: version };
  });

  let lastProjection: ZaicodeSaipenSnapshot | null = null;
  await step("project-detected", "ZAICODE projects SAIPEN's own status; verdict is pending on T-1", async () => {
    const snapshot = await readZaicodeSaipen(root);
    check(snapshot.projection?.source === "saipen", `projection unavailable (${JSON.stringify(snapshot.projection)})`);
    check(snapshot.projection.topWorkableTicket === TICKET, `top workable is ${snapshot.projection.topWorkableTicket}`);
    const verdict = verdictOf(root, snapshot, 0);
    check(verdict.state === "pending", `verdict ${verdict.state} (${verdict.reason})`);
    lastProjection = snapshot;
    return { projection: projectionFacts(snapshot.projection), verdict };
  });

  await step("engines", "Engine availability from the persisted cache ZAICODE loads at start", async () => {
    const appData = process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming");
    const cacheFile = join(appData, "ZAICODE", "zaicode-engines-cache.json");
    if (!existsSync(cacheFile)) throw new SkipStep("no engine cache on this machine (engine probing runs in the Electron main process: GUI step)");
    const cache = JSON.parse(await readFile(cacheFile, "utf8")) as {
      limits?: Record<string, { windows?: { remainingPercent?: number | null }[]; error?: string | null }>;
      lastSweepAt?: number;
    };
    const accounts = Object.values(cache.limits ?? {});
    check(accounts.length > 0, "engine cache holds no account");
    const blocked = accounts.filter((account) => (account.windows ?? []).some((window) => window.remainingPercent === 0)).length;
    return {
      accounts: accounts.length,
      usable: accounts.length - blocked,
      blocked,
      sweepAgeSeconds: cache.lastSweepAt ? Math.round((Date.now() - cache.lastSweepAt) / 1000) : null,
    };
  });

  await step("start-goal", "START's `/goal cc all` verdict keeps the goal running on T-1", async () => {
    const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
    check(verdict && !verdict.passed, `goal verdict ${JSON.stringify(verdict)}`);
    check(verdict.nextAction.includes(TICKET), `next action does not name ${TICKET}: ${verdict.nextAction}`);
    return { passed: verdict.passed, reason: verdict.reason, nextAction: verdict.nextAction };
  });

  let generation1: ChildProcess | null = null;
  await step("work-claimed", "Worker generation 1 claims the Work; STATE/BOARD/LOG move; ZAICODE shows working", async () => {
    const before = await countLogEvents(root);
    const worker = startWorker(root, "gen1");
    generation1 = worker.child;
    workers.push(worker.child);
    await worker.ready;
    const snapshot = await readZaicodeSaipen(root);
    check(snapshot.projection?.claimedTicket === TICKET, `projection did not refresh after the claim: ${JSON.stringify(projectionFacts(snapshot.projection))}`);
    check(snapshot.projection.phase === "BUILD", `phase ${snapshot.projection.phase}`);
    check(snapshot.projection !== lastProjection?.projection, "projection cache was not invalidated");
    const verdict = verdictOf(root, snapshot, 1);
    check(verdict.state === "working", `verdict ${verdict.state}`);
    const after = await countLogEvents(root);
    check(after > before, "LOG did not grow");
    lastProjection = snapshot;
    return { pid: worker.child.pid, logEvents: { before, after }, projection: projectionFacts(snapshot.projection), verdict };
  });

  await step("saimail-telegram", "A helper seat's telegram reaches the main seat through ZAICODE's SAIMAIL reader", async () => {
    const main = join(mail, "main");
    const helper = join(mail, "helper");
    const saimail = (args: string[]) => run("saimail-local", [...args, "--json"], { cwd: base });
    const init = await saimail(["init", "--workspace", main, "--seat", SEAT]);
    if (init.code !== 0 && /ENOENT|not recognized|not found/i.test(init.stderr + init.stdout)) {
      throw new SkipStep("saimail-local is not installed on this machine");
    }
    check(init.code === 0, `saimail init: ${init.stdout.slice(-300)}`);
    check((await saimail(["init", "--workspace", helper, "--seat", HELPER_SEAT])).code === 0, "saimail init helper failed");
    await saimail(["identity", "--workspace", main, "--export-card", join(mail, "main.card")]);
    await saimail(["identity", "--workspace", helper, "--export-card", join(mail, "helper.card")]);
    check((await saimail(["recipient", "add", "--workspace", helper, "--alias", "main", "--card", join(mail, "main.card"), "--peer-workspace", main])).code === 0, "recipient main");
    check((await saimail(["recipient", "add", "--workspace", main, "--alias", "helper", "--card", join(mail, "helper.card"), "--peer-workspace", helper])).code === 0, "recipient helper");
    const sent = json((await saimail(["send", "--workspace", helper, "--to", "main", "--claim", "T-1: reviewed the plan, go ahead", "--topic", TICKET])).stdout);
    check(sent.ok === true, `send: ${JSON.stringify(sent).slice(0, 300)}`);
    const inbox = await readdir(join(main, "mail", "inbox", SEAT));
    const headers = parseSaimailIndex(await readFile(join(main, "mail", "index.jsonl"), "utf8"));
    const desk = buildSaimailSnapshot({ seat: SEAT, unreadEntryNames: inbox, headers, currentTask: TICKET });
    check(desk.unread.length === 1, `unread ${desk.unread.length}`);
    check(desk.unread[0]!.from === HELPER_SEAT, `from ${desk.unread[0]!.from}`);
    check(desk.onCurrentWork === 1, "telegram not attached to the current Work");
    // What SAIPEN itself reports at turn entry for this seat's mailbox (fact, not asserted).
    const status = json((await saipen(home, root, ["status", "--json"], { ...process.env, SAIMAIL_WORKSPACE: main })).stdout);
    return { unread: desk.unread.length, from: desk.unread[0]!.from, topic: desk.unread[0]!.topic, onCurrentWork: desk.onCurrentWork, saipenTelegrams: status.telegrams };
  });

  await step("worker-kill-recovery", "Generation 1 is killed; the Work survives; generation 2 resumes the same ticket", async () => {
    check(generation1, "no generation 1 worker");
    const killed = generation1 as ChildProcess;
    killed.kill("SIGKILL");
    await waitExit(killed);
    const orphan = await readZaicodeSaipen(root);
    const idle = verdictOf(root, orphan, 0);
    check(idle.state === "pending", `with no worker alive the verdict is ${idle.state}, expected pending`);
    const validate = await saipen(home, root, ["validate"]);
    check(/code: VALID/.test(validate.stdout), `validate after kill: ${validate.stdout.trim().slice(-300)}`);
    const worker = startWorker(root, "gen2");
    workers.push(worker.child);
    const ready = await worker.ready;
    await waitExit(worker.child);
    const saipen2 = await readZaicodeSaipen(root);
    check(saipen2.projection?.phase === "VERIFY", `phase after generation 2: ${saipen2.projection?.phase}`);
    lastProjection = saipen2;
    return { killedPid: killed.pid, verdictWithoutWorker: idle, generation2: ready, projection: projectionFacts(saipen2.projection) };
  });

  await step("router-outage", "Router down: ZAICODE's Router call fails fast with a clear message; back up: it answers", async () => {
    const saved = process.env.ZAICODE_ROUTER_URL;
    process.env.ZAICODE_ROUTER_URL = ROUTER_DEAD_URL;
    const started = Date.now();
    const down = await callZaicodeRouter({ method: "GET", path: "/api/health" });
    const downMs = Date.now() - started;
    if (saved === undefined) delete process.env.ZAICODE_ROUTER_URL;
    else process.env.ZAICODE_ROUTER_URL = saved;
    check(!down.ok && down.status === 0, `dead router answered ${JSON.stringify(down)}`);
    check(downMs < ROUTER_FAIL_FAST_MS, `outage took ${downMs} ms to surface`);
    check(/not reachable/.test(down.message), `message: ${down.message}`);
    const up = await callZaicodeRouter({ method: "GET", path: "/api/health" });
    const facts = { down: { ms: downMs, message: down.message }, up: { ok: up.ok, status: up.status, message: up.message } };
    if (!up.ok && up.status === 0) throw new SkipStep(`outage path PASS; recovery not checked: 9router is not running here (${up.message})`);
    check(up.ok, `live 9router answered ${up.status}: ${up.message}`);
    return facts;
  });

  await step("restart", "A new process (ZAICODE restarted) reads the same state and verdict", async () => {
    const probe = await run(process.execPath, ["--import", "tsx", SCRIPT, "--probe", root], { cwd: process.cwd() });
    check(probe.code === 0, `probe exit ${probe.code}: ${probe.stderr.slice(-300)}`);
    const restarted = json(probe.stdout) as { projection: ReturnType<typeof projectionFacts>; verdict: ZaicodeProjectRuntimeVerdict };
    const before = projectionFacts(lastProjection?.projection);
    check(JSON.stringify(restarted.projection) === JSON.stringify(before), `restart saw ${JSON.stringify(restarted.projection)}, before ${JSON.stringify(before)}`);
    return { restarted };
  });

  await step("verify-done", "The Work goes VERIFY -> DONE; ZAICODE shows done; the /goal verdict passes", async () => {
    const worker = startWorker(root, "finish");
    workers.push(worker.child);
    await worker.ready;
    await waitExit(worker.child);
    const snapshot = await readZaicodeSaipen(root);
    check(snapshot.projection?.source === "saipen", "projection unavailable at the end");
    check(!snapshot.projection.claimedTicket && !snapshot.projection.topWorkableTicket, `open work left: ${JSON.stringify(projectionFacts(snapshot.projection))}`);
    const verdict = verdictOf(root, snapshot, 0);
    check(verdict.state === "done", `verdict ${verdict.state} (${verdict.reason})`);
    const goal = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
    check(goal?.passed === true, `goal verdict ${JSON.stringify(goal)}`);
    const validate = await saipen(home, root, ["validate"]);
    check(/code: VALID/.test(validate.stdout), `final validate: ${validate.stdout.trim().slice(-300)}`);
    return { projection: projectionFacts(snapshot.projection), verdict, goal: goal.reason };
  });

  for (const child of workers) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  const failed = steps.filter((entry) => entry.verdict === "FAIL").length;
  await mkdir(outDir, { recursive: true });
  const report = { startedAt: stamp, project: root, saipenHome: home, steps, guiSteps: GUI_STEPS, failed };
  await writeFile(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    `# ZAICODE system E2E -- ${stamp}`,
    "",
    "| Step | Verdict | ms | Detail |",
    "|---|---|---|---|",
    ...steps.map((entry) => `| ${entry.id} | ${entry.verdict} | ${entry.ms} | ${(entry.error ?? entry.name).replace(/\|/g, "/")} |`),
    "",
    "## GUI steps for the operator (T-9)",
    "",
    ...GUI_STEPS.map((text, index) => `${index + 1}. ${text}`),
    "",
  ];
  await writeFile(join(outDir, "report.md"), lines.join("\n"));
  process.stdout.write(`report: ${outDir}\n`);
  if (!keep) await rm(base, { recursive: true, force: true }).catch(() => undefined);
  return failed > 0 ? 1 : 0;
}

const [mode, target, extra] = process.argv.slice(2);
if (mode === "--worker" && target) {
  workerMain(target, (extra ?? "gen1") as WorkerMode).then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
} else if (mode === "--probe" && target) {
  probeMain(target).then(
    () => process.exit(0),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
} else {
  harness(process.argv.slice(2)).then((code) => process.exit(code));
}
