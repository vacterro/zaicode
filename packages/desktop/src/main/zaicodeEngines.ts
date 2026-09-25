/* eslint-disable max-lines -- ZAICODE engines main half keeps discovery, quota probes and the sweep state in one owner module. */
import { app, BrowserWindow } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import {
  normalizeZaicodeEnginesConfig,
  parseAntigravityUsage,
  parseClaudeUsageText,
  parseCodexRateLimits,
  parseFreebuffSession,
  parseZcodeQuota,
  zaicodeBottleneck,
  type ZaicodeEngineAccount,
  type ZaicodeEnginesConfig,
  type ZaicodeEnginesState,
  type ZaicodeLimitSnapshot,
  type ZaicodeLimitWindow,
} from "@zcode/shared";
import { setWindowsDesktopTrayLimits } from "./desktopTray.js";

/**
 * ZAICODE engines, main-process half: discovers every subscription the
 * operator already has (Claude Code / Codex homes, Antigravity CLI login,
 * ZCode plan key), reads each one's quota with the vendor's own read-only
 * call on a timer, and pushes one state record to every window.
 *
 * Rules carried over from LIMISAW / FastPrompter:
 * - reading quota never spends quota and never logs a credential;
 * - discovered, not hard-coded: ~/.claude-*, ~/.codex-* all become engines;
 * - a failed read keeps the last good numbers (marked stale), never blanks;
 * - probes run hidden, below the UI, under hard deadlines, children killed.
 */

export const ZAICODE_ENGINES_CHANGED_CHANNEL = "zaicode:engines-changed";

const CONFIG_FILE = "zaicode-engines.json";
const CACHE_FILE = "zaicode-engines-cache.json";
const PROBE_CONCURRENCY = 2;
const CLAUDE_TIMEOUT_MS = 60_000;
const CODEX_TIMEOUT_MS = 30_000;
const AGY_TIMEOUT_MS = 45_000;
const ZCODE_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const SYSTEM_ROOT = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";

const ZCODE_PLAN_PROVIDER_IDS = [
  "builtin:zai-coding-plan",
  "builtin:zai-start-plan",
  "builtin:bigmodel-coding-plan",
  "builtin:bigmodel-start-plan",
];
const ZCODE_ALLOWED_HOSTS = new Set(["api.z.ai", "api.chatglm.site", "open.bigmodel.cn", "bigmodel.cn"]);
const ZCODE_QUOTA_PATH = "/api/monitor/usage/quota/limit";

// Freebuff (SRC-043, metrics only): the same read-only GET Freebuff Desktop refreshes its own
// header with (FastPrompter's _freebuff_http.py is the reference). A GET admits no session and
// spends nothing; creating a billable session is a POST with a model header, never sent here.
const FREEBUFF_SESSION_URL = "https://www.codebuff.com/api/v1/freebuff/session";
const FREEBUFF_ALLOWED_HOSTS = new Set(["www.codebuff.com", "codebuff.com"]);
/** The only sign-in entries whose token may go to codebuff.com (never "the first entry"). */
const FREEBUFF_SESSION_KEYS = new Set([
  "https://www.codebuff.com",
  "https://codebuff.com",
  "http://www.codebuff.com",
  "http://codebuff.com",
  "www.codebuff.com",
  "codebuff.com",
]);
const FREEBUFF_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function userDataFile(name: string): string {
  return join(app.getPath("userData"), name);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Executable resolution (PATH snapshot + installer directories)
// ---------------------------------------------------------------------------

function pathEntries(): string[] {
  const raw = process.env.PATH ?? process.env.Path ?? "";
  return raw
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function findOnPath(names: readonly string[]): string | null {
  for (const entry of pathEntries()) {
    for (const name of names) {
      const candidate = join(entry, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function firstFile(candidates: readonly string[]): string | null {
  return candidates.find((candidate) => isFile(candidate)) ?? null;
}

function home(): string {
  return process.env.USERPROFILE || homedir();
}

function localAppData(): string {
  return process.env.LOCALAPPDATA || join(home(), "AppData", "Local");
}

function resolveClaudeCli(): string | null {
  const local = join(home(), ".local", "bin");
  return (
    firstFile([join(local, "claude.exe"), join(local, "claude.cmd"), join(local, "claude")]) ??
    findOnPath(["claude.exe", "claude.cmd", "claude"])
  );
}

function resolveCodexCli(): string | null {
  return (
    findOnPath(["codex.cmd", "codex.exe", "codex"]) ??
    firstFile([join(home(), "AppData", "Roaming", "npm", "codex.cmd"), join(home(), ".local", "bin", "codex.exe")])
  );
}

function resolveAgyCli(): string | null {
  return (
    firstFile([join(localAppData(), "agy", "bin", "agy.exe"), join(home(), ".local", "bin", "agy.exe")]) ??
    findOnPath(["agy.exe", "agy"])
  );
}

/** ZCode's full CLI (TUI included) lives in the ZAICODE checkout next to the packaged app. */
function resolveZcodeCli(): string | null {
  const fromEnv = process.env.ZCODE_CLI?.trim();
  if (fromEnv && isFile(fromEnv)) return fromEnv;
  const starts = [dirname(process.execPath), app.getAppPath()];
  for (const start of starts) {
    let current = start;
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = join(current, "apps", "zcode-cli", "packages", "cli", "dist", "zcode.cjs");
      if (isFile(candidate)) return candidate;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

function resolveNodeExe(): string | null {
  return findOnPath(["node.exe", "node"]);
}

/**
 * Node refuses to spawn .cmd shims without a shell. npm shims are resolved to
 * `node <package script>` instead, so no argument ever passes through cmd.exe.
 */
function commandFor(cli: string, args: string[]): { file: string; args: string[] } {
  if (!/\.(cmd|bat)$/i.test(cli)) return { file: cli, args };
  const shimDir = dirname(cli);
  const codexScript = join(shimDir, "node_modules", "@openai", "codex", "bin", "codex.js");
  if (isFile(codexScript)) {
    const node = firstFile([join(shimDir, "node.exe")]) ?? resolveNodeExe() ?? "node";
    return { file: node, args: [codexScript, ...args] };
  }
  return { file: join(SYSTEM_ROOT, "System32", "cmd.exe"), args: ["/d", "/s", "/c", cli, ...args] };
}

// ---------------------------------------------------------------------------
// Process runner with a hard deadline
// ---------------------------------------------------------------------------

const liveChildren = new Set<ChildProcess>();

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn(join(SYSTEM_ROOT, "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }).on("error", () => child.kill());
      return;
    } catch {
      // fall through to a plain kill
    }
  }
  child.kill();
}

interface RunResult {
  ok: boolean;
  stdout: string;
  error: string;
}

function probeEnv(extra: Record<string, string | null>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // A quota read must not inherit "you are inside Claude Code" markers.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runCli(
  cli: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const command = commandFor(cli, args);
    let child: ChildProcess;
    try {
      child = spawn(command.file, command.args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolvePromise({ ok: false, stdout: "", error: error instanceof Error ? error.message : String(error) });
      return;
    }
    liveChildren.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveChildren.delete(child);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      killTree(child);
      const hint = stderr.trim().split(/\r?\n/).at(-1) || stdout.trim().split(/\r?\n/).at(-1) || "";
      finish({ ok: false, stdout, error: hint ? `timed out: ${hint.slice(0, 140)}` : "timed out" });
    }, options.timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on("error", (error) => finish({ ok: false, stdout, error: error.message }));
    child.on("close", (code) => {
      if (code === 0) finish({ ok: true, stdout, error: "" });
      else {
        const detail = stderr.trim().split(/\r?\n/).find(Boolean) ?? "";
        finish({ ok: false, stdout, error: detail ? detail.slice(0, 160) : `exit ${code}` });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function claudeProfileHasEvidence(dir: string): boolean {
  return isFile(join(dir, ".credentials.json")) || isFile(join(dir, ".claude.json"));
}

function listHomeSiblings(prefix: string): string[] {
  try {
    return readdirSync(home())
      .filter((name) => name.startsWith(`${prefix}-`) && isDirectory(join(home(), name)))
      .sort((left, right) => left.localeCompare(right))
      .map((name) => join(home(), name));
  } catch {
    return [];
  }
}

function canonical(path: string): string {
  return resolve(path).replace(/\//g, "\\").toLowerCase();
}

function accountId(vendor: string, source: string): string {
  return `${vendor}:${canonical(source)}`;
}

function displayHome(path: string): string {
  const root = home();
  return path.toLowerCase().startsWith(root.toLowerCase()) ? `~${path.slice(root.length)}` : path;
}

function discoverClaude(): ZaicodeEngineAccount[] {
  const cli = resolveClaudeCli();
  const defaultDir = join(home(), ".claude");
  const dirs: string[] = [];
  const seen = new Set<string>();
  const push = (dir: string) => {
    const key = canonical(dir);
    if (seen.has(key)) return;
    seen.add(key);
    dirs.push(dir);
  };
  push(defaultDir);
  for (const dir of listHomeSiblings(".claude")) if (claudeProfileHasEvidence(dir)) push(dir);
  for (const dir of (process.env.CLAUDE_CONFIG_DIR ?? "").split(";").map((value) => value.trim()).filter(Boolean)) {
    if (isDirectory(dir)) push(dir);
  }
  return dirs.map((dir, index) => {
    const isDefault = canonical(dir) === canonical(defaultDir);
    const loggedIn = isFile(join(dir, ".credentials.json")) || (isDefault && isFile(join(home(), ".claude.json")));
    const setHome = isDefault ? "Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; " : `$env:CLAUDE_CONFIG_DIR = '${dir.replace(/'/g, "''")}'; `;
    const account: ZaicodeEngineAccount = {
      id: accountId("claude", dir),
      vendor: "claude",
      short: `A${index + 1}`,
      label: `Claude ${index + 1}`,
      source: displayHome(dir),
      home: dir,
      isDefaultHome: isDefault,
      cli,
      status: "ready",
      statusDetail: "",
      fixCommand: null,
    };
    if (!cli) {
      account.status = "cli-missing";
      account.statusDetail = "Claude Code CLI is not installed.";
      account.fixCommand = "irm https://claude.ai/install.ps1 | iex";
    } else if (!loggedIn) {
      account.status = "login-required";
      account.statusDetail = `Not signed in (${displayHome(dir)}).`;
      account.fixCommand = `${setHome}& '${cli.replace(/'/g, "''")}' auth login`;
    }
    return account;
  });
}

function discoverCodex(): ZaicodeEngineAccount[] {
  const cli = resolveCodexCli();
  const defaultDir = join(home(), ".codex");
  const dirs = [defaultDir, ...listHomeSiblings(".codex").filter((dir) => isFile(join(dir, "auth.json")) || isFile(join(dir, "config.toml")))];
  return dirs.map((dir, index) => {
    const isDefault = canonical(dir) === canonical(defaultDir);
    const account: ZaicodeEngineAccount = {
      id: accountId("codex", dir),
      vendor: "codex",
      short: `C${index + 1}`,
      label: `Codex ${index + 1}`,
      source: displayHome(dir),
      home: dir,
      isDefaultHome: isDefault,
      cli,
      status: "ready",
      statusDetail: "",
      fixCommand: null,
    };
    if (!cli) {
      account.status = "cli-missing";
      account.statusDetail = "Codex CLI is not installed.";
      account.fixCommand = "npm install -g @openai/codex";
    } else if (!isFile(join(dir, "auth.json"))) {
      account.status = "login-required";
      account.statusDetail = `Not signed in (${displayHome(dir)}).`;
      account.fixCommand = `$env:CODEX_HOME = '${dir.replace(/'/g, "''")}'; codex login`;
    }
    return account;
  });
}

let agyCredentialCache: { at: number; present: boolean } | null = null;

/** Presence of Antigravity's saved login in Windows Credential Manager (never its content). */
async function agyCredentialPresent(): Promise<boolean> {
  if (process.platform !== "win32") return true;
  if (agyCredentialCache && Date.now() - agyCredentialCache.at < 60_000) return agyCredentialCache.present;
  const result = await runCli(join(SYSTEM_ROOT, "System32", "cmdkey.exe"), ["/list:gemini:antigravity"], {
    env: process.env,
    timeoutMs: 8000,
  });
  const present = /gemini:antigravity/i.test(result.stdout);
  agyCredentialCache = { at: Date.now(), present };
  return present;
}

async function discoverAntigravity(): Promise<ZaicodeEngineAccount[]> {
  const cli = resolveAgyCli();
  const account: ZaicodeEngineAccount = {
    id: "antigravity:default",
    vendor: "antigravity",
    short: "AG",
    label: "Antigravity",
    source: "gemini:antigravity",
    home: null,
    isDefaultHome: true,
    cli,
    status: "ready",
    statusDetail: "",
    fixCommand: null,
  };
  if (!cli) {
    account.status = "cli-missing";
    account.statusDetail = "Antigravity CLI (agy) is not installed.";
    account.fixCommand = "irm https://antigravity.google/cli/install.ps1 | iex";
  } else if (!(await agyCredentialPresent())) {
    account.status = "login-required";
    account.statusDetail = "Antigravity CLI is not signed in.";
    account.fixCommand = `& '${cli.replace(/'/g, "''")}'`;
  }
  return [account];
}

interface ZcodePlanEntry {
  id: string;
  baseUrl: string;
  apiKey: string;
}

function zcodeConfigPath(): string {
  return join(home(), ".zcode", "v2", "config.json");
}

/** Only the plan entries; the key stays in this process and goes only to the vendor host. */
function readZcodePlanEntries(): ZcodePlanEntry[] {
  const payload = readJson(zcodeConfigPath()) as { provider?: Record<string, unknown> } | null;
  const providers = payload?.provider;
  if (!providers || typeof providers !== "object") return [];
  const entries: ZcodePlanEntry[] = [];
  for (const id of ZCODE_PLAN_PROVIDER_IDS) {
    const entry = providers[id] as
      | { enabled?: unknown; systemDisabledReason?: unknown; options?: { apiKey?: unknown; baseURL?: unknown } }
      | undefined;
    if (!entry || entry.enabled === false || entry.systemDisabledReason) continue;
    const apiKey = typeof entry.options?.apiKey === "string" ? entry.options.apiKey.trim() : "";
    if (!apiKey) continue;
    entries.push({ id, apiKey, baseUrl: typeof entry.options?.baseURL === "string" ? entry.options.baseURL : "" });
  }
  return entries;
}

function discoverZcode(config: ZaicodeEnginesConfig): ZaicodeEngineAccount[] {
  const script = resolveZcodeCli();
  const node = resolveNodeExe();
  const plans = config.readZcodeConfig ? readZcodePlanEntries() : [];
  const account: ZaicodeEngineAccount = {
    id: "zcode:plan",
    vendor: "zcode",
    short: "ZC",
    label: "ZCode",
    source: plans[0] ? `~/.zcode/v2/config.json#${plans[0].id}` : "~/.zcode/v2/config.json",
    home: null,
    isDefaultHome: true,
    cli: script,
    status: "ready",
    statusDetail: "",
    fixCommand: null,
  };
  if (!script || !node) {
    account.status = "cli-missing";
    account.statusDetail = !node ? "node.exe is not on PATH." : "ZCode CLI build (zcode.cjs) not found.";
    account.fixCommand = null;
  } else if (!config.readZcodeConfig) {
    account.status = "no-plan";
    account.statusDetail = "Quota reading is off (Settings -> Engines -> Read ZCode plan key).";
  } else if (plans.length === 0) {
    account.status = "no-plan";
    account.statusDetail = "No Z.ai / BigModel Coding Plan key in ZCode's config.";
    account.fixCommand = `& '${(node ?? "node").replace(/'/g, "''")}' '${script.replace(/'/g, "''")}' login zai`;
  }
  return [account];
}

function freebuffStatePath(): string {
  return join(home(), ".config", "freebuff-desktop", "state.json");
}

/** Freebuff Desktop's sign-in for a proven codebuff host: token + non-secret user facts. */
function readFreebuffSignIn(): { token: string; userId: string } | null {
  const payload = readJson(freebuffStatePath()) as { authSessions?: unknown } | null;
  const sessions = payload?.authSessions;
  if (!sessions || typeof sessions !== "object") return null;
  for (const [key, value] of Object.entries(sessions as Record<string, unknown>)) {
    if (!FREEBUFF_SESSION_KEYS.has(key.trim().replace(/\/+$/, "").toLowerCase())) continue;
    if (!value || typeof value !== "object") continue;
    const entry = value as { token?: unknown; user?: { id?: unknown } };
    const token = typeof entry.token === "string" ? entry.token.trim() : "";
    if (!token) return null;
    return { token, userId: typeof entry.user?.id === "string" ? entry.user.id : "" };
  }
  return null;
}

/** Freebuff appears only where Freebuff Desktop is installed; it is measured, never launched. */
function discoverFreebuff(config: ZaicodeEnginesConfig): ZaicodeEngineAccount[] {
  if (!config.readFreebuff || !isFile(freebuffStatePath())) return [];
  const signIn = readFreebuffSignIn();
  return [
    {
      id: `freebuff:${signIn?.userId || "default"}`,
      vendor: "freebuff",
      short: "FB",
      label: "Freebuff",
      source: "~/.config/freebuff-desktop/state.json",
      home: null,
      isDefaultHome: true,
      cli: null,
      status: signIn ? "ready" : "login-required",
      statusDetail: signIn ? "" : "Freebuff Desktop is not signed in (sign in there; ZAICODE only reads its quota).",
      fixCommand: null,
    },
  ];
}

async function discoverAccounts(config: ZaicodeEnginesConfig): Promise<ZaicodeEngineAccount[]> {
  const antigravity = await discoverAntigravity();
  return [...discoverClaude(), ...discoverCodex(), ...antigravity, ...discoverZcode(config), ...discoverFreebuff(config)];
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

interface ProbeOutcome {
  windows: ZaicodeLimitWindow[];
  plan: string | null;
  error: string | null;
  source: string;
}

function probeDir(): string {
  const dir = userDataFile("zaicode-limit-probe");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // runCli falls back to the process cwd
  }
  return dir;
}

async function probeClaude(account: ZaicodeEngineAccount): Promise<ProbeOutcome> {
  const source = "claude -p /usage";
  if (!account.cli) return { windows: [], plan: null, error: "Claude Code CLI not found", source };
  const sessionId = randomUUID();
  const cwd = probeDir();
  const result = await runCli(account.cli, ["-p", "/usage", "--output-format", "json", "--session-id", sessionId], {
    cwd,
    timeoutMs: CLAUDE_TIMEOUT_MS,
    env: probeEnv({ CLAUDE_CONFIG_DIR: account.isDefaultHome ? null : account.home }),
  });
  // A quota read is not a conversation: drop the transcript the CLI filed for it.
  const configRoot = account.isDefaultHome || !account.home ? join(home(), ".claude") : account.home;
  const slug = resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
  try {
    unlinkSync(join(configRoot, "projects", slug, `${sessionId}.jsonl`));
  } catch {
    // nothing filed
  }
  if (!result.ok && !result.stdout.trim()) return { windows: [], plan: null, error: result.error, source };
  type ClaudePrintResult = { result?: unknown; is_error?: unknown };
  let payload: ClaudePrintResult | null;
  try {
    const text = result.stdout;
    payload = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as ClaudePrintResult | null;
  } catch {
    return { windows: [], plan: null, error: result.error || "claude /usage did not return JSON", source };
  }
  if (!payload || payload.is_error || typeof payload.result !== "string") {
    const message = typeof payload?.result === "string" ? payload.result.split("\n")[0] ?? "" : "";
    return { windows: [], plan: null, error: message ? message.slice(0, 160) : "claude /usage reported an error", source };
  }
  const windows = parseClaudeUsageText(payload.result);
  if (windows.length === 0) {
    const firstLine = payload.result.split("\n").find((line) => line.trim()) ?? "";
    return {
      windows: [],
      plan: null,
      error: /log ?in|sign ?in|authenticat/i.test(firstLine)
        ? firstLine.slice(0, 160)
        : "no subscription limits reported (API-key account?)",
      source,
    };
  }
  return { windows, plan: "subscription", error: null, source };
}

async function probeCodex(account: ZaicodeEngineAccount): Promise<ProbeOutcome> {
  const source = "codex app-server account/rateLimits/read";
  if (!account.cli) return { windows: [], plan: null, error: "Codex CLI not found", source };
  if (!account.home || !isDirectory(account.home)) return { windows: [], plan: null, error: "CODEX_HOME missing", source };
  const command = commandFor(account.cli, ["app-server"]);
  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(command.file, command.args, {
        env: probeEnv({ CODEX_HOME: account.home, OPENAI_API_KEY: null, CODEX_API_KEY: null, CODEX_ACCESS_TOKEN: null }),
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch (error) {
      resolvePromise({ windows: [], plan: null, error: error instanceof Error ? error.message : String(error), source });
      return;
    }
    liveChildren.add(child);
    let buffer = "";
    let settled = false;
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin?.end();
      } catch {
        // already closed
      }
      killTree(child);
      liveChildren.delete(child);
      resolvePromise(outcome);
    };
    const timer = setTimeout(() => finish({ windows: [], plan: null, error: "timed out waiting for codex", source }), CODEX_TIMEOUT_MS);
    const send = (message: Record<string, unknown>) => {
      try {
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      } catch {
        // the close handler reports it
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        type RpcMessage = { id?: unknown; result?: unknown; error?: { message?: unknown } };
        let message: RpcMessage | null;
        try {
          message = JSON.parse(line) as RpcMessage | null;
        } catch {
          continue;
        }
        if (message?.id === 1) {
          if (message.error) {
            finish({ windows: [], plan: null, error: `initialize: ${String(message.error.message ?? "error")}`, source });
            return;
          }
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (message?.id === 2) {
          if (message.error) {
            finish({ windows: [], plan: null, error: String(message.error.message ?? "rateLimits error").slice(0, 160), source });
            return;
          }
          const parsed = parseCodexRateLimits(message.result);
          finish({
            windows: parsed.windows,
            plan: parsed.plan,
            error: parsed.windows.length ? null : "codex reported no quota window",
            source,
          });
        }
      }
    });
    child.on("error", (error) => finish({ windows: [], plan: null, error: error.message, source }));
    child.on("close", () => finish({ windows: [], plan: null, error: "codex app-server exited", source }));
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "zaicode", version: "1.0.0" }, capabilities: null } });
  });
}

async function probeAntigravity(account: ZaicodeEngineAccount): Promise<ProbeOutcome> {
  const source = "agy -p /usage";
  if (!account.cli) return { windows: [], plan: null, error: "Antigravity CLI not found", source };
  if (!(await agyCredentialPresent())) return { windows: [], plan: null, error: "not signed in", source };
  const result = await runCli(account.cli, ["-p", "/usage", "--output-format", "json"], {
    timeoutMs: AGY_TIMEOUT_MS,
    env: probeEnv({
      SSH_CONNECTION: null,
      SSH_TTY: null,
      AGY_CLI_INTERACTIVE_HEADLESS: null,
      // Blocks the browser fallback if the saved login expired mid-sweep.
      BROWSER: join(SYSTEM_ROOT, "System32", "where.exe"),
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    }),
  });
  if (!result.ok) {
    const failure = `${result.stdout}\n${result.error}`.toLowerCase();
    if (/authentication required|waiting for authentication|authorization code|not logged in|please log in/.test(failure)) {
      agyCredentialCache = { at: Date.now(), present: false };
      return { windows: [], plan: null, error: "sign-in expired; login required", source };
    }
    return { windows: [], plan: null, error: result.error, source };
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return { windows: [], plan: null, error: "agy /usage did not return JSON", source };
  }
  const windows = parseAntigravityUsage(payload);
  return { windows, plan: null, error: windows.length ? null : "agy reported no readable quota window", source };
}

function zcodeQuotaUrl(baseUrl: string): string | null {
  const text = baseUrl.trim();
  if (!text) return `https://api.z.ai${ZCODE_QUOTA_PATH}`;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!ZCODE_ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;
    return `https://${url.hostname.toLowerCase()}${ZCODE_QUOTA_PATH}`;
  } catch {
    return null;
  }
}

function httpsGetJson(url: string, apiKey: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(url);
    if (target.protocol !== "https:" || !ZCODE_ALLOWED_HOSTS.has(target.hostname)) {
      reject(new Error("unrecognized quota endpoint"));
      return;
    }
    const request = httpsRequest(
      target,
      { method: "GET", headers: { Authorization: apiKey, Accept: "application/json" }, timeout: timeoutMs },
      (response) => {
        if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
          response.resume();
          reject(new Error("quota redirects are not accepted"));
          return;
        }
        if ((response.statusCode ?? 0) >= 400) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 512 * 1024) request.destroy(new Error("quota response too large"));
        });
        response.on("end", () => {
          try {
            resolvePromise(JSON.parse(body));
          } catch {
            reject(new Error("bad JSON"));
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", (error) => reject(error));
    request.end();
  });
}

async function probeZcode(config: ZaicodeEnginesConfig): Promise<ProbeOutcome> {
  const source = "z.ai monitor quota";
  if (!config.readZcodeConfig) return { windows: [], plan: null, error: "plan key reading is off", source };
  const entry = readZcodePlanEntries()[0];
  if (!entry) return { windows: [], plan: null, error: "no Coding Plan key", source };
  const url = zcodeQuotaUrl(entry.baseUrl);
  if (!url) return { windows: [], plan: null, error: "configured host is not a Z.ai / BigModel endpoint", source };
  try {
    const envelope = await httpsGetJson(url, entry.apiKey, ZCODE_TIMEOUT_MS);
    const parsed = parseZcodeQuota(envelope);
    return { windows: parsed.windows, plan: parsed.level, error: parsed.error, source };
  } catch (error) {
    // Only the error TYPE/status: the request (and its key) never reaches a message.
    const message = error instanceof Error ? error.message : "request failed";
    return { windows: [], plan: null, error: `quota endpoint: ${message.slice(0, 80)}`, source };
  }
}

function freebuffGetSession(token: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(FREEBUFF_SESSION_URL);
    if (target.protocol !== "https:" || !FREEBUFF_ALLOWED_HOSTS.has(target.hostname)) {
      reject(new Error("unrecognized session endpoint"));
      return;
    }
    const request = httpsRequest(
      target,
      {
        method: "GET",
        // The desktop app's own refresh: multi-session marker, no model header (that is the POST trigger).
        headers: { Authorization: `Bearer ${token}`, "x-freebuff-multi-session": "1", Accept: "application/json" },
        timeout: timeoutMs,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          reject(new Error("session redirects are not accepted"));
          return;
        }
        if (status >= 400) {
          response.resume();
          reject(new Error(status === 401 || status === 403 ? `sign-in rejected (HTTP ${status})` : `HTTP ${status}`));
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 512 * 1024) request.destroy(new Error("session response too large"));
        });
        response.on("end", () => {
          try {
            resolvePromise(JSON.parse(body));
          } catch {
            reject(new Error("bad JSON"));
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", (error) => reject(error));
    request.end();
  });
}

async function probeFreebuff(): Promise<ProbeOutcome> {
  const source = "freebuff session (read-only)";
  if (!config.readFreebuff) return { windows: [], plan: null, error: "Freebuff reading is off", source };
  // The token is read at probe time and lives only in this request header.
  const signIn = readFreebuffSignIn();
  if (!signIn) return { windows: [], plan: null, error: "Freebuff Desktop is not signed in", source };
  try {
    const parsed = parseFreebuffSession(await freebuffGetSession(signIn.token, FREEBUFF_TIMEOUT_MS));
    return { windows: parsed.windows, plan: parsed.plan, error: parsed.error, source };
  } catch (error) {
    // Only the error text of the transport / status: the request (and its token) never reaches a message.
    const message = error instanceof Error ? error.message : "request failed";
    return { windows: [], plan: null, error: `Freebuff: ${message.slice(0, 80)}`, source };
  }
}

// ---------------------------------------------------------------------------
// Engine state, sweep and IPC
// ---------------------------------------------------------------------------

let config: ZaicodeEnginesConfig = normalizeZaicodeEnginesConfig(null);
let accounts: ZaicodeEngineAccount[] = [];
let limits: Record<string, ZaicodeLimitSnapshot> = {};
let sweeping = false;
const probing = new Set<string>();
let lastSweepAt: number | null = null;
let nextSweepAt: number | null = null;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let pendingSweep: Promise<void> | null = null;

export function getZaicodeEnginesState(): ZaicodeEnginesState {
  return {
    accounts,
    limits,
    sweeping,
    probing: [...probing],
    lastSweepAt,
    nextSweepAt,
    config,
  };
}

/** "A1 78% · C1 0% · AG 4%" for the tray tooltip: the number that decides each engine. */
function trayLimitsLine(): string {
  const now = Date.now();
  const parts: string[] = [];
  for (const account of accounts) {
    if (config.hiddenAccounts.includes(account.id)) continue;
    const snapshot = limits[account.id];
    if (!snapshot || snapshot.windows.length === 0) continue;
    const bottleneck = zaicodeBottleneck(snapshot.windows, now);
    if (bottleneck?.remainingPercent === null || bottleneck?.remainingPercent === undefined) continue;
    parts.push(`${account.short} ${Math.round(bottleneck.remainingPercent)}%`);
  }
  return parts.join(" · ");
}

function broadcast(): void {
  setWindowsDesktopTrayLimits(trayLimitsLine());
  const state = getZaicodeEnginesState();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(ZAICODE_ENGINES_CHANGED_CHANNEL, state);
  }
}

function persistCache(): void {
  try {
    writeJsonAtomic(userDataFile(CACHE_FILE), { limits, lastSweepAt });
  } catch {
    // The cache only speeds up the next start.
  }
}

function loadCache(): void {
  const cached = readJson(userDataFile(CACHE_FILE)) as { limits?: unknown; lastSweepAt?: unknown } | null;
  if (cached?.limits && typeof cached.limits === "object") {
    limits = cached.limits as Record<string, ZaicodeLimitSnapshot>;
  }
  if (typeof cached?.lastSweepAt === "number") lastSweepAt = cached.lastSweepAt;
}

async function probeAccount(account: ZaicodeEngineAccount): Promise<void> {
  if (account.status === "cli-missing") return;
  if (account.vendor !== "zcode" && account.status === "login-required") {
    const previous = limits[account.id];
    limits = {
      ...limits,
      [account.id]: {
        accountId: account.id,
        windows: previous?.windows ?? [],
        plan: previous?.plan ?? null,
        fetchedAt: previous?.fetchedAt ?? null,
        checkedAt: Date.now(),
        error: account.statusDetail || "login required",
        source: previous?.source ?? "",
      },
    };
    return;
  }
  probing.add(account.id);
  broadcast();
  let outcome: ProbeOutcome;
  try {
    outcome =
      account.vendor === "claude"
        ? await probeClaude(account)
        : account.vendor === "codex"
          ? await probeCodex(account)
          : account.vendor === "antigravity"
            ? await probeAntigravity(account)
            : account.vendor === "freebuff"
              ? await probeFreebuff()
              : await probeZcode(config);
  } catch (error) {
    outcome = { windows: [], plan: null, error: error instanceof Error ? error.message : String(error), source: "" };
  }
  probing.delete(account.id);
  const now = Date.now();
  const previous = limits[account.id];
  const success = outcome.windows.length > 0;
  limits = {
    ...limits,
    [account.id]: success
      ? { accountId: account.id, windows: outcome.windows, plan: outcome.plan, fetchedAt: now, checkedAt: now, error: null, source: outcome.source }
      : {
          accountId: account.id,
          // A vendor CLI that fails once is not a vendor without quota: keep the last good numbers.
          windows: previous?.windows ?? [],
          plan: previous?.plan ?? outcome.plan,
          fetchedAt: previous?.fetchedAt ?? null,
          checkedAt: now,
          error: outcome.error ?? "read failed",
          source: outcome.source,
        },
  };
}

async function runPool(targets: ZaicodeEngineAccount[]): Promise<void> {
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await probeAccount(next);
      broadcast();
    }
  });
  await Promise.all(workers);
}

function scheduleNextSweep(): void {
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = null;
  if (config.intervalMinutes <= 0) {
    nextSweepAt = null;
    return;
  }
  const delay = config.intervalMinutes * 60_000;
  nextSweepAt = Date.now() + delay;
  sweepTimer = setTimeout(() => void refreshZaicodeEngines(), delay);
  sweepTimer.unref?.();
}

/** Rediscovers accounts and reads quota for all (or one) of them. Concurrent calls share one sweep. */
export function refreshZaicodeEngines(onlyAccountId?: string): Promise<void> {
  if (pendingSweep && !onlyAccountId) return pendingSweep;
  const run = (async () => {
    sweeping = true;
    broadcast();
    try {
      accounts = await discoverAccounts(config);
      const visible = accounts.filter((account) => !config.hiddenAccounts.includes(account.id));
      const targets = onlyAccountId ? accounts.filter((account) => account.id === onlyAccountId) : visible;
      await runPool(targets);
      if (!onlyAccountId) lastSweepAt = Date.now();
      persistCache();
    } finally {
      sweeping = false;
      if (!onlyAccountId) scheduleNextSweep();
      broadcast();
    }
  })();
  if (!onlyAccountId) {
    pendingSweep = run.finally(() => {
      pendingSweep = null;
    });
    return pendingSweep;
  }
  return run;
}

export function setZaicodeEnginesConfig(patch: unknown): ZaicodeEnginesState {
  const next = normalizeZaicodeEnginesConfig({ ...config, ...(patch && typeof patch === "object" ? patch : {}) });
  const intervalChanged = next.intervalMinutes !== config.intervalMinutes;
  const zcodeChanged = next.readZcodeConfig !== config.readZcodeConfig;
  const freebuffChanged = next.readFreebuff !== config.readFreebuff;
  config = next;
  try {
    writeJsonAtomic(userDataFile(CONFIG_FILE), config);
  } catch {
    // Applies for this run anyway.
  }
  if (intervalChanged) scheduleNextSweep();
  if (zcodeChanged) void refreshZaicodeEngines("zcode:plan");
  if (freebuffChanged) void refreshZaicodeEngines();
  broadcast();
  return getZaicodeEnginesState();
}

/** Starts discovery + the first sweep shortly after launch (never blocks startup). */
export function startZaicodeEngines(): void {
  if (started) return;
  started = true;
  config = normalizeZaicodeEnginesConfig(readJson(userDataFile(CONFIG_FILE)));
  loadCache();
  const firstDelay = 8000;
  nextSweepAt = Date.now() + firstDelay;
  const timer = setTimeout(() => void refreshZaicodeEngines(), firstDelay);
  timer.unref?.();
  // Discovery alone is cheap: give the renderer the account list right away.
  void discoverAccounts(config).then((found) => {
    accounts = found;
    broadcast();
  });
  app.once("will-quit", () => {
    if (sweepTimer) clearTimeout(sweepTimer);
    for (const child of liveChildren) killTree(child);
  });
}

// ---------------------------------------------------------------------------
// External worker windows and "start with Windows"
// ---------------------------------------------------------------------------

/**
 * Opens a worker in its own PowerShell window (survives a ZAICODE restart).
 * `command` is built by the renderer from discovered paths and quoted there.
 */
export function launchZaicodeExternalWorker(params: { cwd: string; command: string; title: string }): {
  ok: boolean;
  message: string;
} {
  if (!isDirectory(params.cwd)) return { ok: false, message: `Folder not found: ${params.cwd}` };
  const shell = findOnPath(["pwsh.exe"]) ?? join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const title = params.title.replace(/'/g, "''").slice(0, 120);
  const script = `$Host.UI.RawUI.WindowTitle = '${title}'; ${params.command}`;
  try {
    const child = spawn(shell, ["-NoLogo", "-NoExit", "-Command", script], {
      cwd: params.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      env: probeEnv({}),
    });
    child.unref();
    return { ok: true, message: `Started ${params.title}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "ZAICODE";

/** The root launcher (`_ZAICODE\ZAICODE.exe`) sets ZAICODE mode; it is what Windows should start. */
function launcherPath(): string {
  let current = dirname(process.execPath);
  for (let depth = 0; depth < 7; depth += 1) {
    const candidate = join(current, "ZAICODE.exe");
    if (isFile(candidate) && !isDirectory(join(current, "resources"))) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.execPath;
}

export async function getZaicodeStartWithWindows(): Promise<{ enabled: boolean; command: string }> {
  if (process.platform !== "win32") return { enabled: false, command: "" };
  const result = await runCli(join(SYSTEM_ROOT, "System32", "reg.exe"), ["query", RUN_KEY, "/v", RUN_VALUE], {
    env: process.env,
    timeoutMs: 8000,
  });
  const match = /REG_SZ\s+(.+)$/m.exec(result.stdout);
  return { enabled: result.ok && Boolean(match), command: match?.[1]?.trim() ?? "" };
}

export async function setZaicodeStartWithWindows(enabled: boolean): Promise<{ enabled: boolean; command: string }> {
  if (process.platform !== "win32") return { enabled: false, command: "" };
  const reg = join(SYSTEM_ROOT, "System32", "reg.exe");
  if (enabled) {
    const target = launcherPath();
    await runCli(reg, ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", `"${target}"`, "/f"], {
      env: process.env,
      timeoutMs: 8000,
    });
  } else {
    await runCli(reg, ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"], { env: process.env, timeoutMs: 8000 });
  }
  return getZaicodeStartWithWindows();
}

/** Creates the next free `~/.claude-accountN` / `~/.codex-accountN` home for a second login. */
export function prepareZaicodeEngineAccountHome(vendor: string): { ok: boolean; home: string; message: string } {
  const prefix = vendor === "codex" ? ".codex-account" : vendor === "claude" ? ".claude-account" : "";
  if (!prefix) return { ok: false, home: "", message: "Only Claude and Codex keep several accounts." };
  for (let index = 2; index < 20; index += 1) {
    const dir = join(home(), `${prefix}${index}`);
    const empty = !existsSync(dir) || (isDirectory(dir) && readdirSync(dir).length === 0);
    if (empty) {
      mkdirSync(dir, { recursive: true });
      return { ok: true, home: dir, message: `Sign in inside ${basename(dir)}` };
    }
  }
  return { ok: false, home: "", message: "No free account slot." };
}
