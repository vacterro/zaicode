import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPoolGroups } from "../src/zaicode/zaicodeRoutingModel.js";
import { normalizeZaicodeEngineBarPrefs, zaicodeEngineBarModels } from "../src/zaicode/zaicodeEngineBarPrefs.js";
import { resolveZaicodeSubscriptionGroup } from "../src/zaicode/zaicodeSubscriptionSelection.js";
import type { ZaicodeSubscriptionAccount } from "@zcode/shared";

const groups = buildPoolGroups([
  { providerId: "router", providerName: "SAIRoute", enabled: true, models: ["SAIFREN", "SAIOPP"].map((modelId) => ({ modelId, selectable: true })) },
  { providerId: "account-a", providerName: "Custom name", enabled: true, models: [{ modelId: "model", selectable: true }, { modelId: "disabled", selectable: false }] },
  { providerId: "account-b", providerName: "Codex 2", enabled: true, models: [{ modelId: "model", selectable: true }] },
]);
const providerAccount = { "account-a": "a", "account-b": "b" };
const accounts: ZaicodeSubscriptionAccount[] = [
  { connectionId: "a", provider: "codex", label: "Codex 1", identity: "home", active: true },
  { connectionId: "b", provider: "codex", label: "Codex 2", identity: "work", active: true },
];

test("subscription models appear alongside pools and provider-qualified visibility survives duplicate model IDs", () => {
  assert.deepEqual(zaicodeEngineBarModels(groups, normalizeZaicodeEngineBarPrefs(null), providerAccount).map((m) => [m.providerId, m.modelId]), [["router", "SAIFREN"], ["router", "SAIOPP"], ["account-a", "model"], ["account-b", "model"]]);
  const prefs = normalizeZaicodeEngineBarPrefs({ modelButtons: [{ providerId: "account-b", modelId: "model" }, { providerId: "gone", modelId: "model" }] });
  assert.deepEqual(zaicodeEngineBarModels(groups, prefs, providerAccount).map((m) => m.providerId), ["account-b"]);
});

test("subscription selection keeps the intended account despite custom provider names and rejects ambiguous logins", () => {
  assert.equal(resolveZaicodeSubscriptionGroup({ vendor: "codex", label: "Codex 1" }, accounts, providerAccount, groups)?.providerId, "account-a");
  assert.equal(resolveZaicodeSubscriptionGroup({ vendor: "codex", label: "Unknown" }, accounts, providerAccount, groups), null);
  assert.equal(resolveZaicodeSubscriptionGroup({ vendor: "antigravity", label: "Antigravity" }, accounts, providerAccount, groups), null);
});

test("sidebar commands reach only the current workspace composer and retain the supported effort for new chats", async () => {
  const storage = new Map<string, string>();
  const windowMock = Object.assign(new EventTarget(), { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
  Object.defineProperty(globalThis, "window", { value: windowMock, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value: windowMock.localStorage, configurable: true });
  const { setZaicodeCurrentWorkspace, setZaicodeActiveEngine, readZaicodeActiveEngine } = await import("../src/zaicode/zaicodeEngines.js");
  const { requestZaicodeComposerModel, subscribeZaicodeComposerModel, resolveZaicodeDefaultSelection } = await import("../src/zaicode/zaicodeDefaultModel.js");
  const selected: unknown[] = [];
  let hidden = 0;
  const releaseHidden = subscribeZaicodeComposerModel("other", () => { hidden += 1; });
  const release = subscribeZaicodeComposerModel("project-id", (model) => selected.push(model));
  setZaicodeCurrentWorkspace("V:/project", "project-id");
  setZaicodeActiveEngine("old-cli");
  assert.equal(requestZaicodeComposerModel({ providerId: "account-a", modelId: "model", reasoningLevel: "high" }), true);
  assert.deepEqual(selected, [{ providerId: "account-a", modelId: "model", reasoningLevel: "high" }]);
  assert.equal(hidden, 0);
  assert.equal(readZaicodeActiveEngine(), null);
  const view = { providers: [{ providerId: "account-a", models: [{ modelId: "model", config: { optionSpecs: { reasoningLevel: { values: ["low", "medium", "high"] } } } }] }] } as never;
  assert.equal(resolveZaicodeDefaultSelection(view)?.options?.reasoningLevel, "high");
  release(); releaseHidden();
  assert.equal(requestZaicodeComposerModel({ providerId: "account-a", modelId: "model", reasoningLevel: "gone" }), false);
  assert.equal(resolveZaicodeDefaultSelection(view)?.options?.reasoningLevel, "medium");
});
