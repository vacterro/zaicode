// T-167 / SRC-116 TRACK B —— 手发回合也必须走同一个 quota circuit。
//
// 这一层要证明三件事：只有「已证实欠费」才开闸（B2）；提交时路由决定走的是派发器那一个
// resolver；改道时界面拿得到欠费到点时间，而不是只有队列日志里那一行。
import assert from "node:assert/strict";
import test from "node:test";

import {
  describeProviderQuotaRoute,
  listProviderQuotaCircuits,
  providerQuotaCircuit,
  resetProviderQuotaCircuits,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import { noteComposerQuotaExhaustion, routeComposerSelection } from "../src/zaicode/zaicodeQuotaRoute.js";

const NOW = 1_760_000_000_000;
/** Official GLM ids are account-based; a bare "glm" is just another provider to the picker. */
const GLM = "account:zai-start";
const GLM_MODEL = "glm-4";

function view(preferred?: { providerId: string; modelId: string }): ModelSelectionView {
  return {
    revision: 1,
    providers: [
      { providerId: GLM, models: [{ modelId: GLM_MODEL }] },
      { providerId: "saifren", models: [{ modelId: "saifren-fast" }] },
      { providerId: "sairoute", models: [{ modelId: "sairoute-pro" }] },
    ],
    ...(preferred ? { preferredSelection: preferred } : {}),
  } as unknown as ModelSelectionView;
}

test("T-167: an exhausted route moves the hand-sent turn and reports the hold", () => {
  resetProviderQuotaCircuits();
  assert.equal(noteComposerQuotaExhaustion({ providerId: GLM, kind: "daily-exhausted", now: NOW }), true);
  const routed = routeComposerSelection({ providerId: GLM, modelId: GLM_MODEL }, view(), NOW);
  assert.equal(routed.fallback, true);
  assert.equal(routed.selection.providerId, "saifren");
  assert.equal(routed.selection.modelId, "saifren-fast");
  assert.ok(routed.holdUntil, "the UI must be able to state when the hold ends");
  assert.ok(providerQuotaCircuit(GLM, NOW), "the circuit is what the resolver reads");
});

test("T-167: a route with no circuit is sent exactly as the operator chose it", () => {
  resetProviderQuotaCircuits();
  const requested = { providerId: "sairoute", modelId: "sairoute-pro" };
  const routed = routeComposerSelection(requested, view(), NOW);
  assert.equal(routed.fallback, false);
  assert.deepEqual(routed.selection, requested);
  assert.equal(routed.holdUntil, null);
});

test("T-167: B2 — only a proven exhausted plan opens the circuit", () => {
  resetProviderQuotaCircuits();
  for (const kind of ["model-very-low", "mcp-quota-exhausted", "mcp-plan-required", null, undefined]) {
    assert.equal(
      noteComposerQuotaExhaustion({ providerId: GLM, kind: kind as string | null, now: NOW }),
      false,
    );
  }
  assert.equal(noteComposerQuotaExhaustion({ providerId: null, kind: "daily-exhausted", now: NOW }), false);
  assert.deepEqual(listProviderQuotaCircuits(NOW), []);
  assert.equal(routed_stays_put(), true);
});

function routed_stays_put(): boolean {
  const routed = routeComposerSelection({ providerId: GLM, modelId: GLM_MODEL }, view(), NOW);
  return routed.fallback === false && routed.selection.providerId === GLM;
}

test("T-167: the fallback is never the route that is already dead", () => {
  resetProviderQuotaCircuits();
  noteComposerQuotaExhaustion({ providerId: "saifren", kind: "model-exhausted", now: NOW });
  const routed = routeComposerSelection({ providerId: "saifren", modelId: "saifren-fast" }, view(), NOW);
  assert.equal(routed.fallback, true);
  assert.equal(routed.selection.providerId, "sairoute");
});

test("T-167: only one route dies at a time — the fallback is not itself fenced", () => {
  resetProviderQuotaCircuits();
  noteComposerQuotaExhaustion({ providerId: GLM, kind: "daily-exhausted", now: NOW });
  const routed = routeComposerSelection(
    { providerId: GLM, modelId: GLM_MODEL },
    view({ providerId: "saifren", modelId: "saifren-fast" }),
    NOW,
  );
  assert.equal(routed.selection.providerId, "saifren");
});

test("T-167: the reasoning level travels only when the target model offers it", () => {
  resetProviderQuotaCircuits();
  const supported = view();
  (supported.providers[1]!.models[0] as { config: { optionSpecs: Record<string, unknown> } }).config = {
    optionSpecs: { reasoningLevel: { values: ["high"] } },
  };
  noteComposerQuotaExhaustion({ providerId: GLM, kind: "provider-limited", now: NOW });
  const carried = routeComposerSelection(
    { providerId: GLM, modelId: GLM_MODEL, options: { reasoningLevel: "high" } },
    supported,
    NOW,
  );
  assert.equal(carried.selection.options?.reasoningLevel, "high");

  const unsupported = view();
  noteComposerQuotaExhaustion({ providerId: GLM, kind: "provider-limited", now: NOW + 1 });
  const dropped = routeComposerSelection(
    { providerId: GLM, modelId: GLM_MODEL, options: { reasoningLevel: "max" } },
    unsupported,
    NOW + 1,
  );
  assert.equal(dropped.selection.options, undefined);
});

test("T-167: an estimated hold is never stated as a vendor reset", () => {
  resetProviderQuotaCircuits();
  noteComposerQuotaExhaustion({ providerId: GLM, kind: "daily-exhausted", now: NOW });
  const circuit = providerQuotaCircuit(GLM, NOW)!;
  assert.equal(circuit.resetSource, "estimated");
  const line = describeProviderQuotaRoute(GLM, { circuit, fallback: true }, NOW);
  assert.match(line, /estimated/, line);
  assert.match(line, /using the fallback pool/, line);
});
