import { useEffect } from "react";
import { useSyncExternalStore } from "react";
import {
  normalizeZaicodeEnginesConfig,
  zaicodeBottleneck,
  zaicodeEngineAvailability,
  type ZaicodeEngineAccount,
  type ZaicodeEngineAvailability,
  type ZaicodeEnginesConfig,
  type ZaicodeEnginesState,
  type ZaicodeLimitSnapshot,
  type ZaicodeResetConsumeResult,
  isZaicodeMetricsOnlyAccount,
} from "@zcode/shared";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * Renderer half of ZAICODE engines. The desktop main process owns discovery
 * and quota reads; this module mirrors its state (pushed on every change),
 * keeps the operator's active engine, and turns an account into the exact
 * PowerShell line that starts it as a worker.
 */

interface ZaicodeEnginesBridge {
  getZaicodeEngines?(): Promise<ZaicodeEnginesState>;
  refreshZaicodeEngines?(accountId?: string): Promise<ZaicodeEnginesState>;
  setZaicodeEnginesConfig?(patch: Partial<ZaicodeEnginesConfig>): Promise<ZaicodeEnginesState>;
  consumeZaicodeResetCredit?(request: { accountId: string; creditId: string | null }): Promise<ZaicodeResetConsumeResult>;
  onZaicodeEnginesChanged?(callback: (state: ZaicodeEnginesState) => void): () => void;
  launchZaicodeExternalWorker?(params: { cwd: string; command: string; title: string }): Promise<{
    ok: boolean;
    message: string;
  }>;
  prepareZaicodeEngineAccountHome?(vendor: string): Promise<{ ok: boolean; home: string; message: string }>;
  writeZaicodePromptFile?(text: string): Promise<{ ok: boolean; path: string; message: string }>;
  getZaicodeStartWithWindows?(): Promise<{ enabled: boolean; command: string }>;
  setZaicodeStartWithWindows?(enabled: boolean): Promise<{ enabled: boolean; command: string }>;
}

export function getZaicodeEnginesBridge(): ZaicodeEnginesBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { zcode?: ZaicodeEnginesBridge }).zcode;
}

const EMPTY_STATE: ZaicodeEnginesState = {
  accounts: [],
  limits: {},
  sweeping: false,
  probing: [],
  lastSweepAt: null,
  nextSweepAt: null,
  config: normalizeZaicodeEnginesConfig(null),
};

let state: ZaicodeEnginesState = EMPTY_STATE;
const listeners = new Set<() => void>();
let connected = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function accept(next: ZaicodeEnginesState | null | undefined): void {
  if (!next || typeof next !== "object" || !Array.isArray(next.accounts)) return;
  state = { ...EMPTY_STATE, ...next, config: normalizeZaicodeEnginesConfig(next.config) };
  emit();
}

function connect(): void {
  if (connected) return;
  const bridge = getZaicodeEnginesBridge();
  if (!bridge?.getZaicodeEngines) return;
  connected = true;
  bridge.onZaicodeEnginesChanged?.((next) => accept(next));
  void bridge.getZaicodeEngines().then(accept).catch(() => undefined);
}

function subscribe(listener: () => void): () => void {
  connect();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readZaicodeEnginesState(): ZaicodeEnginesState {
  return state;
}

export function useZaicodeEngines(): ZaicodeEnginesState {
  return useSyncExternalStore(subscribe, readZaicodeEnginesState, readZaicodeEnginesState);
}

export function isZaicodeEnginesAvailable(): boolean {
  return Boolean(getZaicodeEnginesBridge()?.getZaicodeEngines);
}

export async function refreshZaicodeEngineLimits(accountId?: string): Promise<void> {
  const bridge = getZaicodeEnginesBridge();
  if (!bridge?.refreshZaicodeEngines) return;
  accept(await bridge.refreshZaicodeEngines(accountId));
}

export const ZAICODE_RESET_REFRESH_SOON = 24 * 60 * 60_000;

/** Earliest reset time still in the future across every engine snapshot, or
 * null when every window is past its reset or there is no live data yet.
 * Exported for the T-266 regression test; the hook is the production caller. */
export function earliestPendingReset(state: ZaicodeEnginesState, now: number): number | null {
  let soonest: number | null = null;
  for (const snapshot of Object.values(state.limits)) {
    if (!snapshot || snapshot.error || snapshot.windows.length === 0) continue;
    for (const window of snapshot.windows) {
      if (window.resetsAt !== null && window.resetsAt > now && window.resetsAt <= now + ZAICODE_RESET_REFRESH_SOON) {
        if (soonest === null || window.resetsAt < soonest) soonest = window.resetsAt;
      }
    }
  }
  return soonest;
}

/**
 * T-266: the title-bar and sidebar limit meters share one engine snapshot and
 * only repaint on a 30s poll or an on-demand read. A quota window that ends
 * therefore keeps showing the spent/old reading for up to the next poll, so
 * the second meter lags the first. This watches every snapshot's window reset
 * time and triggers an exact quota refresh the moment the soonest reset arrives,
 * then reschedules for the next upcoming reset -- so both meters repaint
 * immediately on a reset instead of waiting on the coarse tick. Mount once.
 */
export function useZaicodeResetRefresh(): void {
  const state = useZaicodeEngines();
  useEffect(() => {
    const target = earliestPendingReset(state, Date.now());
    if (target === null) return;
    const delay = Math.max(0, target - Date.now());
    const id = window.setTimeout(() => {
      void refreshZaicodeEngineLimits().catch(() => undefined);
    }, delay);
    return () => window.clearTimeout(id);
  }, [state]);
}

export async function updateZaicodeEnginesConfig(patch: Partial<ZaicodeEnginesConfig>): Promise<void> {
  const bridge = getZaicodeEnginesBridge();
  if (!bridge?.setZaicodeEnginesConfig) return;
  accept(await bridge.setZaicodeEnginesConfig(patch));
}

export function visibleZaicodeAccounts(current: ZaicodeEnginesState = state): ZaicodeEngineAccount[] {
  return current.accounts.filter((account) => !current.config.hiddenAccounts.includes(account.id));
}

/**
 * Accounts that can run work: visible, not metrics-only (Freebuff is measured,
 * never launched -- SRC-043). Worker Dispatch and project menus use these;
 * subscription tiles and quota watches may also use router-backed measured accounts.
 */
export function launchableZaicodeAccounts(current: ZaicodeEnginesState = state): ZaicodeEngineAccount[] {
  return visibleZaicodeAccounts(current).filter((account) => !isZaicodeMetricsOnlyAccount(account));
}

// ---------------------------------------------------------------------------
// Tone: one color language for the bar, the meter and the settings table
// ---------------------------------------------------------------------------

export type ZaicodeEngineTone = "good" | "warn" | "bad" | "blocked" | "unknown" | "offline";

export interface ZaicodeEngineReading {
  availability: ZaicodeEngineAvailability;
  /** Remaining percent of the bottleneck window, null when unknown. */
  remaining: number | null;
  tone: ZaicodeEngineTone;
  stale: boolean;
  bottleneckLabel: string | null;
}

export function readZaicodeEngine(
  account: ZaicodeEngineAccount,
  snapshot: ZaicodeLimitSnapshot | undefined,
  now: number = Date.now(),
): ZaicodeEngineReading {
  if (account.status === "cli-missing" || account.status === "login-required") {
    return { availability: "unknown", remaining: null, tone: "offline", stale: false, bottleneckLabel: null };
  }
  const availability = zaicodeEngineAvailability(snapshot, now);
  const bottleneck = snapshot ? zaicodeBottleneck(snapshot.windows, now) : null;
  const remaining = bottleneck?.remainingPercent ?? null;
  const tone: ZaicodeEngineTone =
    availability === "blocked"
      ? "blocked"
      : remaining === null
        ? "unknown"
        : remaining < 20
          ? "bad"
          : remaining < 50
            ? "warn"
            : "good";
  return {
    availability,
    remaining,
    tone,
    stale: Boolean(snapshot?.error && snapshot.windows.length > 0),
    bottleneckLabel: bottleneck?.gatedBy ? `blocked by ${bottleneck.gatedBy}` : (bottleneck?.label ?? null),
  };
}

/** Fill colors (CSS values) that read on every ZAICODE palette. */
export const ZAICODE_TONE_COLORS: Record<ZaicodeEngineTone, string> = {
  good: "#4f9a2f",
  warn: "#c9a227",
  bad: "#c8502a",
  blocked: "#7a2a22",
  unknown: "#5a5647",
  offline: "#3a372e",
};

/**
 * Text colour for a remaining percent. Bars can be dark (the fill sits on a
 * black track), text cannot: 0% in the blocked bar red is unreadable on the
 * dark theme, so words and numbers use these brighter tones.
 */
export const ZAICODE_TONE_TEXT_COLORS: Record<ZaicodeEngineTone, string> = {
  good: "#8fd46a",
  warn: "#f0c850",
  bad: "#ff9a66",
  blocked: "#ff7b6b",
  unknown: "#b8b09a",
  offline: "#a8a290",
};

export function zaicodeRemainingTextColor(remaining: number | null): string {
  if (remaining === null) return ZAICODE_TONE_TEXT_COLORS.unknown;
  if (remaining <= 0) return ZAICODE_TONE_TEXT_COLORS.blocked;
  if (remaining < 20) return ZAICODE_TONE_TEXT_COLORS.bad;
  if (remaining < 50) return ZAICODE_TONE_TEXT_COLORS.warn;
  return ZAICODE_TONE_TEXT_COLORS.good;
}

/** Bar color for a remaining percent (green -> amber -> red). */
export function zaicodeRemainingColor(remaining: number | null): string {
  if (remaining === null) return ZAICODE_TONE_COLORS.unknown;
  if (remaining <= 0) return ZAICODE_TONE_COLORS.blocked;
  if (remaining < 20) return ZAICODE_TONE_COLORS.bad;
  if (remaining < 50) return ZAICODE_TONE_COLORS.warn;
  return ZAICODE_TONE_COLORS.good;
}

// ---------------------------------------------------------------------------
// Active engine (what START / Launch uses)
// ---------------------------------------------------------------------------

const ACTIVE_KEY = "zaicode-active-engine";
const ACTIVE_EVENT = "zaicode-active-engine-changed";
let activeCache: string | null | undefined;

/** Account id of the selected subscription engine, or null = the in-app model pool. */
export function readZaicodeActiveEngine(): string | null {
  if (activeCache !== undefined) return activeCache;
  const raw = readZaicodeSetting(ACTIVE_KEY);
  activeCache = raw && raw !== "null" ? raw.replace(/^"|"$/g, "") : null;
  return activeCache;
}

export function setZaicodeActiveEngine(accountId: string | null): void {
  activeCache = accountId;
  try {
    if (accountId) localStorage.setItem(ACTIVE_KEY, accountId);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // lasts for this window
  }
  window.dispatchEvent(new Event(ACTIVE_EVENT));
}

export function useZaicodeActiveEngine(): string | null {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(ACTIVE_EVENT, listener);
      return () => window.removeEventListener(ACTIVE_EVENT, listener);
    },
    readZaicodeActiveEngine,
    readZaicodeActiveEngine,
  );
}

// ---------------------------------------------------------------------------
// Worker command lines (PowerShell, the integrated terminal's shell on Windows)
// ---------------------------------------------------------------------------

export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const YOLO_ARGS: Record<string, string> = {
  claude: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
  antigravity: "--dangerously-skip-permissions",
  zcode: "--mode yolo",
};

/**
 * REQ-003: the vendor CLI's supported unattended flag, or null when the
 * vendor has none (freebuff is measured-only and has no CLI at all).
 * A null here with YOLO on is a deterministic preflight refusal, never a
 * worker that hangs on an interactive prompt.
 */
export function zaicodeWorkerYoloArgs(vendor: ZaicodeEngineAccount["vendor"]): string | null {
  return YOLO_ARGS[vendor] ?? null;
}

/**
 * The PowerShell line that starts `account`'s CLI as an interactive worker
 * in `projectPath`, seeded with `prompt`. Account selection is by the
 * vendor's own home variable, set for this console only; secondary Codex
 * homes drop inherited API keys so an environment key never replaces the
 * account's own login.
 */
export function buildZaicodeWorkerCommand(
  account: ZaicodeEngineAccount,
  projectPath: string,
  options: { prompt: string; yolo: boolean },
): string | null {
  if (!account.cli) return null;
  // The command is typed into the worker shell and ends with Enter: a line break
  // inside the prompt would press Enter halfway through the quoted string.
  const prompt = options.prompt.replace(/\s*[\r\n]+\s*/g, " ").trim();
  const args = zaicodeWorkerYoloArgs(account.vendor);
  const yolo = options.yolo && args ? ` ${args}` : "";
  const parts: string[] = [`Set-Location -LiteralPath ${psQuote(projectPath)}`];
  switch (account.vendor) {
    case "claude": {
      parts.push(
        account.isDefaultHome || !account.home
          ? "Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue"
          : `$env:CLAUDE_CONFIG_DIR = ${psQuote(account.home)}`,
      );
      parts.push("Remove-Item Env:CLAUDECODE,Env:CLAUDE_CODE_ENTRYPOINT -ErrorAction SilentlyContinue");
      parts.push(`& ${psQuote(account.cli)}${yolo}${prompt ? ` ${psQuote(prompt)}` : ""}`);
      break;
    }
    case "codex": {
      if (account.home) parts.push(`$env:CODEX_HOME = ${psQuote(account.home)}`);
      if (!account.isDefaultHome) {
        parts.push("Remove-Item Env:OPENAI_API_KEY,Env:CODEX_API_KEY,Env:CODEX_ACCESS_TOKEN -ErrorAction SilentlyContinue");
      }
      const standalone = account.cliCapabilities?.noDaemon ? " --no-daemon" : "";
      const hooks = options.yolo && account.cliCapabilities?.hookTrustBypass ? " --dangerously-bypass-hook-trust" : "";
      parts.push(`& ${psQuote(account.cli)}${yolo}${standalone}${hooks}${prompt ? ` ${psQuote(prompt)}` : ""}`);
      break;
    }
    case "antigravity": {
      parts.push(`& ${psQuote(account.cli)}${yolo}${prompt ? ` -i ${psQuote(prompt)}` : ""}`);
      break;
    }
    case "zcode": {
      parts.push(`& node ${psQuote(account.cli)} tui --cwd ${psQuote(projectPath)}${yolo}`);
      break;
    }
    default:
      return null;
  }
  // The tab closes with the CLI's own exit code, so the dock shows finished vs crashed.
  parts.push("exit $LASTEXITCODE");
  return parts.join("; ");
}

/**
 * A prompt that fits a worker's command line as it is: short and on one line.
 * Longer ones (whole audits, SRC-046) go into a file the worker is told to read.
 */
export const ZAICODE_WORKER_INLINE_PROMPT_MAX = 1500;

export function zaicodeWorkerPromptNeedsFile(prompt: string): boolean {
  return prompt.length > ZAICODE_WORKER_INLINE_PROMPT_MAX || /[\r\n]/.test(prompt.trim());
}

/** What a worker is told when its real prompt is in a file. */
export function zaicodeWorkerFilePrompt(path: string): string {
  return `Read the file "${path}" and carry out the operator's instruction in it: it is the whole task, word for word.`;
}

/** SRC-046: the prompt as it goes on a worker's command line (a long one via a file; ~32 000 characters fit a line). */
export async function resolveZaicodeWorkerLinePrompt(prompt: string): Promise<string> {
  if (!zaicodeWorkerPromptNeedsFile(prompt)) return prompt;
  const written = await getZaicodeEnginesBridge()?.writeZaicodePromptFile?.(prompt);
  return written?.ok ? zaicodeWorkerFilePrompt(written.path) : prompt;
}

/** One-click fix: the exact command shown to the operator before it runs. */
export function buildZaicodeFixCommand(account: ZaicodeEngineAccount): string | null {
  return account.fixCommand;
}

export function projectNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

// ---------------------------------------------------------------------------
// Current workspace (set by App so global surfaces know "this project")
// ---------------------------------------------------------------------------

let currentWorkspace: { path: string; identity?: string } | null = null;
const WORKSPACE_EVENT = "zaicode-current-workspace-changed";

export function setZaicodeCurrentWorkspace(path: string | undefined, identity?: string): void {
  const next = path ? { path, ...(identity ? { identity } : {}) } : null;
  if (currentWorkspace?.path === next?.path && currentWorkspace?.identity === next?.identity) return;
  currentWorkspace = next;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(WORKSPACE_EVENT));
}

export function readZaicodeCurrentWorkspace(): { path: string; identity?: string } | null {
  return currentWorkspace;
}

export function useZaicodeCurrentWorkspace(): { path: string; identity?: string } | null {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(WORKSPACE_EVENT, listener);
      return () => window.removeEventListener(WORKSPACE_EVENT, listener);
    },
    readZaicodeCurrentWorkspace,
    readZaicodeCurrentWorkspace,
  );
}
