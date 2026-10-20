import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyRouteFailure,
  calculateRouteCooldown,
  getRouteHealth,
  recordRouteFailure,
  recordRouteSuccess,
  permitHalfOpenProbe,
  quarantineRoute,
  restoreRoute,
  listQuarantinedRoutes,
  resetAllRouteHealth,
  selectNextEligibleComboModel,
  generateRouterDiagnosticReceipt,
  setGlobalRouterDown,
  isGlobalRouterDown,
  setRouterFailureMode,
  serializeRouteHealthSnapshot,
  restoreRouteHealthSnapshot,
} from "../src/zaicode-router-circuit-breaker.js";

test("01 & 02: HTTP 400, 401, 403, 404, 408, 429, 500, 502, 503, 504 and unknown error classification", () => {
  assert.equal(classifyRouteFailure({ statusCode: 400 }), "CONFIGURATION_FAILURE");
  assert.equal(classifyRouteFailure({ statusCode: 401 }), "CONFIGURATION_FAILURE");
  assert.equal(classifyRouteFailure({ statusCode: 403 }), "CONFIGURATION_FAILURE");
  assert.equal(classifyRouteFailure({ statusCode: 404 }), "PERMANENT_MODEL_FAILURE");
  assert.equal(classifyRouteFailure({ statusCode: 408 }), "TRANSIENT");
  assert.equal(classifyRouteFailure({ statusCode: 429 }), "RATE_LIMITED");
  assert.equal(classifyRouteFailure({ statusCode: 500 }), "UNKNOWN");
  assert.equal(classifyRouteFailure({ statusCode: 502 }), "TRANSIENT");
  assert.equal(classifyRouteFailure({ statusCode: 503 }), "TRANSIENT");
  assert.equal(classifyRouteFailure({ statusCode: 504 }), "TRANSIENT");
  assert.equal(classifyRouteFailure({ providerCode: "gateway_timeout" }), "TRANSIENT");
  assert.equal(classifyRouteFailure({ providerCode: "unrecognized_error_code" }), "UNKNOWN");
  assert.equal(classifyRouteFailure({}), "UNKNOWN");
});

test("03 & 04: upstream ID is preserved when supplied, otherwise UPSTREAM_IDENTITY_UNAVAILABLE", () => {
  const receiptWithId = generateRouterDiagnosticReceipt({
    comboId: "saifren",
    attemptedModelId: "openai/gpt-4o",
    upstreamProvider: "openrouter",
    statusCode: 504,
    providerErrorCode: "gateway_timeout",
    decision: "Temporary cooldown",
    nextAction: "failover",
  });
  assert.equal(receiptWithId.attemptedRoute.modelId, "openai/gpt-4o");
  assert.equal(receiptWithId.attemptedRoute.upstreamProvider, "openrouter");

  const receiptWithoutId = generateRouterDiagnosticReceipt({
    comboId: "saifren",
    statusCode: 504,
    providerErrorCode: "gateway_timeout",
    decision: "Temporary cooldown",
    nextAction: "failover",
  });
  assert.equal(receiptWithoutId.attemptedRoute.modelId, "UPSTREAM_IDENTITY_UNAVAILABLE");
  assert.equal(receiptWithoutId.attemptedRoute.upstreamProvider, "UPSTREAM_IDENTITY_UNAVAILABLE");
});

test("05, 06, 07, 08: one failing route triggers bounded cooldown; next candidate is selected without poisoning combo", () => {
  resetAllRouteHealth();
  const now = 1000000;
  const combo = ["model-A", "model-B", "model-C"];

  // Initially, all unknown
  const init = selectNextEligibleComboModel({
    models: combo,
    comboId: "saifren",
    now,
  });
  assert.equal(init.selectedModelId, "model-A");

  // model-A fails with gateway_timeout
  const failA = recordRouteFailure(
    { comboId: "saifren", modelId: "model-A" },
    { providerCode: "gateway_timeout" },
    now,
  );
  assert.equal(failA.state, "COOLDOWN");
  assert.equal(failA.consecutiveFailures, 1);
  assert.ok(failA.cooldownUntil! > now);

  // model-B is healthy (tested and succeeded earlier)
  recordRouteSuccess({ comboId: "saifren", modelId: "model-B" }, now);

  // Selecting next candidate: skips model-A (in cooldown), selects healthy model-B
  const next = selectNextEligibleComboModel({
    models: combo,
    comboId: "saifren",
    currentModelId: "model-A",
    now,
  });
  assert.equal(next.selectedModelId, "model-B");
  assert.equal(next.state, "HEALTHY");

  // Verify model-C was not penalized
  const healthC = getRouteHealth({ comboId: "saifren", modelId: "model-C" }, now);
  assert.equal(healthC.state, "UNKNOWN");
  assert.equal(healthC.consecutiveFailures, 0);
});

test("09: router-wide outage does NOT blacklist or quarantine individual models", () => {
  resetAllRouteHealth();
  const now = 2000000;
  const route = { comboId: "saifren", modelId: "model-X" };

  // Router itself is down (e.g. connection refused)
  const result = recordRouteFailure(
    route,
    { code: "ECONNREFUSED", isRouterDown: true },
    now,
  );
  assert.equal(result.lastFailureClass, "GLOBAL_ROUTER_FAILURE");
  assert.equal(result.state, "UNKNOWN"); // Individual model state is not penalized!
  assert.equal(result.consecutiveFailures, 0);
  assert.equal(isGlobalRouterDown(), true);
});

test("10: Retry-After is respected over local estimates", () => {
  const estimated = calculateRouteCooldown(1);
  assert.ok(estimated >= 25000 && estimated <= 35000); // around 30s

  const withRetryAfter = calculateRouteCooldown(1, 45000);
  assert.equal(withRetryAfter, 45000);
});

test("11 & 12: half-open recovery is bounded and successful probe restores HEALTHY", () => {
  resetAllRouteHealth();
  const now = 3000000;
  const route = { comboId: "saifren", modelId: "model-probe" };

  recordRouteFailure(route, { providerCode: "gateway_timeout" }, now);
  const health1 = getRouteHealth(route, now);
  assert.equal(health1.state, "COOLDOWN");

  // Advance time past cooldown
  const future = now + 40000;
  const health2 = getRouteHealth(route, future);
  assert.equal(health2.state, "HALF_OPEN");

  // Permit probe
  assert.equal(permitHalfOpenProbe(route), true);
  // Second concurrent probe is refused
  assert.equal(permitHalfOpenProbe(route), false);

  // Probe succeeds
  recordRouteSuccess(route, future + 1000);
  const health3 = getRouteHealth(route, future + 1000);
  assert.equal(health3.state, "HEALTHY");
  assert.equal(health3.consecutiveFailures, 0);
});

test("13, 14, 15: repeated timeout does not cause permanent deletion, but confirmed permanent rejection is quarantined", () => {
  resetAllRouteHealth();
  let now = 4000000;
  const route = { comboId: "saifren", modelId: "model-timeout" };

  // Simulate 10 consecutive transient timeouts
  for (let i = 0; i < 10; i++) {
    recordRouteFailure(route, { providerCode: "gateway_timeout" }, now);
    now += 50000;
  }
  const timeoutHealth = getRouteHealth(route, now);
  // Must STILL be in COOLDOWN, NOT permanently quarantined or deleted!
  assert.equal(timeoutHealth.state, "COOLDOWN");
  assert.equal(timeoutHealth.quarantineReason, undefined);

  // Confirmed 404 permanent model rejection
  const permRoute = { comboId: "saifren", modelId: "model-retired" };
  const permHealth = recordRouteFailure(permRoute, { statusCode: 404, code: "model_not_found" }, now);
  assert.equal(permHealth.state, "QUARANTINED");
  assert.ok(permHealth.quarantineReason);
});

test("16: manual quarantine and restoration (Undo)", () => {
  resetAllRouteHealth();
  const route = { comboId: "saifren", modelId: "model-manual" };
  quarantineRoute(route, "Operator manual exclusion");
  assert.equal(getRouteHealth(route).state, "QUARANTINED");
  assert.equal(listQuarantinedRoutes("saifren").length, 1);

  // Restore
  restoreRoute(route);
  assert.equal(getRouteHealth(route).state, "UNKNOWN");
  assert.equal(listQuarantinedRoutes("saifren").length, 0);
});

test("17: when all models in combo are in cooldown, selection returns explicit waiting state", () => {
  resetAllRouteHealth();
  const now = 5000000;
  const combo = ["m1", "m2"];

  recordRouteFailure({ comboId: "saifren", modelId: "m1" }, { providerCode: "gateway_timeout" }, now);
  recordRouteFailure({ comboId: "saifren", modelId: "m2" }, { providerCode: "gateway_timeout" }, now);

  const result = selectNextEligibleComboModel({
    models: combo,
    comboId: "saifren",
    now,
  });

  assert.equal(result.selectedModelId, null);
  assert.equal(result.allInCooldown, true);
  assert.ok(result.earliestProbeAt! > now);
});

test("18: concurrent half-open probe contention ensures atomic admission without collision", () => {
  resetAllRouteHealth();
  const now = 6000000;
  const combo = ["probe-1", "probe-2"];

  // Put both into cooldown
  recordRouteFailure({ comboId: "saifren", modelId: "probe-1" }, { providerCode: "gateway_timeout" }, now);
  recordRouteFailure({ comboId: "saifren", modelId: "probe-2" }, { providerCode: "gateway_timeout" }, now);

  // Advance time past cooldown so both become HALF_OPEN
  const future = now + 60000;
  assert.equal(getRouteHealth({ comboId: "saifren", modelId: "probe-1" }, future).state, "HALF_OPEN");
  assert.equal(getRouteHealth({ comboId: "saifren", modelId: "probe-2" }, future).state, "HALF_OPEN");

  // First contender selects probe-1 and acquires the probe permit
  const contender1 = selectNextEligibleComboModel({
    models: combo,
    comboId: "saifren",
    now: future,
  });
  assert.equal(contender1.selectedModelId, "probe-1");
  assert.equal(contender1.state, "HALF_OPEN");

  // Second contender runs concurrently: probe-1 is in-flight, so it atomically admits probe-2 instead
  const contender2 = selectNextEligibleComboModel({
    models: combo,
    comboId: "saifren",
    now: future,
  });
  assert.equal(contender2.selectedModelId, "probe-2");
  assert.equal(contender2.state, "HALF_OPEN");

  // Third contender runs concurrently: both probe-1 and probe-2 have probes in flight, so it gets null / wait
  const contender3 = selectNextEligibleComboModel({
    models: combo,
    comboId: "saifren",
    now: future,
  });
  assert.equal(contender3.selectedModelId, null);
  assert.equal(contender3.allInCooldown, true);
});

test("19: durable route health snapshot serializes and restores faithfully across restarts", () => {
  resetAllRouteHealth();
  const now = 7000000;

  // Setup multiple routes with diverse states
  recordRouteSuccess({ comboId: "saifren", modelId: "gpt-4o" }, now);
  recordRouteFailure({ comboId: "saifren", modelId: "claude-sonnet" }, { providerCode: "gateway_timeout" }, now);
  quarantineRoute({ comboId: "saifren", modelId: "retired-v1" }, "Permanent 404 retired");
  setGlobalRouterDown(true);
  setRouterFailureMode("local_exclusion");

  // Take snapshot
  const snapshot = serializeRouteHealthSnapshot();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.globalRouterDown, true);
  assert.equal(snapshot.routerFailureMode, "local_exclusion");
  assert.equal(snapshot.records.length, 3);

  // Clear all in-memory state
  resetAllRouteHealth();
  assert.equal(getRouteHealth({ comboId: "saifren", modelId: "gpt-4o" }, now).state, "UNKNOWN");
  assert.equal(getRouteHealth({ comboId: "saifren", modelId: "retired-v1" }, now).state, "UNKNOWN");
  assert.equal(isGlobalRouterDown(), false);

  // Restore snapshot
  restoreRouteHealthSnapshot(snapshot, now);
  assert.equal(getRouteHealth({ comboId: "saifren", modelId: "gpt-4o" }, now).state, "HEALTHY");
  assert.equal(getRouteHealth({ comboId: "saifren", modelId: "claude-sonnet" }, now).state, "COOLDOWN");
  assert.equal(getRouteHealth({ comboId: "saifren", modelId: "retired-v1" }, now).state, "QUARANTINED");
  assert.equal(getRouteHealth({ comboId: "saifren", modelId: "retired-v1" }, now).quarantineReason, "Permanent 404 retired");
  assert.equal(isGlobalRouterDown(), true);
});

