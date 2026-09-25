import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { normalizeZaicodeSaipenStatus, type ZaicodeSaipenProjection } from "@zcode/shared";

/**
 * SAIPEN's own projection for ZAICODE's read model (T-41): `saipen status
 * --json` through the SAIPEN launcher (the protocol's DIRECT_LAUNCHER
 * transport, never a hand-built interpreter path). The answer is cached per
 * project until STATE, BOARD or LOG change, so polling ZAICODE surfaces do not
 * re-run SAIPEN; a failed read only for a few seconds. One run per project at
 * a time.
 */

const RUN_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/**
 * A failed read (launcher missing or busy, timeout, no JSON) is asked again
 * after this even when the files did not change: caching the failure until
 * the next checkpoint left ZAICODE on "projection unavailable" long after
 * SAIPEN answered again (T-43 fault matrix, stale-snapshot).
 */
const FAILURE_RETRY_MS = 5000;

interface CacheEntry {
  key: string;
  projection: ZaicodeSaipenProjection | null;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ZaicodeSaipenProjection | null>>();

async function fileKey(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/** SAIPEN_HOME from the ZAICODE launcher, else the home STATE.md names. */
export async function resolveZaicodeSaipenHome(projectPath: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.SAIPEN_HOME?.trim()) return env.SAIPEN_HOME.trim();
  try {
    const state = await readFile(join(projectPath, ".saipen", "STATE.md"), "utf8");
    const match = /^saipen_home:\s*"?([^"\r\n]+)"?\s*$/m.exec(state);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function runStatus(launcher: string, projectPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // cmd.exe runs the .cmd launcher; paths are quoted whole. A path that could escape the quotes is refused.
    if (/["%\r\n]/.test(launcher) || /["%\r\n]/.test(projectPath)) {
      reject(new Error("path contains characters that cannot be passed to the SAIPEN launcher safely"));
      return;
    }
    const command = `""${launcher}" status --json --project-root "${projectPath}""`;
    const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
      cwd: projectPath,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`saipen status did not answer in ${RUN_TIMEOUT_MS / 1000}s`));
    }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_BYTES) output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

/** The first JSON object in the launcher output (it may print a banner before it). */
export function extractZaicodeSaipenJson(output: string): unknown {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function getZaicodeSaipenProjection(projectPath: string): Promise<ZaicodeSaipenProjection | null> {
  const memory = join(projectPath, ".saipen");
  const key = (
    await Promise.all(["STATE.md", "BOARD.md", "LOG.md"].map((name) => fileKey(join(memory, name))))
  ).join("|");
  if (key.startsWith("missing")) return null;
  const cached = cache.get(projectPath);
  if (cached?.key === key && (cached.projection !== null || Date.now() - cached.at < FAILURE_RETRY_MS)) return cached.projection;
  const running = inFlight.get(projectPath);
  if (running) return running;
  const task = (async () => {
    const home = await resolveZaicodeSaipenHome(projectPath);
    let projection: ZaicodeSaipenProjection | null;
    if (!home) {
      projection = null;
    } else {
      try {
        const output = await runStatus(join(home, "bin", "saipen.cmd"), projectPath);
        projection = normalizeZaicodeSaipenStatus(extractZaicodeSaipenJson(output), Date.now());
      } catch {
        projection = null;
      }
    }
    cache.set(projectPath, { key, projection, at: Date.now() });
    return projection;
  })().finally(() => inFlight.delete(projectPath));
  inFlight.set(projectPath, task);
  return task;
}
