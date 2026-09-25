import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { readZaicodeEnginesState } from "./zaicodeEngines.js";
import { launchZaicodeWorker, readZaicodeWorkers, subscribeZaicodeWorkers } from "./zaicodeWorkers.js";

/**
 * Workers across a crash (SRC-044). A worker's PTY dies with ZAICODE, so the
 * running subscription workers are written down on every change; a clean
 * close erases the list (beforeunload), a crash leaves it behind. On the next
 * start that leftover list is started again -- same engine, same project,
 * same prompt -- when the operator keeps "relaunch workers after a crash" on.
 * SAIPEN keeps the work itself in `.saipen/`, so `cc` picks up where it was.
 */

const STORAGE_KEY = "zaicode-workers-alive-v1";
/** How long to wait for the engines list (accounts) before giving up. */
const ACCOUNTS_WAIT_MS = 60_000;

export interface ZaicodeAliveWorker {
  accountId: string;
  projectPath: string;
  prompt: string | null;
  placement: "panel" | "window";
  /** Generation of the run the crash cut off; the restart is the next one. */
  generation: number;
}

export function normalizeZaicodeAliveWorkers(raw: unknown): ZaicodeAliveWorker[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is ZaicodeAliveWorker =>
        Boolean(item) &&
        typeof (item as ZaicodeAliveWorker).accountId === "string" &&
        typeof (item as ZaicodeAliveWorker).projectPath === "string",
    )
    .map(
      (item): ZaicodeAliveWorker => ({
        accountId: item.accountId,
        projectPath: item.projectPath,
        prompt: typeof item.prompt === "string" ? item.prompt : null,
        placement: item.placement === "window" ? "window" : "panel",
        generation: Number.isInteger(item.generation) && item.generation > 0 ? item.generation : 1,
      }),
    )
    .slice(0, 16);
}

/** What was running when ZAICODE went away: read once, before this run records its own list. */
let leftover: ZaicodeAliveWorker[] | null = null;

function readStored(): ZaicodeAliveWorker[] {
  try {
    return normalizeZaicodeAliveWorkers(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

function writeAlive(): void {
  const alive: ZaicodeAliveWorker[] = readZaicodeWorkers()
    .workers.filter((worker) => worker.kind === "worker" && worker.exitCode === null && worker.accountId)
    .map((worker) => ({
      accountId: worker.accountId!,
      projectPath: worker.projectPath,
      prompt: worker.prompt ?? null,
      placement: worker.placement,
      generation: worker.generation,
    }));
  try {
    if (alive.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(alive));
  } catch {
    // recovery is best effort
  }
}

let recording = false;

/** Mount once: keeps the alive list current and erases it on a clean close. */
export function startZaicodeWorkerRecording(): () => void {
  if (recording) return () => undefined;
  recording = true;
  leftover ??= readStored();
  const off = subscribeZaicodeWorkers(writeAlive);
  const onUnload = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // nothing to erase
    }
  };
  window.addEventListener("beforeunload", onUnload);
  return () => {
    recording = false;
    off();
    window.removeEventListener("beforeunload", onUnload);
  };
}

async function waitForAccounts(): Promise<boolean> {
  const until = Date.now() + ACCOUNTS_WAIT_MS;
  while (Date.now() < until) {
    if (readZaicodeEnginesState().accounts.length > 0) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  return false;
}

/** Starts the workers a crash cut off (once per app start). */
export function relaunchZaicodeWorkersAfterCrash(): void {
  const list = leftover ?? [];
  leftover = [];
  if (list.length === 0) return;
  void (async () => {
    if (!(await waitForAccounts())) return;
    const started: string[] = [];
    for (const entry of list) {
      const account = readZaicodeEnginesState().accounts.find((candidate) => candidate.id === entry.accountId);
      if (!account) continue;
      const result = await launchZaicodeWorker({
        account,
        projectPath: entry.projectPath,
        ...(entry.prompt ? { prompt: entry.prompt } : {}),
        ...(entry.placement === "window" ? { where: "window" as const } : {}),
        generation: entry.generation + 1,
      });
      if (result.ok) started.push(result.message);
      else logger.warn("[zaicode] worker relaunch after a crash failed", { message: result.message });
    }
    if (started.length > 0) toast([`Workers started again after a crash: ${started.length}`, ...started].join("\n"), { durationMs: 10_000 });
  })();
}
