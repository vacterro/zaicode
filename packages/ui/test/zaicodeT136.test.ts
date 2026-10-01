import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  ZAICODE_WINDOW_START_COOLDOWN_MS,
  ZAICODE_WINDOW_START_RETRY_MS,
  normalizeZaicodeEnginesConfig,
  zaicodeShouldStartIdleWindow,
  type ZaicodeLimitSnapshot,
  type ZaicodeLimitWindow,
} from "@zcode/shared";
import { selectPendingWorkspaceTaskQueries } from "../src/hooks/workspaceTaskListRefreshSignatures.js";
import { resolveZaicodeComposerMode } from "../src/v4/composer/draftWorkspaceDefaults.js";
import { describeZaicodeWindowStart } from "../src/zaicode/ZaicodeLimitViews.js";
import { zaicodeGroupAsButtons, zaicodeToolbarModelButtons } from "../src/zaicode/zaicodeModelButtonsModel.js";

/**
 * T-136 (SRC-100): the project badge that waited for a click, full access by default, and 5h
 * windows that start themselves.
 */

type Globals = { __ZAICODE_PRODUCT_MODE__?: boolean };
const globals = globalThis as Globals;
let savedMode: boolean | undefined;
beforeEach(() => {
  savedMode = globals.__ZAICODE_PRODUCT_MODE__;
  globals.__ZAICODE_PRODUCT_MODE__ = true;
});
afterEach(() => {
  if (savedMode === undefined) delete globals.__ZAICODE_PRODUCT_MODE__;
  else globals.__ZAICODE_PRODUCT_MODE__ = savedMode;
});

test("a stale active project no longer starves the other projects' lists", () => {
  const configs = [
    { workspaceKey: "ACTIVE", queryKey: "q-active" },
    { workspaceKey: "AUDAPACK", queryKey: "q-audapack" },
    { workspaceKey: "FRESH", queryKey: "q-fresh" },
  ];
  // The active project runs a session: its list turns stale on every activity change.
  const results = {
    "q-active": { stale: true },
    "q-audapack": { stale: true },
    "q-fresh": { stale: false },
  };
  const picked = selectPendingWorkspaceTaskQueries(configs, results, "ACTIVE").map((c) => c.workspaceKey);
  assert.deepEqual(picked, ["ACTIVE", "AUDAPACK"]);
});

test("cold start still loads the active project alone first", () => {
  const configs = [
    { workspaceKey: "ACTIVE", queryKey: "q-active" },
    { workspaceKey: "OTHER", queryKey: "q-other" },
  ];
  const picked = selectPendingWorkspaceTaskQueries(configs, {}, "ACTIVE").map((c) => c.workspaceKey);
  assert.deepEqual(picked, ["ACTIVE"]);
  const later = selectPendingWorkspaceTaskQueries(configs, { "q-active": { stale: false } }, "ACTIVE");
  assert.deepEqual(
    later.map((c) => c.workspaceKey),
    ["OTHER"],
  );
});

test("ZAICODE shows and sends a build or edit session as full access; plan stays", () => {
  assert.equal(resolveZaicodeComposerMode("build"), "yolo");
  assert.equal(resolveZaicodeComposerMode("edit"), "yolo");
  assert.equal(resolveZaicodeComposerMode("yolo"), "yolo");
  assert.equal(resolveZaicodeComposerMode("plan"), "plan");
  assert.equal(resolveZaicodeComposerMode(undefined), undefined);
  globals.__ZAICODE_PRODUCT_MODE__ = false;
  assert.equal(resolveZaicodeComposerMode("build"), "build");
});

const NOW = 1_790_780_000_000;

function window(overrides: Partial<ZaicodeLimitWindow>): ZaicodeLimitWindow {
  return {
    key: "five_hour",
    label: "5h",
    group: "",
    groupLabel: "",
    remainingPercent: 100,
    resetsAt: NOW + 300 * 60_000,
    durationMinutes: 300,
    gatedBy: null,
    assumedFull: false,
    startsOnUse: true,
    ...overrides,
  };
}

function snapshot(windows: ZaicodeLimitWindow[], extra: Partial<ZaicodeLimitSnapshot> = {}): ZaicodeLimitSnapshot {
  return {
    accountId: "claude:a2",
    windows,
    plan: "subscription",
    fetchedAt: NOW,
    checkedAt: NOW,
    error: null,
    source: "claude -p /usage",
    ...extra,
  };
}

const claude = { id: "claude:a2", vendor: "claude" as const, status: "ready" as const };
const config = normalizeZaicodeEnginesConfig({});

test("keep windows rolling is on by default for all supported five-hour accounts", () => {
  assert.equal(config.keepWindowsRolling, true);
  assert.equal(
    zaicodeShouldStartIdleWindow({ account: claude, snapshot: snapshot([window({})]), config, now: NOW }),
    true,
  );
  assert.equal(
    zaicodeShouldStartIdleWindow({
      account: { ...claude, id: "codex:c1", vendor: "codex" },
      snapshot: snapshot([window({})]),
      config: { ...config, hiddenAccounts: [] },
      now: NOW,
    }),
    true,
  );
  for (const vendor of ["antigravity", "zcode"] as const) {
    assert.equal(
      zaicodeShouldStartIdleWindow({
        account: { ...claude, id: vendor, vendor },
        snapshot: snapshot([window({ key: "five_hour" })]),
        config,
        now: NOW,
      }),
      true,
      vendor,
    );
  }
});

test("a running, spent, gated, hidden, failing or unsupported window is left alone", () => {
  const cases: Array<[string, Parameters<typeof zaicodeShouldStartIdleWindow>[0]]> = [
    ["running", { account: claude, snapshot: snapshot([window({ startsOnUse: false })]), config, now: NOW }],
    ["spent", { account: claude, snapshot: snapshot([window({ remainingPercent: 0 })]), config, now: NOW }],
    ["gated", { account: claude, snapshot: snapshot([window({ gatedBy: "weekly" })]), config, now: NOW }],
    ["hidden", { account: claude, snapshot: snapshot([window({})]), config: { ...config, hiddenAccounts: ["claude:a2"] }, now: NOW }],
    ["read error", { account: claude, snapshot: snapshot([window({})], { error: "timed out" }), config, now: NOW }],
    ["login", { account: { ...claude, status: "login-required" }, snapshot: snapshot([window({})]), config, now: NOW }],
    ["untracked vendor", { account: { ...claude, vendor: "freebuff" }, snapshot: snapshot([window({})]), config, now: NOW }],
    ["off", { account: claude, snapshot: snapshot([window({})]), config: { ...config, keepWindowsRolling: false }, now: NOW }],
  ];
  for (const [name, params] of cases) assert.equal(zaicodeShouldStartIdleWindow(params), false, name);
});

test("a start is not repeated inside its cooldown, a refused one waits an hour", () => {
  const started = snapshot([window({})], { windowStart: { at: NOW, ok: true, detail: "ok" } });
  assert.equal(zaicodeShouldStartIdleWindow({ account: claude, snapshot: started, config, now: NOW + 60_000 }), false);
  assert.equal(
    zaicodeShouldStartIdleWindow({ account: claude, snapshot: started, config, now: NOW + ZAICODE_WINDOW_START_COOLDOWN_MS }),
    true,
  );
  const refused = snapshot([window({})], { windowStart: { at: NOW, ok: false, detail: "rate limited" } });
  assert.equal(
    zaicodeShouldStartIdleWindow({ account: claude, snapshot: refused, config, now: NOW + ZAICODE_WINDOW_START_COOLDOWN_MS }),
    false,
  );
  assert.equal(
    zaicodeShouldStartIdleWindow({ account: claude, snapshot: refused, config, now: NOW + ZAICODE_WINDOW_START_RETRY_MS }),
    true,
  );
});

test("the limits panel says who started the window", () => {
  assert.match(describeZaicodeWindowStart({ at: NOW - 12 * 60_000, ok: true, detail: "x" }, NOW), /^window started by ZAICODE 12m? ago|^window started by ZAICODE/);
  assert.match(describeZaicodeWindowStart({ at: NOW, ok: false, detail: "not logged in" }, NOW), /failed .*not logged in/);
});

const group = (key: string, names: string[], connections = 0) => ({
  key,
  label: key,
  items: names.map((name) => ({ key: `${key}:${name}`, value: `${key}/${name}`, name })),
  ...(connections
    ? {
        connectionOptions: Array.from({ length: connections }, (_, index) => ({
          key: `c${index}`,
          label: `c${index}`,
          value: `c${index}`,
          providerId: key,
          familyId: key,
          mode: "oauth" as const,
        })),
      }
    : {}),
});

test("a few models become toolbar buttons; many keep the dropdown", () => {
  const few = zaicodeToolbarModelButtons([group("SAIRoute", ["SAIFREN", "SAIOPP"]), group("Z.ai", ["GLM-5.3"])]);
  assert.deepEqual(
    few?.map((button) => button.label),
    ["SAIFREN", "SAIOPP", "GLM-5.3"],
  );
  assert.equal(few?.[0]?.title, "SAIRoute · SAIFREN");
  const many = zaicodeToolbarModelButtons([
    group("SAIRoute", ["SAIFREN", "SAIOPP"]),
    group("Z.ai", ["GLM-5.3", "GLM-5.2", "GLM-5.1", "GLM-5-air", "GLM-4.7"]),
  ]);
  assert.equal(many, null);
  assert.equal(zaicodeToolbarModelButtons([group("Codex", ["gpt"], 2)]), null);
  globals.__ZAICODE_PRODUCT_MODE__ = false;
  assert.equal(zaicodeToolbarModelButtons([group("SAIRoute", ["SAIFREN"])]), null);
});

test("inside the dropdown a small provider shows buttons, a big one keeps its submenu", () => {
  assert.equal(zaicodeGroupAsButtons(group("SAIRoute", ["SAIFREN", "SAIOPP"])), true);
  assert.equal(zaicodeGroupAsButtons(group("Z.ai", ["a", "b", "c", "d", "e"])), false);
  assert.equal(zaicodeGroupAsButtons(group("Codex", ["gpt"], 2)), false);
  assert.equal(zaicodeGroupAsButtons(group("Empty", [])), false);
});
