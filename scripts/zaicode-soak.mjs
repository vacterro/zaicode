#!/usr/bin/env node
// ZAICODE long-horizon soak harness (T-164 / SRC-116 TRACK A).
//
// What it is for: SRC-116's claim is that ZAICODE degrades to ~1-2 FPS after 6-9 h and
// that a selected project can render permanently blank. Both are claims about a *long*
// run against the *packaged* app, so the harness has to be a long run against the
// packaged app -- not a unit test, and not the operator's already-running instance.
//
// How it works, with no new dependencies:
//   - spawns the packaged binary with its own --user-data-dir and --remote-debugging-port,
//     so it can never attach to, or stop, whatever the operator has open;
//   - drives the real renderer over the DevTools protocol (Node 22+ has a global
//     WebSocket), clicking and typing through the same surface a person uses;
//   - samples a timeline: frame rate, long-frame count, rendered node count, JS heap,
//     process RSS, and the app's own runtime-health counters;
//   - asserts the invariant SRC-116 names -- a selected project converges to a loaded
//     surface, an explicit loading state, or an explicit error, and NEVER a blank one;
//   - writes timeline.jsonl plus verdict.json, and exits by killing only the PID it
//     spawned.
//
// Usage:
//   node scripts/zaicode-soak.mjs --minutes 8                  # churn window
//   node scripts/zaicode-soak.mjs --minutes 90 --soak-hours 12  # the real thing
//   node scripts/zaicode-soak.mjs --minutes 2 --accelerated 20  # 20x the churn rate
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { CHURN, PROBE } from "./zaicode-soak-probes.mjs";
import { buildVerdict } from "./zaicode-soak-verdict.mjs";

const args = parseArgs(process.argv.slice(2));
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.resolve(args.out ?? path.join(REPO_ROOT, ".soak", stamp()));
const REPLAY = typeof args.replay === "string" ? args.replay : null;
const CHURN_MINUTES = Number(args.minutes ?? 90);
const SOAK_HOURS = Number(args["soak-hours"] ?? 0);
const SAMPLE_SECONDS = Number(args["sample-seconds"] ?? 15);
const CHURN_SECONDS = Number(args["churn-seconds"] ?? 20) / Number(args.accelerated ?? 1);
const PORT = Number(args.port ?? 9333);
const KEEP_OPEN = args["keep-open"] === true;

/**
 * The packaged app under test: the newest candidate, not the first one present.
 *
 * A running ZAICODE.exe locks `dist/win-unpacked`, so the bundler stages the fresh build
 * into `dist-next` and the root launcher swaps it in later. Taking the first existing path
 * would quietly soak yesterday's binary for twelve hours while a current one sits beside
 * it: a green verdict for code that is not the code under review.
 */
function newestApp(candidates) {
  const present = candidates.filter((candidate) => existsSync(candidate));
  if (present.length === 0) return candidates[0];
  return present.reduce((newest, candidate) =>
    statSync(candidate).mtimeMs > statSync(newest).mtimeMs ? candidate : newest,
  );
}

const APP = args.app ?? newestApp([
  path.join(REPO_ROOT, "packages/desktop/dist/win-unpacked/ZAICODE.exe"),
  path.join(REPO_ROOT, "packages/desktop/dist/win-unpacked/ZCode.exe"),
  path.join(REPO_ROOT, "packages/desktop/dist-next/win-unpacked/ZAICODE.exe"),
  path.join(REPO_ROOT, "apps/desktop/dist/win-unpacked/ZAICODE.exe"),
]);

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Only ever the PID this process spawned. Never a name, image or process list. */
async function rssBytesOf(pid) {
  if (process.platform !== "win32") return null;
  return new Promise((resolve) => {
    const child = spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("close", () => {
      const value = Number(out.trim());
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    });
  });
}

// ── DevTools protocol ────────────────────────────────────────────────────────

class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`cdp connect failed: ${url}`)), {
        once: true,
      });
    });
    const client = new Cdp();
    client.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : "");
      if (message.id === undefined) return;
      const pending = client.#pending.get(message.id);
      if (!pending) return;
      client.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message}`));
      else pending.resolve(message.result);
    });
    return client;
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`cdp timeout: ${method}`));
      }, 60_000);
    });
  }

  /** Evaluate in the page and return the JSON value. Throws are the caller's problem. */
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "evaluate threw");
    }
    return result.result?.value;
  }

  close() {
    this.#socket.close();
  }
}

/** The current DevTools connection; replaced whenever the page target is swapped. */
let cdp = null;

/**
 * Attaches to the live page, re-resolving the target list.
 *
 * A 12-hour run against the packaged app WILL lose its page target: a remote session
 * reconnect, a workspace remount or a crash-recovery reload all replace the webContents.
 * A harness that dies on the first target swap would never reach the window SRC-116 is
 * about, so every evaluate goes through here and reconnects a bounded number of times.
 */
async function attachPage() {
  const target = await findPageTarget(PORT, 120_000);
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  return cdp;
}

async function evaluateWithReattach(expression) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await cdp.evaluate(expression);
    } catch (error) {
      lastError = error;
      cdp.close();
      try {
        await attachPage();
      } catch {
        await sleep(2_000);
      }
    }
  }
  throw lastError;
}

async function findPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const pages = targets.filter(
        (target) => target.type === "page" && target.webSocketDebuggerUrl && !target.url.startsWith("devtools://"),
      );
      // A fresh profile opens a splash/boot shell before the real window; the newest
      // target is the one the operator is looking at, so prefer it over list order.
      const page = pages.sort((left, right) => (right.id ?? "").localeCompare(left.id ?? ""))[0];
      if (page) return page;
    } catch {
      // 还没起来，继续等。
    }
    await sleep(1000);
  }
  throw new Error(`no debuggable page on port ${port} after ${timeoutMs}ms`);
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function main() {
  if (REPLAY) {
    // A 12-hour run should never have to be repeated just to re-analyse it.
    const timeline = (await readFile(REPLAY, "utf8"))
      .split(String.fromCharCode(10))
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const config = { replayedFrom: REPLAY, samples: timeline.length };
    const verdict = buildVerdict(timeline, config);
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(path.join(OUT_DIR, "verdict.json"), `${JSON.stringify(verdict, null, 2)}
`);
    await writeFile(path.join(OUT_DIR, "report.md"), renderReport(verdict, OUT_DIR));
    console.log(`verdict: ${verdict.verdict}`);
    return verdict.verdict === "PASS" ? 0 : 1;
  }
  if (!existsSync(APP)) {
    throw new Error(`packaged app not found: ${APP}\nBuild it first, or pass --app <path>.`);
  }
  await mkdir(OUT_DIR, { recursive: true });
  const userDataDir = path.join(OUT_DIR, "profile");
  await rm(userDataDir, { recursive: true, force: true });

  // 独立 user-data-dir：跑的是同一份 packaged app，但不碰操作员正在用的那个实例。
  const child = spawn(
    APP,
    [
      `--remote-debugging-port=${PORT}`,
      // The renderer only exposes its runtime-health snapshot when this flag is present.
      "--zaicode-soak=1",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: {
        ...process.env,
        // ZAICODE relocates userData to its own appData directory and takes a
        // single-instance lock on it, so `--user-data-dir` alone would be ignored and
        // this launch would just forward to the operator's running instance. These
        // overrides are the supported way to get a genuinely separate profile, and a
        // separate profile means a separate lock.
        ZCODE_DESKTOP_USER_DATA_DIR: userDataDir,
        ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(userDataDir, "session"),
      },
    },
  );
  const appLogs = [];
  child.stdout?.on("data", (chunk) => appLogs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => appLogs.push(String(chunk)));

  const startedAt = Date.now();
  const timeline = [];
  const churnActions = {};
  let churnErrors = 0;
  let exitCode = 0;
  try {
    await attachPage();
    // 等首屏真的画出来，否则前几个样本是启动噪声而不是稳态。
    await sleep(20_000);

    const churnUntil = Date.now() + CHURN_MINUTES * 60_000;
    const soakUntil = Date.now() + SOAK_HOURS * 3_600_000;
    const hardStop = Math.max(churnUntil, soakUntil);
    let nextChurn = 0;

    while (Date.now() < hardStop) {
      if (Date.now() >= nextChurn) {
        nextChurn = Date.now() + CHURN_SECONDS * 1000;
        try {
          for (const action of await evaluateWithReattach(CHURN)) {
            churnActions[action] = (churnActions[action] ?? 0) + 1;
          }
        } catch (error) {
          churnErrors += 1;
          timeline.push({ at: new Date().toISOString(), churnError: String(error) });
        }
      }
      const sample = {
        at: new Date().toISOString(),
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        phase: Date.now() < churnUntil ? "churn" : "soak",
        rssBytes: await rssBytesOf(child.pid),
      };
      try {
        Object.assign(sample, await evaluateWithReattach(PROBE));
      } catch (error) {
        sample.probeError = String(error);
      }
      timeline.push(sample);
      await writeFile(path.join(OUT_DIR, "timeline.jsonl"), timeline.map((row) => JSON.stringify(row)).join("\n"));
      log(sample);
      await sleep(SAMPLE_SECONDS * 1000);
    }
  } catch (error) {
    exitCode = 1;
    console.error(`soak failed: ${error.message}`);
  } finally {
    cdp?.close();
    if (!KEEP_OPEN && child.pid !== undefined) {
      child.kill();
      await sleep(2000);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    if (appLogs.length > 0) {
      await writeFile(path.join(OUT_DIR, "app.log"), appLogs.join(""));
    }
  }

  const verdict = buildVerdict(timeline, {
    churnMinutes: CHURN_MINUTES,
    soakHours: SOAK_HOURS,
    // A run that clicked nothing must not read as a run that churned: the degradation
    // claims in SRC-116 are about a loaded surface under repeated use.
    churnActions,
    churnErrors,
    // The verdict is only evidence about the binary that produced it, so the report names
    // it: which exe, and how old it was when the run started.
    app: { path: APP, builtAt: new Date(statSync(APP).mtimeMs).toISOString() },
  });
  await writeFile(path.join(OUT_DIR, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
  await writeFile(path.join(OUT_DIR, "report.md"), renderReport(verdict, OUT_DIR));
  console.log(`\nverdict: ${verdict.verdict}`);
  console.log(`timeline: ${path.join(OUT_DIR, "timeline.jsonl")}`);
  // A failed verdict must be able to gate an automated run, so it leaves a non-zero
  // exit code instead of only printing the word.
  return exitCode === 0 && verdict.verdict === "PASS" ? 0 : 1;
}

function log(sample) {
  if (sample.probeError) {
    console.log(`[${sample.elapsedSeconds}s] probe failed: ${sample.probeError}`);
    return;
  }
  console.log(
    `[${sample.elapsedSeconds}s ${sample.phase}] fps=${sample.fps} long=${sample.longFrames} ` +
      `heap=${Math.round((sample.heapUsedBytes ?? 0) / 1048576)}MB rss=${Math.round((sample.rssBytes ?? 0) / 1048576)}MB ` +
      `nodes=${sample.nodes}${sample.blank ? " BLANK-SURFACE" : ""}`,
  );
}

function renderReport(verdict, outDir) {
  return [
    `# ZAICODE soak verdict — ${verdict.verdict}`,
    "",
    `- window: ${verdict.durationSeconds}s, ${verdict.samples} samples, median DOM nodes ${verdict.medianNodes}`,
    `- FPS: ${verdict.fps.first} -> ${verdict.fps.midpoint} -> ${verdict.fps.last} (worst ${verdict.fps.worst}, slope ${verdict.fps.slopePerMinute}/min)`,
    `- renderer heap: ${verdict.heapUsedMb.first} MB -> ${verdict.heapUsedMb.last} MB (${verdict.heapUsedMb.growthMbPerMinute} MB/min)`,
    `- process RSS: ${verdict.rssMb.first} MB -> ${verdict.rssMb.last} MB (${verdict.rssMb.growthMbPerMinute} MB/min)`,
    `- janky samples (long frames present): ${verdict.jankySamples} of ${verdict.samples}`,
    `- blank-surface samples: ${verdict.blankSurfaceSamples}`,
    `- churn interactions: ${verdict.churnTotal} (${JSON.stringify(verdict.churnActions)}), errors ${verdict.churnErrors}`,
    `- under test: ${verdict.config?.app?.path ?? "(replay: no binary)"}` +
      `${verdict.config?.app?.builtAt ? ` built ${verdict.config.app.builtAt}` : ""}`,
    "",
    `Timeline: \`${outDir}/timeline.jsonl\``,
    "",
  ].join("\n");
}

main()
  .then((code) => process.exit(code))
  .catch(async (error) => {
    console.error(String(error?.stack ?? error));
    process.exit(1);
  });
