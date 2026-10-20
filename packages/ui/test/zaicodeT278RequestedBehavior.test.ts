import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { parseAntigravityUsage, type ZaicodeEngineAccount } from "@zcode/shared";
import { ZaicodeAccountLimits } from "../src/zaicode/ZaicodeLimitViews.js";
import {
  zaicodeClickSoundFor,
  type ZaicodeSoundTarget,
} from "../src/zaicode/zaicodeSoundVoices.js";

test("Antigravity missing and invalid fractions remain unknown instead of invented 100%", () => {
  const windows = parseAntigravityUsage({
    command: {
      data: {
        groups: [
          {
            name: "Gemini",
            buckets: [
              { window: "5h", reset_time: "2027-01-01T00:00:00Z" },
              { window: "weekly", remaining_fraction: 1.5, reset_time: "2027-01-02T00:00:00Z" },
            ],
          },
        ],
      },
    },
  });
  assert.equal(windows.length, 2, "supported windows remain represented");
  assert.deepEqual(
    windows.map((window) => window.remainingPercent),
    [null, null],
  );
});

test("quota rows explain gating and elapsed resets without presenting inferred percentages", () => {
  const now = Date.now();
  const account: ZaicodeEngineAccount = {
    id: "ag",
    vendor: "antigravity",
    short: "AG",
    label: "Antigravity",
    source: "test",
    home: null,
    isDefaultHome: true,
    cli: "antigravity",
    status: "ready",
    statusDetail: "",
    fixCommand: null,
  };
  const windows = parseAntigravityUsage({
    command: {
      data: {
        groups: [
          {
            name: "Gemini",
            buckets: [
              {
                window: "5h",
                remaining_fraction: 1,
                reset_time: new Date(now + 3600000).toISOString(),
              },
              {
                window: "weekly",
                remaining_fraction: 0,
                reset_time: new Date(now + 86400000).toISOString(),
              },
            ],
          },
          {
            name: "Claude",
            buckets: [
              {
                window: "5h",
                remaining_fraction: 0.2,
                reset_time: new Date(now - 1000).toISOString(),
              },
            ],
          },
        ],
      },
    },
  });
  const html = renderToStaticMarkup(
    createElement(ZaicodeAccountLimits, {
      account,
      now,
      compact: true,
      snapshot: {
        accountId: "ag",
        windows,
        fetchedAt: now,
        checkedAt: now,
        plan: null,
        error: null,
        source: "test",
      },
    }),
  );
  assert.match(html, /blocked by Gemini weekly/);
  assert.equal(
    (html.match(/>--<\/span>/g) ?? []).length,
    2,
    "blocked 5h and clock-refilled 5h have an explanation instead of a measured percent",
  );
  assert.equal(
    (html.match(/>0%<\/span>/g) ?? []).length,
    1,
    "the genuine reported weekly zero remains visible",
  );
  assert.doesNotMatch(html, />100%<\/span>/);
});

test("synthetic download clicks stay silent while a native user link keeps its cue", () => {
  const link: ZaicodeSoundTarget = {
    closest: (selector) => (selector === "a[href]" ? link : null),
    getAttribute: () => null,
  };
  // 第三个参数是 DOM click 的 isTrusted；下载代码的 anchor.click() 为 false。
  const classify = zaicodeClickSoundFor as (
    target: ZaicodeSoundTarget,
    expanded: string | null,
    trusted: boolean,
  ) => string | null;
  assert.equal(classify(link, null, false), null);
  assert.equal(classify(link, null, true), "ui.link");
});
