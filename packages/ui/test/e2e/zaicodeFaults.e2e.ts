/**
 * ZAICODE fault-injection matrix (T-43, SRC-033 analysis 4).
 *
 * Each automatable scenario injects one fault into the real owner -- the
 * router supervisor and transport, the SAIPEN launcher and memory, the
 * SAIMAIL reader, the quota rules, the crash planners, the subscription
 * process transport -- and records what ZAICODE's own code answers. The
 * scenarios that need a live desktop, OS or network are listed with manual
 * steps and expected results (`ZAICODE_MANUAL_FAULTS`).
 *
 * Run from packages/ui:
 *   node --import tsx test/e2e/zaicodeFaults.e2e.ts [--out DIR] [--outage-ms 30000] [--keep]
 * Needs SAIPEN (SAIPEN_HOME, else the home the ZAICODE workspace STATE names)
 * and git. Exit code 1 when any scenario FAILs.
 */
import { cp, mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  effectiveZaicodeWindows,
  zaicodeEngineAvailability,
  zaicodeNextRefillAt,
  type ZaicodeLimitSnapshot,
  type ZaicodeLimitWindow,
  type ZaicodeSubchatEvent,
} from "@zcode/shared";
import { callZaicodeRouter, setZaicodeRouterTarget } from "../../../desktop/src/main/zaicodeRouterTransport.js";
import { ZaicodeRouterProcess, isZaicodeRouterHealthy } from "../../../desktop/src/main/zaicodeRouterProcess.js";
import { resolveZaicodeSaipenHome } from "../../../desktop/src/main/zaicodeSaipenProjection.js";
import { startZaicodeSubchatProcess } from "../../../desktop/src/main/zaicodeSubchatProcess.js";
import { buildSaimailSnapshot, parseSaimailIndex } from "../../src/zaicode/zaicodeSaimailModel.js";
import { planZaicodeCrashResume } from "../../src/zaicode/zaicodeCrashResume.js";
import { normalizeZaicodeAliveWorkers } from "../../src/zaicode/zaicodeWorkerRecovery.js";
import type { ZaicodeSessionBrief } from "../../src/zaicode/zaicodeContinue.js";
import { freePort, writeStubRouterPackage, writeWaitingCli, ZAICODE_MANUAL_FAULTS } from "./zaicodeFaultKit.js";
import {
  SEAT,
  TICKET,
  createZaicodeE2eProject,
  projectionFacts,
  readZaicodeSaipen,
  saipen,
  saipenProtocolDir,
  startWorker,
  verdictOf,
  waitExit,
} from "./zaicodeSystemKit.js";

const SCRIPT = fileURLToPath(import.meta.url);
const SYSTEM_SCRIPT = join(dirname(SCRIPT), "zaicodeSystem.e2e.ts");
const ZAICODE_ROOT = resolve(dirname(SCRIPT), "../../../../..");
const FAIL_FAST_MS = 5000;

type Verdict = "PASS" | "FAIL" | "SKIP";
interface Row {
  id: string;
  scenario: string;
  verdict: Verdict;
  ms: number;
  facts: Record<string, unknown>;
  error?: string;
}
class Skip extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function until(what: string, probe: () => Promise<boolean> | boolean, timeoutMs: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probe()) return Date.now() - started;
    await sleep(100);
  }
  throw new Error(`${what}: not within ${timeoutMs} ms`);
}

function window(key: string, remainingPercent: number, resetsAt: number, group = ""): ZaicodeLimitWindow {
  return { key, label: key, group, groupLabel: group, remainingPercent, resetsAt, durationMinutes: key === "five_hour" ? 300 : 10080, gatedBy: null, assumedFull: false };
}

function brief(patch: Partial<ZaicodeSessionBrief>): ZaicodeSessionBrief {
  return {
    sessionId: "s",
    projectKey: "P",
    workspacePath: "P",
    title: "t",
    running: false,
    waiting: false,
    interrupted: true,
    crashCut: true,
    updatedAt: 0,
    goalObjective: null,
    goalStatus: null,
    ...patch,
  } as ZaicodeSessionBrief;
}

async function matrix(argv: string[]): Promise<number> {
  const keep = argv.includes("--keep");
  const outIndex = argv.indexOf("--out");
  const outageIndex = argv.indexOf("--outage-ms");
  const outageMs = outageIndex >= 0 ? Math.max(1000, Number(argv[outageIndex + 1]) || 30_000) : 30_000;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = outIndex >= 0 && argv[outIndex + 1] ? resolve(argv[outIndex + 1]!) : join(tmpdir(), `zaicode-faults-${stamp}`);
  const base = await mkdtemp(join(tmpdir(), "zaicode-faults-"));
  const rows: Row[] = [];
  const cleanups: (() => void)[] = [];
  delete process.env.ZAICODE_ROUTER_URL;

  async function scenario(id: string, name: string, body: () => Promise<Record<string, unknown>>) {
    const started = Date.now();
    try {
      rows.push({ id, scenario: name, verdict: "PASS", ms: 0, facts: await body() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rows.push({ id, scenario: name, verdict: error instanceof Skip ? "SKIP" : "FAIL", ms: 0, facts: {}, error: message });
    }
    const row = rows[rows.length - 1]!;
    row.ms = Date.now() - started;
    process.stdout.write(`${row.verdict.padEnd(4)} ${id.padEnd(24)} ${String(row.ms).padStart(7)} ms  ${row.error ?? ""}\n`);
  }

  // Router: one supervised stub, shared by the crash and the outage scenarios.
  const routerPort = await freePort();
  const routerData = join(base, "router-data");
  const router = new ZaicodeRouterProcess({
    execPath: process.execPath,
    packageDir: await writeStubRouterPackage(join(base, "router-pkg")),
    dataDir: routerData,
    port: routerPort,
    logFile: join(base, "router.log"),
  });
  cleanups.push(() => router.stop());
  setZaicodeRouterTarget({ url: router.url, dataDir: routerData });

  await scenario("router-crash-restart", "9router dies on its own: the supervisor brings it back, a clean stop stays stopped", async () => {
    check(await router.start(), "stub router did not start");
    const firstPid = router.pid;
    check(firstPid, "no router pid");
    process.kill(firstPid);
    const backMs = await until("router back after a crash", async () => router.pid !== null && router.pid !== firstPid && (await isZaicodeRouterHealthy(router.url)), 15_000);
    check(router.restarts === 1, `restarts ${router.restarts}`);
    router.stop();
    await sleep(2500);
    const stayedDown = !(await isZaicodeRouterHealthy(router.url)) && router.pid === null;
    check(stayedDown, "a clean stop was restarted like a crash");
    return { firstPid, backMs, restarts: 1, lastError: router.lastError, cleanStopStaysDown: stayedDown };
  });

  await scenario("router-outage", `Router down ${Math.round(outageMs / 1000)} s and back: calls fail fast during the outage, succeed after`, async () => {
    check(await router.start(), "stub router did not start");
    const before = await callZaicodeRouter({ method: "GET", path: "/api/providers" });
    check(before.ok, `before: ${before.status} ${before.message}`);
    router.stop();
    const failures: number[] = [];
    const outageEnd = Date.now() + outageMs;
    while (Date.now() < outageEnd) {
      const started = Date.now();
      const down = await callZaicodeRouter({ method: "GET", path: "/api/providers" });
      failures.push(Date.now() - started);
      check(!down.ok && down.status === 0, `during the outage the call answered ${down.status}`);
      await sleep(Math.min(5000, Math.max(0, outageEnd - Date.now())));
    }
    check(Math.max(...failures) < FAIL_FAST_MS, `slowest failure ${Math.max(...failures)} ms`);
    check(await router.start(), "router did not come back");
    const after = await callZaicodeRouter({ method: "GET", path: "/api/providers" });
    check(after.ok, `after: ${after.status} ${after.message}`);
    return { outageMs, failedCalls: failures.length, slowestFailureMs: Math.max(...failures), after: after.status };
  });

  await scenario("quota-zero-reset", "Quota hits zero, then the window resets: blocked -> refill time -> available", async () => {
    const now = Date.now();
    const snapshot: ZaicodeLimitSnapshot = {
      accountId: "codex:fault",
      windows: [window("five_hour", 0, now + 3_600_000), window("weekly", 60, now + 5 * 86_400_000)],
      plan: "plus",
      fetchedAt: now,
      checkedAt: now,
      error: null,
      source: "fault",
    };
    const blocked = zaicodeEngineAvailability(snapshot, now);
    const refill = zaicodeNextRefillAt(snapshot, now);
    const afterReset = zaicodeEngineAvailability(snapshot, now + 3_600_001);
    const assumed = effectiveZaicodeWindows(snapshot.windows, now + 3_600_001).find((entry) => entry.key === "five_hour");
    check(blocked === "blocked", `at zero: ${blocked}`);
    check(refill === now + 3_600_000, `refill ${refill}`);
    check(afterReset === "available" && assumed?.assumedFull === true, `after the reset: ${afterReset}`);
    const weeklySpent = { ...snapshot, windows: [window("five_hour", 80, now + 3_600_000), window("weekly", 0, now + 2 * 86_400_000)] };
    const gated = zaicodeEngineAvailability(weeklySpent, now + 3_600_001);
    check(gated === "blocked", `a spent weekly window must gate the refilled 5h one: ${gated}`);
    return { blocked, refillInMin: 60, afterReset, weeklyGate: gated };
  });

  await scenario("saimail-malformed-tail", "SAIMAIL index with a torn last line and junk: the reader keeps every whole row", async () => {
    const row = (n: number) => JSON.stringify({ envelope_id: `sha256:${String(n).repeat(64).slice(0, 64)}`, from: "helper", to: SEAT, kind: "NOTE", topic: TICKET, received_at: `2026-09-25T10:0${n}:00Z` });
    const content = [row(1), row(2), "not json", row(3), '{"envelope_id":"sha256:44'].join("\n");
    const headers = parseSaimailIndex(content);
    check(headers.size === 3, `rows read: ${headers.size}`);
    const names = ["1", "2", "3", "4"].map((n) => n.repeat(64).slice(0, 64));
    const snapshot = buildSaimailSnapshot({ seat: SEAT, unreadEntryNames: names, headers, currentTask: TICKET });
    check(snapshot.unread.length === 4 && snapshot.onCurrentWork === 3, `unread ${snapshot.unread.length}, on work ${snapshot.onCurrentWork}`);
    return { rowsRead: headers.size, unread: snapshot.unread.length, torn: "skipped, its telegram still listed as unread" };
  });

  await scenario("crash-plans", "App killed: cut-off sessions resume oldest first; leftover workers start again", async () => {
    const now = Date.now();
    const steps = planZaicodeCrashResume(
      [
        brief({ sessionId: "new", projectKey: "A", updatedAt: now - 60_000 }),
        brief({ sessionId: "old", projectKey: "A", updatedAt: now - 600_000, goalObjective: "cc all", goalStatus: "active" }),
        brief({ sessionId: "off", projectKey: "B", updatedAt: now - 300_000 }),
        brief({ sessionId: "ancient", projectKey: "A", updatedAt: now - 3 * 86_400_000 }),
        brief({ sessionId: "stopped", projectKey: "A", updatedAt: now - 1000, crashCut: false }),
      ],
      (key) => ({ hasSaipen: true, disabled: key === "B" }),
      now,
      24,
    );
    check(steps.map((step) => step.sessionId).join() === "old,new", `plan ${steps.map((step) => step.sessionId).join()}`);
    check(steps[0]?.command.kind === "goal", "an unfinished goal resumes as a goal");
    const alive = normalizeZaicodeAliveWorkers([
      ...Array.from({ length: 20 }, (_, index) => ({ accountId: `codex:${index}`, projectPath: "C:/p", prompt: "cc", placement: index % 2 ? "window" : "panel" })),
      { accountId: 7 },
      null,
    ]);
    check(alive.length === 16, `relaunch list ${alive.length} (cap 16)`);
    return { resume: steps.map((step) => `${step.sessionId}:${step.command.kind}`), relaunchCap: alive.length };
  });

  await scenario("twelve-finish-at-once", "12 subscription turns finish in the same instant: 12 results, each once, none crossed", async () => {
    const go = join(base, "go.signal");
    const cli = await writeWaitingCli(join(base, "cli"));
    const events = new Map<number, ZaicodeSubchatEvent[]>();
    const turns = Array.from({ length: 12 }, (_, index) => {
      events.set(index, []);
      return startZaicodeSubchatProcess({
        file: process.execPath,
        args: [cli],
        cwd: base,
        env: { ...process.env, ZAICODE_FAULT_GO: go },
        stdin: `w${index}`,
        vendor: "codex",
        short: `C${index}`,
        onEvent: (event) => events.get(index)!.push(event),
      });
    });
    await until("12 sessions announced", () => [...events.values()].every((list) => list.some((event) => event.type === "session")), 20_000);
    await writeFile(go, "go");
    await Promise.all(turns.map((turn) => turn.done));
    for (const [index, list] of events) {
      const results = list.filter((event) => event.type === "result");
      check(results.length === 1 && (results[0] as { ok: boolean }).ok, `worker ${index}: ${JSON.stringify(results)}`);
      const text = list.find((event) => event.type === "text") as { text: string } | undefined;
      check(text?.text === `answer w${index}`, `worker ${index} got ${text?.text}`);
    }
    return { workers: 12, resultsEach: 1 };
  });

  // SAIPEN-backed scenarios share one fresh project.
  const home = (await resolveZaicodeSaipenHome(ZAICODE_ROOT)) ?? "";
  const root = join(base, "project");
  let projectReady = false;
  await scenario("project-setup", "Fresh SAIPEN project for the protocol faults", async () => {
    if (!home || !saipenProtocolDir(home)) throw new Skip("no SAIPEN home on this machine");
    const facts = await createZaicodeE2eProject({ home, root, zaicodeRoot: ZAICODE_ROOT });
    projectReady = true;
    return facts;
  });
  const needProject = () => {
    if (!projectReady) throw new Skip("no SAIPEN project (project-setup did not pass)");
  };

  await scenario("worker-kill-mid-write", "Worker killed mid-write: the next generation resumes the same Work", async () => {
    needProject();
    const gen1 = startWorker(SYSTEM_SCRIPT, root, "gen1");
    cleanups.push(() => gen1.child.kill());
    await gen1.ready;
    gen1.child.kill("SIGKILL");
    await waitExit(gen1.child);
    const gen2 = startWorker(SYSTEM_SCRIPT, root, "gen2");
    cleanups.push(() => gen2.child.kill());
    const ready = await gen2.ready;
    await waitExit(gen2.child);
    const snapshot = await readZaicodeSaipen(root);
    check(snapshot.projection?.phase === "VERIFY", `phase ${snapshot.projection?.phase}`);
    return { gen2: ready, projection: projectionFacts(snapshot.projection) };
  });

  await scenario("foreign-ownership", "Another seat tries to move a claimed Work: SAIPEN refuses, ZAICODE still shows the owner's state", async () => {
    needProject();
    const refused = await saipen(home, root, ["checkpoint", "RUN", TICKET, "foreign seat writes", "--agent", "intruder"]);
    const text = refused.stdout + refused.stderr;
    check(refused.code !== 0 || /REFUSE/.test(text), `foreign checkpoint was accepted: ${text.slice(-300)}`);
    const snapshot = await readZaicodeSaipen(root);
    check(snapshot.projection?.claimedTicket === TICKET && snapshot.projection.phase === "VERIFY", "projection moved");
    return { refusal: text.trim().split(/\r?\n/).find((line) => /REFUSE|reason/i.test(line)) ?? `exit ${refused.code}` };
  });

  await scenario("stale-snapshot", "SAIPEN launcher unreachable, then back: ZAICODE falls back to the files and recovers without a file change", async () => {
    needProject();
    // A new file stamp: ZAICODE's projection cache must ask SAIPEN again (it keys on STATE/BOARD/LOG).
    const touched = new Date();
    await utimes(join(root, ".saipen", "BOARD.md"), touched, touched);
    const saved = process.env.SAIPEN_HOME;
    process.env.SAIPEN_HOME = join(base, "no-such-saipen-home");
    const down = await readZaicodeSaipen(root);
    if (saved === undefined) delete process.env.SAIPEN_HOME;
    else process.env.SAIPEN_HOME = saved;
    check(down.projection === null, "a projection came from a missing launcher");
    const downVerdict = verdictOf(root, down, 0);
    check(downVerdict.state !== "done", `without the launcher the verdict claimed ${downVerdict.state}`);
    const back = await until("projection back", async () => (await readZaicodeSaipen(root)).projection?.source === "saipen", 12_000);
    return { fallbackVerdict: downVerdict, recoveredMs: back };
  });

  await scenario("project-relocate", "Project renamed / moved while known: the new path reads the same Work; the old path reads nothing", async () => {
    needProject();
    const moved = join(base, "project-renamed");
    await cp(root, moved, { recursive: true });
    const there = await readZaicodeSaipen(moved);
    check(there.projection?.claimedTicket === TICKET, `moved copy: ${JSON.stringify(projectionFacts(there.projection))}`);
    const gone = join(base, "project-gone");
    await rename(moved, gone);
    const missing = await readZaicodeSaipen(moved).then(
      () => "read",
      (error: unknown) => (error instanceof Error ? error.message.split(":")[0] : "error"),
    );
    check(missing !== "read", "a vanished path still produced a snapshot");
    return { movedProjection: projectionFacts(there.projection), oldPath: missing };
  });

  await scenario("project-switch", "Switching projects mid-run: each project keeps its own answer", async () => {
    needProject();
    const other = join(base, "other");
    await createZaicodeE2eProject({ home, root: other, zaicodeRoot: ZAICODE_ROOT });
    const [a, b] = await Promise.all([readZaicodeSaipen(root), readZaicodeSaipen(other)]);
    const again = await readZaicodeSaipen(root);
    check(a.projection?.phase === "VERIFY" && b.projection?.phase !== "VERIFY", "answers crossed between projects");
    check(verdictOf(root, a, 1).state === "working" && verdictOf(other, b, 0).state !== "working", "worker count leaked across projects");
    check(again.projection?.phase === "VERIFY", "switching back changed the first project");
    return { a: projectionFacts(a.projection), b: projectionFacts(b.projection) };
  });

  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // already gone
    }
  }
  setZaicodeRouterTarget(null);
  const failed = rows.filter((row) => row.verdict === "FAIL").length;
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "faults.json"), `${JSON.stringify({ startedAt: stamp, rows, manual: ZAICODE_MANUAL_FAULTS, failed }, null, 2)}\n`);
  const lines = [
    `# ZAICODE fault matrix -- ${stamp}`,
    "",
    "| Scenario | Verdict | ms | Detail |",
    "|---|---|---|---|",
    ...rows.map((row) => `| ${row.id} | ${row.verdict} | ${row.ms} | ${(row.error ?? row.scenario).replace(/\|/g, "/")} |`),
    "",
    "## Manual scenarios",
    "",
    ...ZAICODE_MANUAL_FAULTS.map((entry) => `- **${entry.scenario}** (${entry.why}). Steps: ${entry.steps} Expected: ${entry.expected}`),
    "",
  ];
  await writeFile(join(outDir, "faults.md"), lines.join("\n"));
  process.stdout.write(`report: ${outDir}\n`);
  if (!keep) await rm(base, { recursive: true, force: true }).catch(() => undefined);
  return failed > 0 ? 1 : 0;
}

matrix(process.argv.slice(2)).then((code) => process.exit(code));
