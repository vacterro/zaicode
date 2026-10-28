import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  closeProviderQuotaCircuit,
  describeProviderQuotaRoute,
  listProviderQuotaCircuits,
  openProviderQuotaCircuit,
  providerQuotaCircuit,
  resetProviderQuotaCircuits,
  resolveProviderQuotaRoute,
  PROVIDER_QUOTA_CIRCUIT_DEFAULT_MS,
} from "@zcode/shared";
import { pickZaicodeFallbackPool } from "@zcode/shared";

/**
 * SRC-116 TRACK B: an exhausted paid route must stop being the route.
 *
 * Operator report: GLM reached its limit; the selection was changed to SAIFREN; Retry still
 * attempted GLM. Two separate defects -- a replay that pinned the dead route, and no product
 * state that said the route was dead at all.
 */

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const glm = { providerId: "account:glm", modelId: "glm-5" };
const saifren = { providerId: "saifren", modelId: "SAIFREN" };

afterEach(() => resetProviderQuotaCircuits());

test("a proven exhaustion holds the route until the provider's own reset", () => {
  openProviderQuotaCircuit({ providerId: "account:glm", now: NOW, reason: "quota exhausted" });
  assert.equal(providerQuotaCircuit("account:glm", NOW + 60_000)?.until, NOW + PROVIDER_QUOTA_CIRCUIT_DEFAULT_MS);

  // A vendor reset further out wins over the default: a weekly plan is not a 15 minute outage.
  const weekly = NOW + 5 * 24 * 3_600_000;
  openProviderQuotaCircuit({ providerId: "account:glm", now: NOW, resetAt: weekly });
  const circuit = providerQuotaCircuit("account:glm", NOW);
  assert.equal(circuit?.until, weekly);
  assert.equal(circuit?.resetSource, "vendor");
  assert.equal(circuit?.failures, 2, "a second proven exhaustion counts");
});

test("an exhausted route is never hammered and falls back to the free pool", () => {
  openProviderQuotaCircuit({ providerId: glm.providerId, now: NOW });

  for (const attempt of [NOW + 1_000, NOW + 60_000, NOW + 5 * 60_000]) {
    const route = resolveProviderQuotaRoute({ requested: glm, fallback: saifren, now: attempt });
    assert.equal(route.selection.providerId, "saifren", `attempt at ${attempt}`);
    assert.equal(route.fallback, true);
  }
  assert.match(describeProviderQuotaRoute("GLM", resolveProviderQuotaRoute({ requested: glm, fallback: saifren, now: NOW })), /GLM unavailable until .*fallback pool/);
});

test("a healthy route is used as requested, with no fallback announced", () => {
  const route = resolveProviderQuotaRoute({ requested: saifren, fallback: null, now: NOW });
  assert.equal(route.selection.providerId, "saifren");
  assert.equal(route.circuit, null);
  assert.equal(describeProviderQuotaRoute("SAIFREN", route), "");
});

test("with no fallback pool available the requested route is kept and the error is the vendor's", () => {
  openProviderQuotaCircuit({ providerId: glm.providerId, now: NOW });
  const route = resolveProviderQuotaRoute({ requested: glm, fallback: null, now: NOW });
  assert.equal(route.selection.providerId, glm.providerId, "refusing the task would be worse");
  assert.equal(route.fallback, false);
  assert.match(describeProviderQuotaRoute("GLM", route), /^GLM unavailable until \d/);
});

test("recovery closes the circuit and the route comes back", () => {
  openProviderQuotaCircuit({ providerId: glm.providerId, now: NOW });
  assert.equal(closeProviderQuotaCircuit(glm.providerId, NOW + 60_000), true);
  assert.equal(providerQuotaCircuit(glm.providerId, NOW + 60_000), null);
  assert.equal(
    resolveProviderQuotaRoute({ requested: glm, fallback: saifren, now: NOW + 60_000 }).selection.providerId,
    glm.providerId,
  );
});

test("the circuit list is what a bug report exports", () => {
  openProviderQuotaCircuit({ providerId: glm.providerId, now: NOW, reason: "plan limit reached" });
  openProviderQuotaCircuit({ providerId: "account:codex", now: NOW + 1_000, resetAt: NOW + 3_600_000 });
  const open = listProviderQuotaCircuits(NOW + 2_000);
  assert.deepEqual(open.map((circuit) => circuit.providerId), ["account:codex", glm.providerId]);
  assert.equal(open[1]?.reason, "plan limit reached");
});

test("the fallback pool the resolver reaches for is the one the product already ships", () => {
  const providers = [
    { providerId: "other", providerName: "Other", models: [{ modelId: "x" }] },
    { providerId: "saifren-provider", providerName: "SAIRoute", models: [{ modelId: "SAIFREN" }] },
  ];
  assert.deepEqual(pickZaicodeFallbackPool(providers), { providerId: "saifren-provider", modelId: "SAIFREN" });
});