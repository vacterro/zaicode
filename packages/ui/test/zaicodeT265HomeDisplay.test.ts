import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, test } from "node:test";
import { ZaicodeHomeActivity } from "../src/zaicode/home/ZaicodeHomeStatsCards.js";
import { ZaicodeAccountLimits } from "../src/zaicode/ZaicodeLimitViews.js";
import { dismissZaicodeFresh, markZaicodeFresh } from "../src/zaicode/zaicodeNotifications.js";
import type { ZaicodeEngineAccount, ZaicodeLimitSnapshot } from "@zcode/shared";

test("long Recent elapsed labels keep ago on the same line without clipping", () => {
  const now = Date.now();
  const html = renderToStaticMarkup(createElement(ZaicodeHomeActivity, {
    now,
    lines: [{ key: "old", at: now - 47 * 86400000 - 23 * 3600000,
      text: "Completed", detail: "", duration: null, bad: false }],
  }));
  const label = /<span class="([^"]*)">[^<]* ago<\/span>/.exec(html);
  assert.ok(label, "the actual Recent component renders its elapsed label");
  assert.match(label[1], /whitespace-nowrap/);
  assert.doesNotMatch(label[1], /(?:^|\s)w-\[64px\](?:\s|$)/,
    "the elapsed label must grow when 64px cannot fit its text");
});

const keys = ["window:test|five_hour", "window:test|weekly"];
afterEach(() => dismissZaicodeFresh(keys));
test("simultaneously fresh compact quota rows keep their outlines inside each row", () => {
  const now = Date.now();
  markZaicodeFresh(keys, 10, "reset", now);
  const account: ZaicodeEngineAccount = {
    id: "test", vendor: "codex", short: "C", label: "Codex", source: "test",
    home: null, isDefaultHome: true, cli: "codex", status: "ready",
    statusDetail: "", fixCommand: null,
  };
  const snapshot: ZaicodeLimitSnapshot = {
    accountId: "test", plan: null, fetchedAt: now, checkedAt: now, error: null, source: "test",
    windows: ["five_hour", "weekly"].map(key => ({
      key, label: key, group: "", groupLabel: "", remainingPercent: 100,
      resetsAt: now + 3600000, durationMinutes: key === "weekly" ? 10080 : 300,
      assumedFull: false, gatedBy: null,
    })),
  };
  const html = renderToStaticMarkup(createElement(ZaicodeAccountLimits, { account, snapshot, now, compact: true }));
  assert.equal((html.match(/data-zaicode-fresh="true"/g) ?? []).length, 2);
  assert.equal((html.match(/outline-offset:-1px/g) ?? []).length, 2,
    "touching rows must not paint an outline into their neighbor");
});
