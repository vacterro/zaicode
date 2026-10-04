/**
 * SAI Accounts —— 可选的共享账号控制面。
 *
 * SAI Accounts 是联邦，不是依赖。这个模块允许回答"什么都没有"：控制面缺失、停止、
 * 损坏或从未安装时，下面的每个函数都返回空结果，ZAICODE 的账号体系与这个文件存在
 * 之前完全一致。这里不写、不发布、不导出任何东西——账号只通过操作者在别处明确执行的
 * 动作进入共享注册表。
 *
 * 规则各出现一次：
 *
 * - STANDALONE —— 无控制面。`listSharedAccounts` 返回空，ZAICODE 保留自己的 Provider
 *   Config、登录与权益判定路径，一行都不改。
 * - FEDERATED —— 有控制面。共享账号出现在列表里，`origin = "SHARED"`。
 * - HYBRID —— 两者都有。只有身份定位符能证明是同一个身份时才合并；显示名永远不是证据。
 *
 * 控制面拥有 canonical `account_id`、provider、执行上下文与全局生命周期状态。ZAICODE
 * 继续拥有本地的部分：Provider Config Overlay、`entitled` / `availability` 事实与自己的
 * 展示。共享 id 与 ZAICODE 的 provider id 在不同命名空间里，因此共享记录不可能冒充本地
 * provider。
 *
 * ponytail: 控制面首先是注册表，其次才是 broker。某个 provider 它还不会读时，回答
 * `provider_does_not_support_quota`——这是诚实的"没有意见"，不是故障。升级路径：控制面
 * 为该 provider 装上 broker 之后，同一个调用开始返回窗口，这里的代码不用改。
 */

import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 控制面的安装位置。别处没有，这正是重点：没装过的机器走 STANDALONE。 */
export const SAI_ACCOUNTS_EXE_ENV = "SAI_ACCOUNTS_EXE";
export const SAI_ACCOUNTS_CANONICAL_INSTALL = "C:\\ProgramData\\SAI\\Accounts\\bin";

/**
 * 和本进程 spawn 的其它子进程一样有界。控制面是本地 CLI：还没答完就是"不在那里"。
 * 超时杀掉子进程，而不是把调用方挂住。
 */
export const SAI_ACCOUNTS_LIST_TIMEOUT_MS = 4_000;
export const SAI_ACCOUNTS_USAGE_TIMEOUT_CAP_MS = 30_000;

/**
 * "身份住在哪里"的统一词汇，证据强度从高到低。`profile_locator` 是真实路径，可与本地
 * 发现直接比较；`windows_user` 是 Windows 账号名。公开列表刻意不暴露 SID，任何版本都
 * 不得在这里把它加回来。
 */
const LOCATOR_FIELDS = ["profile_locator", "windows_user", "context_label"] as const;

export interface SharedAccount {
  /** canonical id，由控制面拥有 */
  readonly accountId: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly compactLabel: string;
  /** windows_user / profile_directory */
  readonly backend: string;
  /** 稳定的 provider 身份定位符，可能为空串 */
  readonly locator: string;
  readonly operationalState: string;
}

export interface SharedUsageWindow {
  readonly kind: string;
  readonly label: string;
  readonly remainingFraction: number;
  readonly usedFraction: number;
  readonly resetTime: string | null;
  readonly quotaBucket: string;
}

export type SharedProbeState =
  | "ok"
  | "unsupported"
  | "offline"
  | "auth_required"
  | "unavailable";

export interface SharedProbeResult {
  readonly windows: readonly SharedUsageWindow[];
  readonly state: SharedProbeState;
  readonly detail: string;
}

export interface SaiAccountsRunResult {
  readonly ok: boolean;
  readonly stdout: string;
}

/**
 * 控制面的两个出口。测试注入假的，其余代码用 `nodeSaiAccountsHost`。
 *
 * 抽成接口只有一个理由：可测。没有它，每个断言都得真的 spawn 一个 exe。
 */
export interface SaiAccountsHost {
  /** 解析不到就是空串，这是合法答案而不是错误 */
  readonly enginePath: () => string;
  readonly run: (argv: readonly string[], timeoutMs: number) => Promise<SaiAccountsRunResult>;
}

export function createNodeSaiAccountsHost(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): SaiAccountsHost {
  const run = async (argv: readonly string[], timeoutMs: number): Promise<SaiAccountsRunResult> => {
    const exe = host.enginePath();
    if (!exe) return { ok: false, stdout: "" };
    try {
      // argv 是数组，任何参数都不会被 shell 重新解释；子进程不弹控制台窗口。
      const done = await execFileAsync(exe, [...argv], {
        timeout: Math.max(100, timeoutMs),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      });
      return { ok: true, stdout: String(done.stdout ?? "") };
    } catch (error) {
      // 超时、ENOENT、非零退出都落到这里。stdout 可能仍然带着一份带类型的信封，
      // 所以失败与"没有回答"必须由调用方看信封本身来区分。
      const partial = (error as { stdout?: unknown } | undefined)?.stdout;
      return { ok: false, stdout: typeof partial === "string" ? partial : "" };
    }
  };
  const host: SaiAccountsHost = {
    enginePath: () => resolveSaiAccountsEngine(env, platform),
    run,
  };
  return host;
}

export const nodeSaiAccountsHost: SaiAccountsHost = createNodeSaiAccountsHost();

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveSaiAccountsEngine(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  installDir: string = SAI_ACCOUNTS_CANONICAL_INSTALL,
): string {
  if (platform !== "win32") return "";
  const override = env[SAI_ACCOUNTS_EXE_ENV]?.trim();
  if (override && existsSync(override)) return override;
  const installed = join(installDir, "sai-accounts.exe");
  if (existsSync(installed)) return installed;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    const name = dir.trim();
    if (!name) continue;
    const candidate = join(name, "sai-accounts.exe");
    if (existsSync(candidate) && isExecutableFile(candidate)) return candidate;
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseEnvelope(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

function locatorOf(entry: Record<string, unknown>): string {
  const meta = asRecord(entry.provider_metadata);
  for (const field of LOCATOR_FIELDS) {
    const value = meta[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const field of LOCATOR_FIELDS) {
    const value = entry[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * 合并键，大小写不敏感。空串意味着"无法证明"。
 *
 * 空定位符永远不能产生键：没有可比较身份的账号不是同一个账号，而用 "" 造出来的键会把
 * 所有无定位符的账号塌成一条。
 */
export function saiAccountsIdentityKey(providerId: string, locator: string): string {
  const provider = (providerId ?? "").trim().toLowerCase();
  const value = (locator ?? "").trim().toLowerCase();
  if (!provider || !value) return "";
  return `${provider}|${value}`;
}

/**
 * 控制面在共享注册表里拥有、且处于启用且未隐藏状态的账号。
 *
 * 全局生命周期状态是控制面的判断：它隐藏或停用的账号从这里整个消失。ZAICODE 自己的
 * Overlay 与 per-app 设置是本地状态，这里既不读也不写。
 */
export async function listSharedAccounts(
  host: SaiAccountsHost,
  providerIds: readonly string[],
  timeoutMs: number = SAI_ACCOUNTS_LIST_TIMEOUT_MS,
): Promise<readonly SharedAccount[]> {
  if (!host.enginePath()) return [];
  const result = await host.run(["list"], timeoutMs);
  const accounts = parseEnvelope(result.stdout).accounts;
  if (!Array.isArray(accounts)) return [];
  const wanted = new Set(providerIds.map((id) => id.trim().toLowerCase()).filter(Boolean));
  const found: SharedAccount[] = [];
  for (const raw of accounts) {
    const entry = asRecord(raw);
    const accountId = entry.account_id;
    const providerId = entry.provider_id;
    if (typeof accountId !== "string" || !accountId.trim()) continue;
    if (typeof providerId !== "string") continue;
    if (!wanted.has(providerId.trim().toLowerCase())) continue;
    if (entry.hidden === true) continue;
    const state = typeof entry.operational_state === "string" && entry.operational_state
      ? entry.operational_state
      : "ENABLED";
    if (state !== "ENABLED") continue;
    found.push(
      Object.freeze({
        accountId: accountId.trim(),
        providerId: providerId.trim(),
        displayName: typeof entry.display_name === "string" && entry.display_name
          ? entry.display_name
          : accountId.trim(),
        compactLabel: typeof entry.compact_label === "string" ? entry.compact_label : "",
        backend: typeof entry.execution_backend === "string" ? entry.execution_backend : "",
        locator: locatorOf(entry),
        operationalState: state,
      }),
    );
  }
  return Object.freeze(found);
}

/**
 * 两套词汇之间只留一个转换点：控制面说 `remaining_fraction`、把窗口叫 `5h`，这里说
 * 比例、叫 `five_hour`。转换集中在这里，两套方言就不可能各自长出一个解析器。
 */
const WINDOW_KINDS: Readonly<Record<string, string>> = Object.freeze({
  "5h": "five_hour",
  weekly: "weekly",
  "7d": "weekly",
  monthly: "monthly",
  "30d": "monthly",
});

const WINDOW_LABELS: Readonly<Record<string, string>> = Object.freeze({
  five_hour: "5h",
  weekly: "weekly",
  monthly: "monthly",
});

export function parseSharedUsageWindows(payload: Record<string, unknown>): readonly SharedUsageWindow[] {
  const raw = payload.windows;
  if (!Array.isArray(raw)) return [];
  const windows: SharedUsageWindow[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    const name = typeof entry.window === "string" ? entry.window.trim().toLowerCase() : "";
    const kind = WINDOW_KINDS[name] ?? name;
    if (!kind) continue;
    const fraction = entry.remaining_fraction;
    if (typeof fraction !== "number" || !Number.isFinite(fraction)) continue;
    if (fraction < 0 || fraction > 1) continue;
    const bucket = typeof entry.pool_index === "string" || typeof entry.pool_index === "number"
      ? String(entry.pool_index)
      : "0";
    const reset = typeof entry.reset_time === "string" && entry.reset_time.trim()
      ? entry.reset_time.trim()
      : null;
    windows.push(
      Object.freeze({
        kind,
        label: WINDOW_LABELS[kind] ?? kind,
        remainingFraction: fraction,
        usedFraction: Math.round((1 - fraction) * 1e6) / 1e6,
        resetTime: reset,
        quotaBucket: bucket,
      }),
    );
  }
  return Object.freeze(windows);
}

/**
 * 通过控制面读一个共享账号。
 *
 * 先读信封，再看退出码。读不了某个账号的控制面会带着非零退出码**同时**打出一份带类型的
 * 信封——那是关于某一个账号的已知状态，不是整体故障，把它报成故障是对整个控制面的谎报。
 */
export async function probeSharedAccount(
  host: SaiAccountsHost,
  canonicalAccountId: string,
  timeoutMs: number = SAI_ACCOUNTS_USAGE_TIMEOUT_CAP_MS,
): Promise<SharedProbeResult> {
  if (!host.enginePath() || !canonicalAccountId.trim()) {
    return { windows: [], state: "unavailable", detail: "SAI Accounts did not answer" };
  }
  const result = await host.run(["usage", canonicalAccountId.trim()], timeoutMs);
  const payload = parseEnvelope(result.stdout);
  if (Object.keys(payload).length === 0) {
    return { windows: [], state: "unavailable", detail: "SAI Accounts did not answer" };
  }
  const windows = parseSharedUsageWindows(payload);
  if (windows.length > 0) return { windows, state: "ok", detail: "" };
  if (payload.auth_state === "AUTH_REQUIRED") {
    return { windows: [], state: "auth_required", detail: "not authenticated" };
  }
  const skipped = typeof payload.skipped_reason === "string" ? payload.skipped_reason : "";
  if (skipped === "provider_does_not_support_quota") {
    return { windows: [], state: "unsupported", detail: skipped };
  }
  if (skipped || payload.context_state === "OFFLINE") {
    return { windows: [], state: "offline", detail: skipped || "account context is offline" };
  }
  return { windows: [], state: "unavailable", detail: "SAI Accounts returned no usable reading" };
}
