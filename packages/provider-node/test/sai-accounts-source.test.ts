/**
 * SAI Accounts 联邦 —— 可选控制面。
 *
 * 每个用例都是确定的：没有真的引擎、真的 vendor、真的注册表写入、真的凭据读取。控制面
 * 通过 SaiAccountsHost 这一个接口伪造，因此这套断言证明的是契约，而不是这台机器碰巧
 * 装了什么。
 *
 * 契约一句话：SAI Accounts 是联邦，不是依赖。没有控制面时 ZAICODE 完整可用；装了就多出
 * 共享账号；本地账号两边都留着；只有身份被证明时才合并；控制面中途消失时应用不塌。
 *
 * 每条断言都驱动它点名的生产函数。这里没有复刻任何合并逻辑——测试复刻品只能证明复刻品。
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  listSharedAccounts,
  parseSharedUsageWindows,
  probeSharedAccount,
  resolveSaiAccountsEngine,
  saiAccountsIdentityKey,
  SAI_ACCOUNTS_EXE_ENV,
  type SaiAccountsHost,
  type SharedAccount,
} from "../src/sai-accounts-source.js";

const ENGINE = "C:\\fake\\sai-accounts.exe";
// ZAICODE 自己的账号 provider 前缀：config/provider/zcode-builtin.json 里 8 个
// account:* provider。控制面今天一个都没有，答案必须诚实地是空。
const ZAICODE_ACCOUNT_PROVIDERS = Object.freeze([
  "account:zai-individual-coding-plan",
  "account:zai-team-coding-plan",
  "account:zai-start-plan",
  "account:bigmodel-individual-coding-plan",
  "account:bigmodel-team-coding-plan",
  "account:bigmodel-start-plan",
  "account:zai-offpeak-idle-plan",
  "account:bigmodel-offpeak-idle-plan",
]);

// ── fakes ──────────────────────────────────────────────────────────────────

interface FakePlane extends SaiAccountsHost {
  engine: string;
  listOk: boolean;
  listStdout: string;
  usageOk: boolean;
  usageStdout: string;
  calls: string[];
}

function fakePlane(): FakePlane {
  const plane = {
    engine: ENGINE,
    listOk: true,
    listStdout: "",
    usageOk: true,
    usageStdout: "",
    calls: [] as string[],
    enginePath: () => plane.engine,
    run: async (argv: readonly string[], _timeoutMs: number) => {
      plane.calls.push(argv.join(" "));
      if (argv[0] === "list") return { ok: plane.listOk, stdout: plane.listStdout };
      return { ok: plane.usageOk, stdout: plane.usageStdout };
    },
  };
  return plane;
}

function answerList(plane: FakePlane, ...accounts: readonly unknown[]): void {
  plane.listStdout = JSON.stringify({
    schema: "sai.accounts/list/1",
    accounts,
    status: "ok",
  });
}

function shared(
  accountId: string,
  providerId: string,
  displayName: string,
  options: {
    locator?: string;
    backend?: string;
    state?: string;
    hidden?: boolean;
  } = {},
): Record<string, unknown> {
  const locator = options.locator ?? "";
  const backend = options.backend ?? "profile_directory";
  const providerMetadata: Record<string, unknown> = {};
  if (locator) providerMetadata.profile_locator = locator;
  return {
    account_id: accountId,
    provider_id: providerId,
    display_name: displayName,
    compact_label: displayName.slice(-2),
    execution_backend: backend,
    execution_context_id: "current-user",
    operational_state: options.state ?? "ENABLED",
    hidden: options.hidden ?? false,
    context_label: null,
    provider_metadata: providerMetadata,
  };
}

async function list(plane: FakePlane, providers = ZAICODE_ACCOUNT_PROVIDERS): Promise<readonly SharedAccount[]> {
  return listSharedAccounts(plane, providers);
}

// ── STANDALONE ─────────────────────────────────────────────────────────────

test("standalone: a machine with no plane resolves to no engine", () => {
  // installDir 是参数而不是常量：写死安装路径的函数在装了控制面的机器上无法被测试，
  // 断言会随开发机状态漂移。
  const dir = mkdtempSync(join(tmpdir(), "sai-standalone-"));
  const env: Record<string, string | undefined> = {
    [SAI_ACCOUNTS_EXE_ENV]: join(dir, "not-installed.exe"),
    PATH: dir,
  };
  assert.equal(resolveSaiAccountsEngine(env, "win32", join(dir, "not-here")), "");
});

test("standalone: the canonical install is found when it is there", () => {
  const dir = mkdtempSync(join(tmpdir(), "sai-canonical-"));
  writeFileSync(join(dir, "sai-accounts.exe"), "");
  assert.equal(resolveSaiAccountsEngine({ PATH: "" }, "win32", dir), join(dir, "sai-accounts.exe"));
});

test("standalone: an absent plane lists nothing and spawns nothing", async () => {
  const plane = fakePlane();
  plane.engine = "";
  assert.deepEqual(await list(plane), []);
  assert.deepEqual(plane.calls, []);
});

test("standalone: ZAICODE's own account providers are unaffected by a present plane", async () => {
  // 控制面在别的 provider 上有账号，但那不是 ZAICODE 的 provider。照单全收会让
  // ZAICODE 凭空多出它根本没有的 provider，这是比"看不到"更糟的答案。
  const plane = fakePlane();
  answerList(
    plane,
    shared("antigravity:windows-user:aaa", "antigravity", "Antigravity", { locator: "u1" }),
    shared("claude:profile-dir:bbb", "claude", "Claude 1", { locator: "C:\\x\\.claude" }),
  );
  assert.deepEqual(await list(plane), []);
});

test("standalone: a non-Windows platform has no plane to find", () => {
  const dir = mkdtempSync(join(tmpdir(), "sai-posix-"));
  const exe = join(dir, "sai-accounts.exe");
  writeFileSync(exe, "");
  assert.equal(resolveSaiAccountsEngine({ [SAI_ACCOUNTS_EXE_ENV]: exe }, "linux", dir), "");
});

test("standalone: an override that exists is used", () => {
  const dir = mkdtempSync(join(tmpdir(), "sai-override-"));
  const exe = join(dir, "sai-accounts.exe");
  writeFileSync(exe, "");
  assert.equal(resolveSaiAccountsEngine({ [SAI_ACCOUNTS_EXE_ENV]: exe }, "win32", dir), exe);
});

// ── broken plane ───────────────────────────────────────────────────────────

test("broken plane: a malformed reply is absorbed", async () => {
  const plane = fakePlane();
  plane.listStdout = "{ this is not json";
  assert.deepEqual(await list(plane), []);
});

test("broken plane: a wrongly typed reply is absorbed", async () => {
  const plane = fakePlane();
  plane.listStdout = '{"accounts": "not-an-array"}';
  assert.deepEqual(await list(plane), []);
});

test("broken plane: an erroring plane lists nothing rather than throwing", async () => {
  const plane = fakePlane();
  plane.listOk = false;
  assert.deepEqual(await list(plane), []);
});

test("broken plane: an entry without an id is skipped, not guessed at", async () => {
  const plane = fakePlane();
  answerList(plane, null, 42, { no: "id" }, shared("", ZAICODE_ACCOUNT_PROVIDERS[0]!, "X"));
  assert.deepEqual(await list(plane), []);
});

// ── FEDERATED ──────────────────────────────────────────────────────────────

test("federated: a shared account for a known provider appears", async () => {
  const plane = fakePlane();
  answerList(
    plane,
    shared("shared:aai-individual", ZAICODE_ACCOUNT_PROVIDERS[0]!, "Team Plan", { locator: "team" }),
  );
  const found = await list(plane);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.displayName, "Team Plan");
  assert.equal(found[0]!.accountId, "shared:aai-individual");
  assert.equal(found[0]!.locator, "team");
});

test("federated: the roster is matched case-insensitively", async () => {
  const plane = fakePlane();
  answerList(
    plane,
    shared("shared:x", ZAICODE_ACCOUNT_PROVIDERS[0]!.toUpperCase(), "X", { locator: "u" }),
  );
  assert.equal((await list(plane)).length, 1);
});

test("federated: hidden and non-enabled accounts leave the surface", async () => {
  const plane = fakePlane();
  answerList(
    plane,
    shared("shared:a", ZAICODE_ACCOUNT_PROVIDERS[0]!, "Keep", { locator: "u1" }),
    shared("shared:b", ZAICODE_ACCOUNT_PROVIDERS[0]!, "Hidden", { locator: "u2", hidden: true }),
    shared("shared:c", ZAICODE_ACCOUNT_PROVIDERS[0]!, "Frozen", { locator: "u3", state: "FROZEN" }),
    shared("shared:d", ZAICODE_ACCOUNT_PROVIDERS[0]!, "Archived", { locator: "u4", state: "ARCHIVED" }),
  );
  assert.deepEqual((await list(plane)).map((a) => a.displayName), ["Keep"]);
});

test("federated: a global hide cannot be undone by a local toggle", async () => {
  // 全局隐藏与本地启用是两根轴。本地开关可以关掉一条本地记录，但复活不了一条共享注册表
  // 已经下线的账号。
  const plane = fakePlane();
  answerList(plane, shared("shared:a", ZAICODE_ACCOUNT_PROVIDERS[0]!, "X", { locator: "u", hidden: true }));
  assert.deepEqual(await list(plane), []);
});

test("federated: a windows_user locator is read when there is no profile path", async () => {
  const plane = fakePlane();
  answerList(
    plane,
    {
      account_id: "shared:antigravity",
      provider_id: ZAICODE_ACCOUNT_PROVIDERS[0]!,
      display_name: "AG",
      execution_backend: "windows_user",
      operational_state: "ENABLED",
      hidden: false,
      provider_metadata: { windows_user: "someone" },
    },
  );
  assert.equal((await list(plane))[0]!.locator, "someone");
});

// ── DUPLICATE DISCOVERY ────────────────────────────────────────────────────

test("duplicate discovery: an empty locator never claims a key", () => {
  assert.equal(saiAccountsIdentityKey(ZAICODE_ACCOUNT_PROVIDERS[0]!, ""), "");
  assert.equal(saiAccountsIdentityKey("", "alice"), "");
  assert.equal(saiAccountsIdentityKey("   ", "alice"), "");
});

test("duplicate discovery: different providers never collide", () => {
  assert.notEqual(
    saiAccountsIdentityKey(ZAICODE_ACCOUNT_PROVIDERS[0]!, "alice"),
    saiAccountsIdentityKey(ZAICODE_ACCOUNT_PROVIDERS[1]!, "alice"),
  );
});

test("duplicate discovery: the same locator is the same key", () => {
  assert.equal(
    saiAccountsIdentityKey("claude", "Alice"),
    saiAccountsIdentityKey("claude", "alice"),
  );
});

test("duplicate discovery: a display name is never a key", async () => {
  // 同名的两个共享账号指向不同的身份，必须是两条。一个按显示名合并的合并层会把
  // 操作者的两个账号悄悄变成一个。
  const plane = fakePlane();
  answerList(
    plane,
    shared("shared:a", ZAICODE_ACCOUNT_PROVIDERS[0]!, "Team Plan", { locator: "alice" }),
    shared("shared:b", ZAICODE_ACCOUNT_PROVIDERS[0]!, "Team Plan", { locator: "bob" }),
  );
  const found = await list(plane);
  assert.equal(found.length, 2);
  assert.notEqual(
    saiAccountsIdentityKey(found[0]!.providerId, found[0]!.locator),
    saiAccountsIdentityKey(found[1]!.providerId, found[1]!.locator),
  );
});

test("duplicate discovery: the same account listed twice is still one row", async () => {
  const plane = fakePlane();
  const entry = shared("shared:a", ZAICODE_ACCOUNT_PROVIDERS[0]!, "X", { locator: "u" });
  answerList(plane, entry, entry);
  const seen = new Set((await list(plane)).map((a) => a.accountId));
  assert.equal(seen.size, 1);
});

// ── CENTRAL FAILURE ────────────────────────────────────────────────────────

test("central failure: an absent plane never reports numbers", async () => {
  const plane = fakePlane();
  plane.engine = "";
  const result = await probeSharedAccount(plane, "shared:a");
  assert.deepEqual(result.windows, []);
  assert.equal(result.state, "unavailable");
  assert.deepEqual(plane.calls, []);
});

test("central failure: an erroring plane is an outage, not a reading", async () => {
  const plane = fakePlane();
  plane.usageOk = false;
  plane.usageStdout = "";
  const result = await probeSharedAccount(plane, "shared:a");
  assert.equal(result.state, "unavailable");
  assert.equal(result.detail, "SAI Accounts did not answer");
});

test("central failure: plane windows become real windows", async () => {
  const plane = fakePlane();
  plane.usageStdout = JSON.stringify({
    account_id: "shared:a",
    context_state: "ONLINE",
    auth_state: "AUTHENTICATED",
    windows: [
      { pool_index: 0, window: "5h", remaining_fraction: 0.25, reset_time: "2026-10-03T10:00:00Z" },
      { pool_index: 0, window: "weekly", remaining_fraction: 0.5, reset_time: "2026-10-06T10:00:00Z" },
    ],
  });
  const result = await probeSharedAccount(plane, "shared:a");
  assert.equal(result.state, "ok");
  assert.deepEqual(result.windows.map((w) => w.kind), ["five_hour", "weekly"]);
  assert.equal(result.windows[0]!.remainingFraction, 0.25);
  assert.equal(result.windows[0]!.usedFraction, 0.75);
  assert.equal(result.windows[0]!.resetTime, "2026-10-03T10:00:00Z");
  assert.equal(result.detail, "");
});

test("central failure: a second pool gets its own window id", async () => {
  const plane = fakePlane();
  plane.usageStdout = JSON.stringify({
    context_state: "ONLINE",
    windows: [
      { pool_index: 0, window: "5h", remaining_fraction: 0.5 },
      { pool_index: 1, window: "5h", remaining_fraction: 0.1 },
    ],
  });
  const result = await probeSharedAccount(plane, "shared:a");
  assert.deepEqual(result.windows.map((w) => w.quotaBucket), ["0", "1"]);
});

test("central failure: an offline context is reported, not faked", async () => {
  const plane = fakePlane();
  plane.usageStdout = JSON.stringify({
    context_state: "OFFLINE",
    auth_state: "UNKNOWN",
    skipped_reason: "CONTEXT_OFFLINE",
  });
  const result = await probeSharedAccount(plane, "shared:a");
  assert.deepEqual(result.windows, []);
  assert.equal(result.state, "offline");
  assert.equal(result.detail, "CONTEXT_OFFLINE");
});

test("central failure: an auth refusal is typed, not unknown", async () => {
  const plane = fakePlane();
  plane.usageOk = false; // 控制面自己的约定：带类型的正文 + 非零退出码
  plane.usageStdout = JSON.stringify({
    context_state: "ONLINE",
    auth_state: "AUTH_REQUIRED",
    usage_status: "unreadable_usage",
  });
  const result = await probeSharedAccount(plane, "shared:a");
  assert.equal(result.state, "auth_required");
});

test("central failure: a provider the plane cannot read keeps no opinion", async () => {
  // 诚实的"我读不了这个 provider"不是故障，也不能被报成故障。
  const plane = fakePlane();
  plane.usageStdout = JSON.stringify({ skipped_reason: "provider_does_not_support_quota" });
  const result = await probeSharedAccount(plane, "shared:a");
  assert.equal(result.state, "unsupported");
  assert.equal(result.detail, "provider_does_not_support_quota");
});

test("central failure: an empty account id is never sent to the plane", async () => {
  const plane = fakePlane();
  const result = await probeSharedAccount(plane, "   ");
  assert.equal(result.state, "unavailable");
  assert.deepEqual(plane.calls, []);
});

test("central failure: recovery when the plane answers again", async () => {
  const plane = fakePlane();
  plane.usageOk = false;
  assert.equal((await probeSharedAccount(plane, "shared:a")).state, "unavailable");
  plane.usageOk = true;
  plane.usageStdout = JSON.stringify({
    context_state: "ONLINE",
    auth_state: "AUTHENTICATED",
    windows: [{ pool_index: 0, window: "5h", remaining_fraction: 1 }],
  });
  assert.equal((await probeSharedAccount(plane, "shared:a")).state, "ok");
});

test("central failure: the selector is the canonical id, never a display name", async () => {
  // 控制面也接受显示名作为 selector，而按显示名选账号正是整份设计拒绝的合并歧义。
  const plane = fakePlane();
  await probeSharedAccount(plane, "shared:aai-individual");
  assert.deepEqual(plane.calls, ["usage shared:aai-individual"]);
});

// ── window translation ─────────────────────────────────────────────────────

test("window translation: an out-of-range fraction is dropped, not clamped", () => {
  const windows = parseSharedUsageWindows({
    windows: [
      { pool_index: 0, window: "5h", remaining_fraction: 1.5 },
      { pool_index: 0, window: "5h", remaining_fraction: -0.1 },
      { pool_index: 0, window: "5h", remaining_fraction: "0.5" },
      { pool_index: 0, window: "", remaining_fraction: 0.5 },
      { pool_index: 0, window: "5h", remaining_fraction: 0.5 },
    ],
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.remainingFraction, 0.5);
});

test("window translation: 7d and weekly are the same window", () => {
  const windows = parseSharedUsageWindows({
    windows: [
      { pool_index: 0, window: "7d", remaining_fraction: 0.5 },
      { pool_index: 1, window: "weekly", remaining_fraction: 0.5 },
    ],
  });
  assert.deepEqual(windows.map((w) => w.kind), ["weekly", "weekly"]);
  assert.deepEqual(windows.map((w) => w.quotaBucket), ["0", "1"]);
});

test("window translation: a payload with no windows is not an error", () => {
  assert.deepEqual(parseSharedUsageWindows({}), []);
  assert.deepEqual(parseSharedUsageWindows({ windows: "no" }), []);
});

// ── read-only guarantee ────────────────────────────────────────────────────

test("read only: the module never writes, exports or opens a network", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    new URL("../src/sai-accounts-source.ts", import.meta.url),
    "utf8",
  );
  for (const forbidden of [
    "writeFile",
    "appendFile",
    "mkdir",
    "unlink",
    "rm(",
    "rmdir",
    "createWriteStream",
    "https://",
    "http://",
    "fetch(",
  ]) {
    assert.ok(!source.includes(forbidden), `${forbidden} must not appear`);
  }
});

test("read only: listing and probing are bounded", async () => {
  const plane = fakePlane();
  const seen: number[] = [];
  const spy: SaiAccountsHost = {
    enginePath: plane.enginePath,
    run: async (argv, timeoutMs) => {
      seen.push(timeoutMs);
      return plane.run(argv, timeoutMs);
    },
  };
  answerList(plane, shared("shared:a", ZAICODE_ACCOUNT_PROVIDERS[0]!, "X", { locator: "u" }));
  await listSharedAccounts(spy, ZAICODE_ACCOUNT_PROVIDERS);
  await probeSharedAccount(spy, "shared:a");
  assert.ok(seen.every((ms) => ms > 0 && ms <= 30_000), `unbounded timeouts: ${seen}`);
});
