import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isZaicodeRouterCallAllowed,
  normalizeZaicodeRouterConnections,
  normalizeZaicodeRouterModels,
  parseZaicodeSubscriptionPath,
  planZaicodeSubscriptionSync,
  zaicodeRoutedModelId,
  zaicodeSubscriptionAccounts,
  zaicodeSubscriptionBaseUrl,
  zaicodeSubscriptionConnectionOf,
  zaicodeSubscriptionModelSpecs,
  zaicodeSubscriptionReadiness,
} from "@zcode/shared";
import { modelConfigDataSchema } from "@zcode/shared/model-config";
import { decorateZaicodeAccountGroups } from "../src/zaicode/zaicodeSubscriptionSync.js";

// SRC-061: "Codex 1 / GPT 5.6 Sol -> effort", "Claude 2 / Opus 5.5 -> effort";
// new models picked up, old ones removed, readiness bars in the model menu.

const connections = normalizeZaicodeRouterConnections({
  connections: [
    { id: "cx-b", provider: "codex", authType: "oauth", name: "work", email: "work@x.io", createdAt: "2026-09-02T10:00:00Z", priority: 1 },
    { id: "cx-a", provider: "codex", authType: "oauth", name: "home", email: "home@x.io", createdAt: "2026-09-01T10:00:00Z", priority: 2 },
    { id: "ag-1", provider: "antigravity", authType: "oauth", name: "ag", createdAt: "2026-09-03T10:00:00Z" },
    { id: "key-1", provider: "openrouter", authType: "apikey", name: "or" },
    {
      id: "cc-1",
      provider: "claude",
      authType: "oauth",
      name: "me@y.io",
      isActive: false,
      modelLock___all: "2999-01-01T00:00:00Z",
    },
  ],
});

const models = normalizeZaicodeRouterModels({
  models: [
    { provider: "codex", routedModel: "cx/gpt-5.6-sol", name: "GPT 5.6 Sol", caps: { reasoning: true, contextWindow: 400000, maxOutput: 128000 } },
    { provider: "codex", routedModel: "cx/gpt-5.5-mini", name: "mini", caps: { reasoning: false, vision: true } },
    { provider: "claude", routedModel: "cc/claude-opus-5-5", name: "Opus 5.5", caps: { reasoning: true } },
    { provider: "antigravity", routedModel: "ag/gemini-3-pro", name: "Gemini", caps: { reasoning: true } },
  ],
});

test("accounts: one per OAuth connection, numbered per vendor in the order they were connected", () => {
  const accounts = zaicodeSubscriptionAccounts(connections);
  assert.deepEqual(
    accounts.map((account) => [account.label, account.connectionId, account.identity, account.active]),
    [
      ["Antigravity", "ag-1", "ag", true],
      ["Claude", "cc-1", "me@y.io", false],
      ["Codex 1", "cx-a", "home@x.io", true],
      ["Codex 2", "cx-b", "work@x.io", true],
    ],
  );
  // A priority change (the proxy moves accounts to the front) does not rename them.
  const swapped = connections.map((connection) => ({ ...connection, priority: connection.id === "cx-a" ? 1 : 2 }));
  assert.deepEqual(
    zaicodeSubscriptionAccounts(swapped).map((account) => account.label),
    accounts.map((account) => account.label),
  );
});

test("models: bare ids in the menu, the vendor's real efforts on thinking models, and ZCode accepts the config", () => {
  const specs = zaicodeSubscriptionModelSpecs("codex", models);
  assert.deepEqual(specs.map((spec) => [spec.modelId, spec.routedId]), [
    ["gpt-5.6-sol", "cx/gpt-5.6-sol"],
    ["gpt-5.5-mini", "cx/gpt-5.5-mini"],
  ]);
  assert.deepEqual(specs[0]!.config.optionSpecs?.reasoningLevel?.values, ["low", "medium", "high", "xhigh"]);
  assert.equal(specs[1]!.config.optionSpecs?.reasoningLevel, undefined, "a model that does not think gets no effort control");
  assert.deepEqual(zaicodeSubscriptionModelSpecs("claude", models)[0]!.config.optionSpecs?.reasoningLevel?.values, ["low", "medium", "high"]);
  for (const spec of [...specs, ...zaicodeSubscriptionModelSpecs("claude", models)]) {
    const parsed = modelConfigDataSchema.safeParse(spec.config);
    assert.ok(parsed.success, `${spec.modelId}: ${parsed.success ? "" : parsed.error.message}`);
  }
  assert.equal(zaicodeRoutedModelId("codex", "gpt-5.6-sol"), "cx/gpt-5.6-sol");
  assert.equal(zaicodeRoutedModelId("codex", "cx/gpt-5.6-sol"), "cx/gpt-5.6-sol");
  assert.equal(zaicodeRoutedModelId("node-1", "m1", "zt"), "zt/m1");
});

test("the account rides in the provider's address and comes back out of it", () => {
  const baseUrl = zaicodeSubscriptionBaseUrl("http://127.0.0.1:20190/", "cx a/1");
  assert.equal(baseUrl, "http://127.0.0.1:20190/acct/cx%20a%2F1/v1");
  assert.equal(zaicodeSubscriptionConnectionOf(baseUrl), "cx a/1");
  assert.equal(zaicodeSubscriptionConnectionOf("http://127.0.0.1:20128/v1"), null, "SAIRoute is not an account provider");
  assert.equal(zaicodeSubscriptionConnectionOf("https://api.example.com/acct/x/v1"), null, "only the local proxy");
  assert.deepEqual(parseZaicodeSubscriptionPath("/acct/cx-a/v1/chat/completions"), { connectionId: "cx-a", rest: "/v1/chat/completions" });
  assert.equal(parseZaicodeSubscriptionPath("/v1/chat/completions"), null);
  assert.equal(parseZaicodeSubscriptionPath("/acct/cx-a/api/providers"), null, "the proxy never reaches 9router's management API");
});

test("sync: new accounts come in, new models are added, retired ones leave, gone accounts are removed", () => {
  const accounts = zaicodeSubscriptionAccounts(connections);
  const proxyUrl = "http://127.0.0.1:20190";
  const first = planZaicodeSubscriptionSync({ accounts, models, proxyUrl, existing: [], apiKey: "t" });
  assert.deepEqual(
    first.create.map((entry) => [entry.account.label, entry.models.map((spec) => spec.modelId)]),
    [
      ["Antigravity", ["gemini-3-pro"]],
      ["Claude", ["claude-opus-5-5"]],
      ["Codex 1", ["gpt-5.6-sol", "gpt-5.5-mini"]],
      ["Codex 2", ["gpt-5.6-sol", "gpt-5.5-mini"]],
    ],
  );
  const existing = [
    // Codex 1 as it is now: one model 9router retired, one missing.
    { providerId: "p1", providerName: "Codex 1", baseUrl: zaicodeSubscriptionBaseUrl(proxyUrl, "cx-a"), apiKey: "t", modelIds: ["gpt-5.6-sol", "gpt-4-old"] },
    // An account that left 9router.
    { providerId: "p9", providerName: "Codex 3", baseUrl: zaicodeSubscriptionBaseUrl(proxyUrl, "cx-gone"), apiKey: "t", modelIds: ["gpt-5.6-sol"] },
    // Antigravity on an old proxy port.
    { providerId: "p3", providerName: "Antigravity", baseUrl: zaicodeSubscriptionBaseUrl("http://127.0.0.1:5555", "ag-1"), apiKey: "t", modelIds: ["gemini-3-pro"] },
    // The operator's own provider is none of this plan's business.
    { providerId: "sairoute", providerName: "SAIRoute", baseUrl: "http://127.0.0.1:20128/v1", apiKey: "k", modelIds: ["SAIFREN"] },
  ];
  const plan = planZaicodeSubscriptionSync({ accounts, models, proxyUrl, existing, apiKey: "t" });
  assert.deepEqual(plan.remove, ["p9"]);
  assert.deepEqual(plan.create.map((entry) => entry.account.label), ["Claude", "Codex 2"]);
  const codex1 = plan.update.find((entry) => entry.providerId === "p1")!;
  assert.deepEqual(codex1.add.map((spec) => spec.modelId), ["gpt-5.5-mini"]);
  assert.deepEqual(codex1.remove, ["gpt-4-old"]);
  assert.equal(codex1.overlay, null);
  const antigravity = plan.update.find((entry) => entry.providerId === "p3")!;
  assert.deepEqual(antigravity.overlay, { providerName: "Antigravity", baseUrl: zaicodeSubscriptionBaseUrl(proxyUrl, "ag-1") });
  // 9router answered with no models for a vendor: keep what is there, do not wipe it.
  const empty = planZaicodeSubscriptionSync({ accounts, models: [], proxyUrl, existing: existing.slice(0, 1), apiKey: "t" });
  assert.equal(empty.update.length, 0);
});

test("readiness: the tightest window, a resting account, a switched-off one, a vendor without numbers", () => {
  const account = { label: "Codex 1", identity: "home@x.io", active: true };
  const now = Date.parse("2026-09-27T12:00:00Z");
  const ready = zaicodeSubscriptionReadiness(
    account,
    { testStatus: "active", lockedUntil: null },
    { plan: "plus", quotas: { session: { used: 30, total: 100, remaining: 70, resetAt: "2026-09-27T14:00:00Z" }, weekly: { used: 85, total: 100, remaining: 15 } } },
    now,
  );
  assert.equal(ready.remaining, 15);
  assert.equal(ready.tone, "bad");
  assert.equal(ready.text, "15%");
  assert.match(ready.title, /5h 70%, week 15%/);
  const resting = zaicodeSubscriptionReadiness(account, { testStatus: null, lockedUntil: now + 60_000 }, null, now);
  assert.equal(resting.tone, "blocked");
  assert.match(resting.title, /next account of this vendor answers/);
  assert.equal(zaicodeSubscriptionReadiness({ ...account, active: false }, null, null, now).tone, "offline");
  assert.equal(zaicodeSubscriptionReadiness(account, { testStatus: "expired", lockedUntil: null }, null, now).text, "sign in");
  assert.equal(zaicodeSubscriptionReadiness(account, null, { message: "Usage API not implemented for x" }, now).tone, "unknown");
  assert.equal(
    zaicodeSubscriptionReadiness(account, null, { quotas: { "gemini-3-pro": { remainingPercentage: 40 } } }, now).text,
    "40%",
    "Antigravity reports per-model percentages",
  );
  // The lock the normalizer read from 9router's modelLock_ fields.
  assert.ok((connections.find((entry) => entry.id === "cc-1")?.lockedUntil ?? 0) > now);
});

test("the model menu: a bar on subscription accounts, nothing on other providers", () => {
  const groups = decorateZaicodeAccountGroups(
    [{ key: "registry-provider:p1", label: "Codex 1" }, { key: "registry-provider:sairoute", label: "SAIRoute" }],
    {
      providerAccount: { p1: "cx-a" },
      readiness: { "cx-a": { remaining: 64, tone: "good", text: "64%", title: "Codex 1 (home@x.io): 5h 64%" } },
    },
  );
  assert.deepEqual(groups[0], {
    key: "registry-provider:p1",
    label: "Codex 1",
    readiness: {
      percent: 64,
      tone: "good",
      color: "var(--color-success, #5b9630)",
      text: "64%",
      title: "Codex 1 (home@x.io): 5h 64%",
    },
  });
  assert.equal("readiness" in groups[1]!, false);
});

test("the renderer may read one account's quota, not the request logs beside it", () => {
  assert.equal(isZaicodeRouterCallAllowed({ method: "GET", path: "/api/usage/cx-a" }), true);
  for (const path of ["/api/usage/request-logs", "/api/usage/logs", "/api/usage/history", "/api/usage/stream", "/api/usage/request-details"]) {
    assert.equal(isZaicodeRouterCallAllowed({ method: "GET", path }), false, path);
  }
});
