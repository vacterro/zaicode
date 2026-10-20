import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  isZaicodeRouterEndpoint,
  zaicodeUsageRouterProviderIds,
  formatRecentTime,
  formatRecentAgo,
  readStoredRecentTimeFormat,
  writeStoredRecentTimeFormat,
  useZaicodeUsage,
} from "../src/zaicode/zaicodeUsage.js";
import type { ProviderSettingsView } from "@zcode/services";

const view = readFileSync(
  fileURLToPath(new URL("../src/zaicode/ZaicodeUsageView.tsx", import.meta.url)),
  "utf8",
);

test("Grouter endpoint matching: recognizes loopback aliases (localhost, 127.0.0.1, [::1]) and subscription paths", () => {
  const router = "http://127.0.0.1:20128";

  // Exact origin
  assert.equal(isZaicodeRouterEndpoint("http://127.0.0.1:20128", router), true);
  assert.equal(isZaicodeRouterEndpoint("http://127.0.0.1:20128/v1", router), true);

  // Loopback cross-alias (localhost -> 127.0.0.1)
  assert.equal(isZaicodeRouterEndpoint("http://localhost:20128", router), true);
  assert.equal(isZaicodeRouterEndpoint("http://localhost:20128/v1", router), true);

  // IPv6 loopback
  assert.equal(isZaicodeRouterEndpoint("http://[::1]:20128/v1", router), true);

  // Account subscription connections
  assert.equal(isZaicodeRouterEndpoint("http://127.0.0.1:20128/acct/sub_alpha/v1", router), true);
  assert.equal(isZaicodeRouterEndpoint("http://localhost:20128/acct/sub_beta/v1", router), true);

  // Rejections: mismatched ports, lookalike ports, external upstreams
  assert.equal(isZaicodeRouterEndpoint("http://localhost:20129/v1", router), false);
  assert.equal(isZaicodeRouterEndpoint("http://127.0.0.1:201280/v1", router), false);
  assert.equal(isZaicodeRouterEndpoint("https://open.bigmodel.cn/api/paas/v4", router), false);
  assert.equal(isZaicodeRouterEndpoint("https://api.openai.com/v1", router), false);
  assert.equal(isZaicodeRouterEndpoint("not-a-url", router), false);
});

test("Grouter provider ID resolution: attributes localhost:20128 providers while ignoring unmonitored routes", () => {
  const view: ProviderSettingsView = {
    providers: [
      {
        providerId: "new-provider",
        providerName: "SAI Route",
        effectiveConfig: { api: { baseUrl: "http://localhost:20128/v1" } },
      },
      {
        providerId: "new-provider-2",
        providerName: "SAI Route 2",
        effectiveConfig: { api: { baseUrl: "http://127.0.0.1:20128/acct/conn_1/v1" } },
      },
      {
        providerId: "zai-api",
        providerName: "Direct ZAI",
        effectiveConfig: { api: { baseUrl: "https://open.bigmodel.cn/api/paas/v4" } },
      },
      {
        providerId: "anthropic-direct",
        providerName: "Direct Anthropic",
        effectiveConfig: { api: { baseUrl: "https://api.anthropic.com/v1" } },
      },
      {
        providerId: "missing-url",
        providerName: "No Base URL",
        effectiveConfig: {},
      },
    ],
  };

  const ids = zaicodeUsageRouterProviderIds(view, "http://127.0.0.1:20128");
  assert.deepEqual(ids, ["new-provider", "new-provider-2"]);
});

test("Recent time formatting: formatRecentTime outputs deterministic 24h zero-padded HH:mm:ss", () => {
  const d = new Date(2026, 9, 12, 14, 5, 9); // 14:05:09
  assert.equal(formatRecentTime(d), "14:05:09");

  const iso = d.toISOString();
  assert.equal(formatRecentTime(iso), "14:05:09");

  const ms = d.getTime();
  assert.equal(formatRecentTime(ms), "14:05:09");

  assert.equal(formatRecentTime("invalid-date"), "—");
});

test("Recent elapsed formatting: formatRecentAgo formats relative durations (12s ago, 3m ago, 2h ago, 1d ago)", () => {
  const now = 1_700_000_000_000;

  // Under 60s
  assert.equal(formatRecentAgo(now - 12_000, now), "12s ago");
  assert.equal(formatRecentAgo(now - 1_000, now), "1s ago");
  assert.equal(formatRecentAgo(now, now), "0s ago");

  // Minutes (60s to <60m)
  assert.equal(formatRecentAgo(now - 180_000, now), "3m ago");
  assert.equal(formatRecentAgo(now - 59 * 60_000, now), "59m ago");

  // Hours (60m to <24h)
  assert.equal(formatRecentAgo(now - 2 * 3600_000, now), "2h ago");
  assert.equal(formatRecentAgo(now - 23 * 3600_000, now), "23h ago");

  // Days (24h+)
  assert.equal(formatRecentAgo(now - 24 * 3600_000, now), "1d ago");
  assert.equal(formatRecentAgo(now - 72 * 3600_000, now), "3d ago");

  // Invalid date
  assert.equal(formatRecentAgo("invalid", now), "—");
});

test("Recent time preference: persists preference in storage and updates Zustand store", () => {
  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };

  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: mockStorage,
  });

  try {
    writeStoredRecentTimeFormat("ago");
    assert.equal(readStoredRecentTimeFormat(), "ago");

    writeStoredRecentTimeFormat("time");
    assert.equal(readStoredRecentTimeFormat(), "time");

    // Zustand action updates state and writes storage
    useZaicodeUsage.getState().setRecentTimeFormat("ago");
    assert.equal(useZaicodeUsage.getState().recentTimeFormat, "ago");
    assert.equal(store.get("zaicode-usage-recent-time-format"), "ago");

    useZaicodeUsage.getState().setRecentTimeFormat("time");
    assert.equal(useZaicodeUsage.getState().recentTimeFormat, "time");
    assert.equal(store.get("zaicode-usage-recent-time-format"), "time");
  } finally {
    if (originalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalStorage);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  }
});

test("SRC-224 zero-request diagnosis: an empty period explains itself and offers the traffic that is there", () => {
  assert.match(view, /No requests in this period\./);
  // Why a working session can show zero: direct routes never touch 9router, and
  // local work (edits, shell, internal tool calls) is not a model API request.
  assert.match(view, /Direct provider routes bypass 9router\./);
  assert.match(view, /File edits, shell commands, and internal tool calls do not generate model API requests\./);
  // And the traffic that exists but is unattributed is reachable, not lost.
  assert.match(view, /Router traffic without session attribution is preserved in Global\./);
  assert.match(view, /Inspect Global traffic/);
  assert.match(view, /useZaicodeUsage\.setState\(\{ scope: "global" \}\)/);
  // Loading and never-loaded are distinct words, never the same empty row.
  assert.match(view, /Reading usage…/);
  assert.match(view, /Usage has not loaded\./);
});

test("SRC-224 Time/Ago toggle: both formats render from the stored preference", () => {
  assert.match(view, /aria-pressed=\{recentTimeFormat === "time"\}/);
  assert.match(view, /aria-pressed=\{recentTimeFormat === "ago"\}/);
  assert.match(view, /setRecentTimeFormat\("time"\)/);
  assert.match(view, /setRecentTimeFormat\("ago"\)/);
  assert.match(view, /recentTimeFormat === "time"\s*\?\s*formatRecentTime\(recentItem\.timestamp\)\s*:\s*formatRecentAgo\(recentItem\.timestamp\)/);
  // The choice is per-row cell content, not a label swap on one row.
  assert.equal(view.split("formatRecentAgo(").length - 1, 1);
});

test("SRC-224 I/O and cache indicators: each metric column names its direction", () => {
  assert.match(view, /<ArrowDown[^>]*aria-label="Input"/);
  assert.match(view, /<ArrowUp[^>]*aria-label="Output"/);
  assert.match(view, /<Database[^>]*aria-label="Cached"/);
  // The row cells carry the same three numbers, so a header is not decoration.
  assert.match(view, /\{number\(row\.input\)\}/);
  assert.match(view, /\{number\(row\.output\)\}/);
  assert.match(view, /\{number\(row\.cached\)\}/);
});

test("SRC-224 readability: metric cells and headers stay legible and explained", () => {
  // SRC-234 requests a larger interface font; tabular figures preserve numerical alignment.
  assert.match(view, /table-fixed text-left text-ui-base tabular-nums/);
  assert.doesNotMatch(view, /font-mono text-\[11px\]/);
  // Every metric header explains itself on hover, including the cached one.
  assert.match(view, /title="Input tokens sent to model"/);
  assert.match(view, /title="Output tokens generated by model"/);
  assert.match(view, /title="Cached tokens reused"/);
  // Long model names truncate instead of widening the table, and keep their full name.
  assert.match(view, /block truncate/);
  assert.match(view, /title=\{\s*tab === "recent"\s*\?\s*zaicodeUsageDisplayName\(row\.name, "models", labels\)/);
});
