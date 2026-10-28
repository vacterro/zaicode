// T-220 / SRC-151:R007 —— 共享账号系统必须接进引擎发现，且手动登录不能只认两家。
//
// 原文："ZAICODE должен поддерживать полноценную поддержку нового аккаунтной системы
// в real time ... Я вот зашёл во второй гугл аккаунт к примеру в SAITULS Accounts, а
// ZAICODE еще видимо старую имеет механику что путает. ... несколько аккаунтов одного
// вендора тока Codex и Claude вижу и всё, нужно в общем это решить грамотно."
//
// 病根是同一个：`sai-accounts-source.ts` 早就写完、导出、还有单测，却没有任何调用方。
// 所以 ZAICODE 只认本机的 ~/.claude-* 和 ~/.codex-*，控制面里新增的身份它一个也看不见。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  isZaicodeMetricsOnlyAccount,
  mergeZaicodeSharedAccounts,
  zaicodeSharedIdentityKey,
  zaicodeWindowFromShared,
  ZAICODE_ENGINES_DEFAULT_CONFIG,
  ZAICODE_ENGINE_VENDOR_LABELS,
  ZAICODE_MULTI_HOME_VENDORS,
  ZAICODE_VENDOR_HOME_PREFIXES,
  type ZaicodeEngineAccount,
  type ZaicodeSharedAccountInput,
} from "@zcode/shared";

const account = (partial: Partial<ZaicodeEngineAccount> & Pick<ZaicodeEngineAccount, "id" | "vendor" | "short" | "label" | "source">): ZaicodeEngineAccount => ({
  home: null,
  isDefaultHome: true,
  cli: null,
  status: "ready",
  statusDetail: "",
  fixCommand: null,
  ...partial,
});

const LOCAL: readonly ZaicodeEngineAccount[] = [
  account({
    id: "claude:c:\\users\\vac34\\.claude",
    vendor: "claude",
    short: "A1",
    label: "Claude 1",
    source: "~/.claude",
    home: "C:\\Users\\vac34\\.claude",
    cli: "claude.exe",
  }),
  account({
    id: "codex:c:\\users\\vac34\\.codex",
    vendor: "codex",
    short: "C1",
    label: "Codex 1",
    source: "~/.codex",
    home: "C:\\Users\\vac34\\.codex",
    cli: "codex.cmd",
  }),
  account({ id: "antigravity:default", vendor: "antigravity", short: "AG", label: "Antigravity", source: "gemini:antigravity", cli: "agy.exe" }),
];

const shared = (partial: Partial<ZaicodeSharedAccountInput> & Pick<ZaicodeSharedAccountInput, "accountId" | "providerId" | "locator">): ZaicodeSharedAccountInput => ({
  displayName: "",
  home: null,
  ...partial,
});

test("STANDALONE: 没有控制面时，本地列表一个字节都不变", () => {
  const merged = mergeZaicodeSharedAccounts(LOCAL, []);
  assert.deepEqual(merged, LOCAL.map((entry) => ({ ...entry })));
  assert.equal(merged.every((entry) => entry.shared === undefined), true);
});

test("合并键只认 provider + 定位符；空定位符永远不是键", () => {
  assert.equal(zaicodeSharedIdentityKey("Claude", "C:\\Users\\vac34\\.claude"), "claude|c:\\users\\vac34\\.claude");
  assert.equal(zaicodeSharedIdentityKey("claude", "   "), "");
  assert.equal(zaicodeSharedIdentityKey("", "C:\\Users\\vac34\\.claude"), "");
});

test("空定位符的共享记录被丢弃：它证明不了身份", () => {
  const merged = mergeZaicodeSharedAccounts(LOCAL, [
    shared({ accountId: "sai-1", providerId: "claude", locator: "" }),
  ]);
  assert.equal(merged.length, LOCAL.length);
});

test("HYBRID: 定位符命中已发现的 home 就是同一个账号，只有一行", () => {
  const merged = mergeZaicodeSharedAccounts(LOCAL, [
    shared({
      accountId: "sai-claude-1",
      providerId: "claude",
      displayName: "Work",
      // 斜杠写法也要认出同一个目录：控制面和本机路径分隔符不总是同一种。
      locator: "C:/Users/vac34/.claude",
      home: "C:\\Users\\vac34\\.claude",
    }),
  ]);
  assert.equal(merged.length, LOCAL.length, "不能因为共享注册表多出一个身份就多出一行");
  assert.equal(merged[0].shared?.accountId, "sai-claude-1");
  assert.equal(merged[1].shared, undefined);
  assert.equal(merged[0].label, "Claude 1", "本地展示不被控制面的显示名覆盖");
});

test("共享注册表多出的身份自己成行，用下一个空闲编号，并沿用同厂家的 CLI", () => {
  const merged = mergeZaicodeSharedAccounts(LOCAL, [
    shared({
      accountId: "sai-claude-2",
      providerId: "claude",
      displayName: "Personal",
      locator: "C:\\Users\\vac34\\.claude-account2",
      home: "C:\\Users\\vac34\\.claude-account2",
    }),
  ]);
  assert.equal(merged.length, LOCAL.length + 1);
  const row = merged[merged.length - 1]!;
  assert.equal(row.short, "A2", "不能和 A1 撞号——撞号会让两行看起来是一个账号");
  assert.equal(row.label, "Personal");
  assert.equal(row.cli, "claude.exe");
  assert.equal(row.home, "C:\\Users\\vac34\\.claude-account2");
  assert.equal(row.shared?.accountId, "sai-claude-2");
  assert.equal(isZaicodeMetricsOnlyAccount(row), false, "有本机 home 的 Claude 家账号是可以启动的");
});

test("控制面重复发同一条记录只算一次", () => {
  const entry = shared({ accountId: "sai-claude-2", providerId: "claude", locator: "C:\\Users\\vac34\\.claude-account2", home: "C:\\Users\\vac34\\.claude-account2" });
  const merged = mergeZaicodeSharedAccounts(LOCAL, [entry, { ...entry }]);
  assert.equal(merged.length, LOCAL.length + 1);
});

test("只认 ZAICODE 认识的 provider：控制面里的陌生厂牌不进引擎列表", () => {
  const merged = mergeZaicodeSharedAccounts(LOCAL, [
    shared({ accountId: "sai-x", providerId: "some-other-ide", locator: "C:\\Users\\vac34\\.x", home: "C:\\Users\\vac34\\.x" }),
  ]);
  assert.deepEqual(merged, LOCAL.map((entry) => ({ ...entry })));
});

test("SRC-161:REQ-001: 没有 home 的账号按它自己的非私密来源认身份，不再多出一行", () => {
  // Antigravity 的 home 是 null，它全部的非私密身份就是凭据目标名。以前合并只索引
  // home，控制面描述同一个安装的记录永远匹配不上，于是同一份订阅读成两行：
  // 通用的 "Antigravity" 和控制面自己的那一个。
  const identity = LOCAL[2]!;
  assert.equal(identity.home, null);
  const merged = mergeZaicodeSharedAccounts(LOCAL, [
    shared({ accountId: "sai-ag-1", providerId: "antigravity", displayName: "Antigravity", locator: identity.source, home: null }),
  ]);
  assert.equal(merged.length, LOCAL.length, "同一个身份只有一行");
  const row = merged[2]!;
  assert.equal(row.id, "antigravity:default", "留下来的是本机那一行");
  assert.equal(row.shared?.accountId, "sai-ag-1", "额度之后由控制面读");
  assert.equal(row.cli, "agy.exe", "本机的启动事实一个都没丢");
  assert.equal(isZaicodeMetricsOnlyAccount(row), false, "它仍然是本机那个可启动的安装");
  assert.equal(merged.some((entry) => entry.planeOnly === true), false, "没有任何一行是控制面凭空造的");
});

test("SRC-161:REQ-001: 来源不同就是不同身份，绝不会被折叠成一行", () => {
  // 同一个厂家、同一个显示名，靠身份分家：Claude 1 / Claude 2 与真正的第二个谷歌账号。
  const merged = mergeZaicodeSharedAccounts(LOCAL, [
    shared({ accountId: "sai-a2", providerId: "claude", displayName: "Claude 2", locator: "C:\\Users\\vac34\\.claude-account2", home: null }),
    shared({ accountId: "sai-ag-2", providerId: "antigravity", displayName: "Google account 2", locator: "vac34", home: null }),
  ]);
  assert.equal(merged.length, LOCAL.length + 2, "身份不同就有各自的行");
  assert.deepEqual(merged.map((entry) => entry.id).slice(0, LOCAL.length), LOCAL.map((entry) => entry.id), "本机三行原样保留");
  assert.equal(merged[0]!.label, "Claude 1", "共享的显示名不覆盖本机展示名");
  assert.equal(merged[2]!.label, "Antigravity", "本机 Antigravity 的展示名不受控制面影响");
});

test("只有一家 CLI 的厂家：第二行可见、可计量，但绝不冒充成可启动的 worker", () => {
  const merged = mergeZaicodeSharedAccounts(LOCAL, [
    shared({
      accountId: "sai-google-2",
      providerId: "antigravity",
      displayName: "Google account 2",
      locator: "C:\\Users\\vac34\\.antigravity2",
      home: "C:\\Users\\vac34\\.antigravity2",
    }),
  ]);
  assert.equal(merged.length, LOCAL.length + 1, "操作者在控制面里加的第二个谷歌账号必须看得见");
  const row = merged[merged.length - 1]!;
  assert.equal(row.vendor, "antigravity");
  assert.equal(row.home, null, "agy 只有一套本地登录，给它一个假 home 才是那个会骗人的旧机制");
  assert.equal(row.short, "AG");
  assert.equal(row.shared?.accountId, "sai-google-2");
  assert.equal(isZaicodeMetricsOnlyAccount(row), true);
  assert.equal(isZaicodeMetricsOnlyAccount(LOCAL[2]!), false, "本机的 Antigravity 仍然是可启动的");
});

test("windows_user 这种非路径定位符不会变成一个可以启动的目录", () => {
  const merged = mergeZaicodeSharedAccounts(LOCAL, [
    shared({ accountId: "sai-codex-9", providerId: "codex", displayName: "Vac", locator: "vac34", home: null }),
  ]);
  const row = merged[merged.length - 1]!;
  assert.equal(row.home, null);
  assert.equal(isZaicodeMetricsOnlyAccount(row), false);
  assert.ok(row.shared, "身份仍然可见、仍然通过控制面读额度");
});

test("控制面窗口 -> ZAICODE 窗口：比例换算、时间戳、分池", () => {
  const window = zaicodeWindowFromShared({
    kind: "five_hour",
    label: "5h",
    remainingFraction: 0.5,
    resetTime: "2026-10-06T09:00:00Z",
    quotaBucket: "1",
  });
  assert.equal(window.key, "five_hour@1");
  assert.equal(window.remainingPercent, 50);
  assert.equal(window.resetsAt, Date.parse("2026-10-06T09:00:00Z"));
  assert.equal(window.durationMinutes, 300);
  assert.equal(window.label, "Pool 2 5h", "SRC-162: a second pool is named, never a bare duplicate row");

  const broken = zaicodeWindowFromShared({ kind: "five_hour", label: "5h", remainingFraction: 0.5, resetTime: "not a date", quotaBucket: "0" });
  assert.equal(broken.resetsAt, null, "读不出的时间就是没有，不是猜一个");
  assert.equal(broken.key, "five_hour@0");
});

test("手动登录入口由厂家表生成，不再是写死的两家", () => {
  assert.deepEqual([...ZAICODE_MULTI_HOME_VENDORS], ["claude", "codex"]);
  assert.equal(ZAICODE_VENDOR_HOME_PREFIXES.claude, ".claude-account");
  assert.equal(ZAICODE_VENDOR_HOME_PREFIXES.codex, ".codex-account");
  assert.equal(ZAICODE_ENGINE_VENDOR_LABELS.claude, "Claude");

  const settings = readFileSync(
    join(import.meta.dirname, "..", "src", "settings", "ZaicodeEnginesSettings.tsx"),
    "utf8",
  );
  assert.match(settings, /ZAICODE_MULTI_HOME_VENDORS\.map\(/, "按钮必须遍历厂家表");
  assert.doesNotMatch(settings, /addAccount\("claude"\)|addAccount\("codex"\)/, "不能再有写死的那两家按钮");
  assert.doesNotMatch(settings, /vendor: "claude" \| "codex"/, "addAccount 的参数类型不能再钉死成两家");
});

test("发现与额度读取真的接上了：两处调用都不能再是死代码", () => {
  const main = readFileSync(
    join(import.meta.dirname, "..", "..", "desktop", "src", "main", "zaicodeEngines.ts"),
    "utf8",
  );
  assert.match(main, /mergeZaicodeSharedAccounts\(local, await discoverSharedAccounts\(\)\)/);
  assert.match(main, /listSharedAccounts\(nodeSaiAccountsHost, ZAICODE_ENGINE_VENDORS\)/);
  assert.match(main, /probeSharedAccount\(nodeSaiAccountsHost, shared\.accountId\)/);
  assert.match(main, /ZAICODE_VENDOR_HOME_PREFIXES\[/, "建家目录不能再是 vendor === 的三元");
  assert.doesNotMatch(main, /vendor === "claude" \? "\.claude-account"/);
});
test("E1: a second same-vendor plane account converges as exactly one distinct row, no restart", () => {
  const first = mergeZaicodeSharedAccounts(LOCAL, [
    shared({ accountId: "google-a", providerId: "antigravity", locator: "profile-a" }),
  ]);
  const second = mergeZaicodeSharedAccounts(LOCAL, [
    shared({ accountId: "google-a", providerId: "antigravity", locator: "profile-a" }),
    shared({ accountId: "google-b", providerId: "antigravity", locator: "profile-b" }),
  ]);
  assert.equal(second.length, first.length + 1, "exactly one corresponding account, no more");
  const added = second.filter((row) => !first.some((prev) => prev.id === row.id));
  assert.equal(added.length, 1);
  assert.equal(added[0]!.id, "antigravity:shared:google-b");
  const sameVendor = second.filter((row) => row.vendor === "antigravity");
  assert.ok(sameVendor.length >= 2, "two accounts of one vendor stay two rows");
  assert.equal(new Set(sameVendor.map((row) => row.id)).size, sameVendor.length, "rows remain distinct");
  for (const row of sameVendor.filter((row) => row.id.startsWith("antigravity:shared:"))) {
    assert.equal(row.status, "ready", "converged rows are usable, never ghosts");
  }
});

test("E1: removing the plane account converges without a usable stale duplicate", () => {
  const both = mergeZaicodeSharedAccounts(LOCAL, [
    shared({ accountId: "google-a", providerId: "antigravity", locator: "profile-a" }),
    shared({ accountId: "google-b", providerId: "antigravity", locator: "profile-b" }),
  ]);
  const after = mergeZaicodeSharedAccounts(LOCAL, [
    shared({ accountId: "google-a", providerId: "antigravity", locator: "profile-a" }),
  ]);
  assert.equal(after.length, both.length - 1);
  assert.ok(!after.some((row) => row.id === "antigravity:shared:google-b"), "no stale duplicate remains");
  assert.ok(after.some((row) => row.id === "antigravity:shared:google-a"), "the surviving account is untouched");
});

test("E1: row identity is stable across refreshes, so active work never jumps accounts", () => {
  const plane = [
    shared({ accountId: "google-a", providerId: "antigravity", locator: "profile-a" }),
    shared({ accountId: "google-b", providerId: "antigravity", locator: "profile-b" }),
  ];
  const before = mergeZaicodeSharedAccounts(LOCAL, plane);
  const after = mergeZaicodeSharedAccounts(LOCAL, plane);
  assert.deepEqual(
    after.map((row) => row.id),
    before.map((row) => row.id),
    "a refresh that changes nothing re-derives identical ids",
  );
});

test("E1: convergence is bounded polling, and on-demand refresh exists for the impatient path", () => {
  // Default cadence: a genuinely new plane account is visible after at most
  // intervalMinutes plus one sweep, with no restart. The on-demand IPC path
  // refreshZaicodeEngines(accountId?) converges immediately when invoked.
  assert.equal(
    ZAICODE_ENGINES_DEFAULT_CONFIG.intervalMinutes,
    5,
    "default sweep cadence stays 5 minutes unless the operator changes it",
  );
  const preload = readFileSync(
    new URL("../../desktop/src/preload/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(preload, /refreshZaicodeEngines: \(accountId\?: string\) =>/);
});

test("SRC-162: 本机 Antigravity 与控制面里同一 Windows 用户的记录合并成一行", () => {
  const local = LOCAL.map((entry) => (entry.vendor === "antigravity" ? { ...entry, osUser: "vac34" } : entry));
  const merged = mergeZaicodeSharedAccounts(local, [
    shared({ accountId: "antigravity:windows-user:1", providerId: "antigravity", displayName: "Antigravity 1", locator: "vac34" }),
    shared({ accountId: "antigravity:windows-user:2", providerId: "antigravity", displayName: "Antigravity 2", locator: "antigravity_b" }),
  ]);
  const ag = merged.filter((entry) => entry.vendor === "antigravity");
  assert.equal(ag.length, 2, "本机用户的那条并入本地行，托管用户的另起一行");
  assert.equal(ag[0]!.id, "antigravity:default");
  assert.equal(ag[0]!.shared?.accountId, "antigravity:windows-user:1");
  assert.equal(ag[1]!.shared?.accountId, "antigravity:windows-user:2");
});

test("SRC-162: 定位符只在同一厂家内识别账号", () => {
  const local = LOCAL.map((entry) => (entry.vendor === "antigravity" ? { ...entry, osUser: "vac34" } : entry));
  const merged = mergeZaicodeSharedAccounts(local, [
    shared({ accountId: "codex:windows-user:1", providerId: "codex", displayName: "Codex X", locator: "vac34" }),
  ]);
  assert.equal(merged.find((entry) => entry.vendor === "antigravity")!.shared, undefined, "Codex 记录不能并进 Antigravity 行");
  assert.equal(merged.length, LOCAL.length + 1);
});
