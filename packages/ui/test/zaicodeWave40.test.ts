import assert from "node:assert/strict";
import test from "node:test";
import { zaicodeRouterAliasOf, zaicodeSubscriptionModels, type ZaicodeRouterConnection, type ZaicodeRouterModel } from "@zcode/shared";
import { findZaicodeRouterProvider } from "../src/zaicode/zaicodeRoutingModel.js";

function connection(partial: Partial<ZaicodeRouterConnection> & { id: string; provider: string }): ZaicodeRouterConnection {
  return { name: partial.provider, authType: "oauth", isActive: true, priority: null, testStatus: null, lastError: null, baseUrl: null, prefix: null, ...partial };
}
function model(id: string, provider: string): ZaicodeRouterModel {
  return { id, provider, name: id, vision: false, contextWindow: null, maxOutput: null };
}

test("subscription models: OAuth connections only, matched through 9router's short alias", () => {
  const groups = zaicodeSubscriptionModels(
    [
      connection({ id: "1", provider: "codex", name: "OpenAI Codex" }),
      connection({ id: "2", provider: "codex", name: "OpenAI Codex", isActive: false }),
      connection({ id: "3", provider: "antigravity", name: "Antigravity", isActive: false }),
      connection({ id: "4", provider: "openai-compatible-chat-x", name: "AMD", authType: "apikey" }),
    ],
    [model("cx/gpt-5.5", "cx"), model("cx/gpt-5.4-mini", "cx"), model("ag/gemini-3-pro", "ag"), model("amd/x", "amd")],
  );
  assert.deepEqual(
    groups.map((group) => [group.label, group.active, group.models.map((item) => item.id)]),
    [
      ["Antigravity", false, ["ag/gemini-3-pro"]],
      ["OpenAI Codex", true, ["cx/gpt-5.5", "cx/gpt-5.4-mini"]],
    ],
  );
  assert.equal(zaicodeRouterAliasOf("claude"), "cc");
  assert.equal(zaicodeRouterAliasOf("something-new"), "something-new");
});

test("the ZAICODE provider fronting 9router is found by port first, then by name", () => {
  const providers = [
    { providerId: "builtin:zai", providerName: "Z.ai", config: { api: { baseUrl: "https://api.z.ai/v1" } } },
    { providerId: "new-provider", providerName: "SAIRoute", config: { api: { baseUrl: "http://localhost:20128/v1" } } },
  ];
  assert.equal(findZaicodeRouterProvider(providers, "http://127.0.0.1:20128")?.providerId, "new-provider");
  const renamed = [{ providerId: "p1", providerName: "My pools", config: { api: { baseUrl: "http://127.0.0.1:20128/v1" } } }];
  assert.equal(findZaicodeRouterProvider(renamed, "http://127.0.0.1:20128")?.providerId, "p1");
  const byName = [{ providerId: "p2", providerName: "SAIRoute", config: { api: { baseUrl: "http://10.0.0.5:9999/v1" } } }];
  assert.equal(findZaicodeRouterProvider(byName, "http://127.0.0.1:20128")?.providerId, "p2");
  assert.equal(findZaicodeRouterProvider([providers[0]!], "http://127.0.0.1:20128"), null);
  // 201280 is not port 20128.
  const lookalike = [{ providerId: "p3", providerName: "Other", config: { api: { baseUrl: "http://localhost:201280/v1" } } }];
  assert.equal(findZaicodeRouterProvider(lookalike, "http://127.0.0.1:20128"), null);
});
