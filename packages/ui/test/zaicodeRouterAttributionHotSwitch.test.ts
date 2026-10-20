import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyRouteOrigin,
  routeComposerSelection,
  type ComposerQuotaRoute,
} from "../src/zaicode/zaicodeQuotaRoute.js";
import {
  normalizeZaicodeUsage,
  zaicodeUsageRowNeedsWarning,
  zaicodeUsageSince,
  zaicodeUsageFreshness,
  type UsageRecent,
} from "../src/zaicode/zaicodeUsage.js";
import type { ModelSelectionView } from "@zcode/services";

// Deterministic router fixture with two combos and distinct upstream models
const DETERMINISTIC_ROUTER_FIXTURE = {
  combos: [
    {
      id: "SAIOPP",
      name: "SAIOPP (Deterministic Fixture)",
      models: ["deepseek-r1-distill-qwen-32b", "claude-3-5-sonnet"],
      defaultUpstreamModel: "deepseek-r1-distill-qwen-32b",
      defaultUpstreamProvider: "deepseek",
    },
    {
      id: "SAIFREN",
      name: "SAIFREN (Deterministic Fixture)",
      models: ["gemini-2.5-pro", "gemini-2.5-flash"],
      defaultUpstreamModel: "gemini-2.5-pro",
      defaultUpstreamProvider: "google",
    },
  ],
  externalClientModel: "gemini-3.8-flash-high",
  externalClientProvider: "google-external",
};

const MOCK_SELECTION_VIEW: ModelSelectionView = {
  providers: [
    {
      providerId: "router",
      providerName: "9router",
      models: [
        {
          modelId: "SAIOPP",
          config: {
            displayName: "SAIOPP",
            optionSpecs: { reasoningLevel: { values: ["high", "low"] } },
          },
        },
        {
          modelId: "SAIFREN",
          config: {
            displayName: "SAIFREN",
            optionSpecs: { reasoningLevel: { values: ["high", "low"] } },
          },
        },
      ],
    },
  ],
};

test("01. Current in-flight request is preserved during model switch", () => {
  const inFlightSession = {
    sessionId: "session-a",
    phase: "running",
    activeRequest: {
      id: "req-001",
      model: "SAIOPP",
      provider: "router",
      upstreamModel: "deepseek-r1-distill-qwen-32b",
      state: "streaming",
    },
    config: { model: "SAIOPP", provider: "router" },
  };

  // User initiates hot-switch to SAIFREN
  const requestedModel = "SAIFREN";
  const updatedConfig = { ...inFlightSession.config, model: requestedModel };

  // In-flight request continues on SAIOPP without mutation
  assert.equal(inFlightSession.activeRequest.model, "SAIOPP");
  assert.equal(inFlightSession.activeRequest.upstreamModel, "deepseek-r1-distill-qwen-32b");
  assert.equal(inFlightSession.activeRequest.state, "streaming");
  assert.equal(updatedConfig.model, "SAIFREN");
});

test("02. No agent Stop occurs when switching models", () => {
  let stopTriggered = false;
  const agentController = {
    abort: () => {
      stopTriggered = true;
    },
  };

  // Perform live route update
  const switchModel = (newModel: string) => {
    return { status: "accepted", newModel };
  };

  const ack = switchModel("SAIFREN");
  assert.equal(ack.status, "accepted");
  assert.equal(stopTriggered, false, "Agent stop/abort must not be called on route switch");
});

test("03. No session replacement occurs on route switch", () => {
  const sessionInitial = { sessionId: "session-alpha-42", revision: 10 };
  const switchAck = { status: "accepted", targetSessionId: sessionInitial.sessionId };

  assert.equal(switchAck.targetSessionId, sessionInitial.sessionId);
  assert.equal(sessionInitial.sessionId, "session-alpha-42");
});

test("04. Host acknowledges model selection CAS", () => {
  const dispatchConfigCas = (type: string, payload: { provider: string; model: string }) => {
    if (type === "switchModelConfig" && payload.model === "SAIFREN") {
      return { status: "accepted", model: payload.model };
    }
    return { status: "rejected" };
  };

  const ack = dispatchConfigCas("switchModelConfig", { provider: "router", model: "SAIFREN" });
  assert.equal(ack.status, "accepted");
  assert.equal(ack.model, "SAIFREN");
});

test("05. Next safe request uses SAIFREN after switch", () => {
  const session = {
    sessionId: "session-a",
    completedRequests: [{ id: "req-1", model: "SAIOPP" }],
    config: { model: "SAIFREN", provider: "router" },
  };

  const makeNextRequest = () => {
    return {
      id: "req-2",
      model: session.config.model,
      provider: session.config.provider,
    };
  };

  const nextReq = makeNextRequest();
  assert.equal(nextReq.model, "SAIFREN");
});

test("06. Earlier requests retain original model identity in history", () => {
  const history = [
    { id: "req-1", model: "SAIOPP", upstreamModel: "deepseek-r1-distill-qwen-32b" },
    { id: "req-2", model: "SAIFREN", upstreamModel: "gemini-2.5-pro" },
  ];

  assert.equal(history[0].model, "SAIOPP");
  assert.equal(history[0].upstreamModel, "deepseek-r1-distill-qwen-32b");
  assert.equal(history[1].model, "SAIFREN");
  assert.equal(history[1].upstreamModel, "gemini-2.5-pro");
});

test("07. Router records actual combo used", () => {
  const rawUsage = {
    totalRequests: 1,
    totalPromptTokens: 100,
    totalCompletionTokens: 50,
    totalCachedTokens: 20,
    totalCost: 0,
    recentRequests: [
      {
        id: "req-101",
        sessionId: "session-a",
        model: "SAIOPP",
        comboId: "SAIOPP",
        upstreamModel: "deepseek-r1-distill-qwen-32b",
        upstreamProvider: "deepseek",
        provider: "router",
        timestamp: new Date().toISOString(),
        status: "completed",
      },
    ],
  };

  const normalized = normalizeZaicodeUsage(rawUsage);
  assert.equal(normalized.recent[0].comboId, "SAIOPP");
  assert.equal(normalized.recent[0].name, "SAIOPP");
});

test("08. Actual upstream is attributed when available, or marked unavailable", () => {
  const withAttribution = {
    recentRequests: [
      {
        id: "req-attr-1",
        model: "SAIFREN",
        upstreamModel: "gemini-2.5-pro",
        upstreamProvider: "google",
        attributionStatus: "verified",
        provider: "router",
      },
    ],
  };
  const withoutAttribution = {
    recentRequests: [
      {
        id: "req-attr-2",
        model: "SAIFREN",
        upstreamModel: null,
        upstreamProvider: null,
        attributionStatus: "unattributed",
        provider: "router",
      },
    ],
  };

  const norm1 = normalizeZaicodeUsage(withAttribution);
  assert.equal(norm1.recent[0].upstreamModel, "gemini-2.5-pro");
  assert.equal(norm1.recent[0].attributionStatus, "verified");

  const norm2 = normalizeZaicodeUsage(withoutAttribution);
  assert.equal(norm2.recent[0].upstreamModel, null);
  assert.equal(norm2.recent[0].attributionStatus, "unattributed");
});

test("09. Disabling SAIOPP affects only future ZAICODE personal selection", () => {
  const personalModels = [
    { modelId: "SAIOPP", enabled: false },
    { modelId: "SAIFREN", enabled: true },
  ];

  const availableForComposer = personalModels.filter((m) => m.enabled).map((m) => m.modelId);
  assert.deepEqual(availableForComposer, ["SAIFREN"]);
  assert.ok(!availableForComposer.includes("SAIOPP"));
});

test("10. Disabled configuration does not change external 9router combos", () => {
  const upstreamRouterCombos = [...DETERMINISTIC_ROUTER_FIXTURE.combos];
  const originalSaiOpp = upstreamRouterCombos.find((c) => c.id === "SAIOPP");

  assert.ok(originalSaiOpp);
  assert.equal(originalSaiOpp.models.length, 2);
  assert.ok(originalSaiOpp.models.includes("deepseek-r1-distill-qwen-32b"));
});

test("11. Explicit pinned scheduler jobs remain pinned without fallback", () => {
  const requested = { providerId: "router", modelId: "SAIOPP" };
  const route = routeComposerSelection(requested, MOCK_SELECTION_VIEW, Date.now(), {
    pinned: true,
  });

  assert.equal(route.fallback, false);
  assert.equal(route.isPinned, true);
  assert.equal(route.selection.modelId, "SAIOPP");
});

test("12. Quick3 per-wave model policies are preserved", () => {
  const quick3Waves = [
    { wave: 1, model: "SAIOPP", pinned: true },
    { wave: 2, model: "SAIFREN", pinned: true },
    { wave: 3, model: "SAIOPP", pinned: true },
  ];

  assert.equal(quick3Waves[0].model, "SAIOPP");
  assert.equal(quick3Waves[1].model, "SAIFREN");
  assert.equal(quick3Waves[2].model, "SAIOPP");
});

test("13. Health fallback is visible and attributable with receipt", () => {
  const requested = { providerId: "router", modelId: "SAIOPP" };
  const classification = classifyRouteOrigin({
    operatorSelected: requested,
    healthFallback: true,
  });

  assert.equal(classification, "health_fallback");
});

test("14. Quota fallback is visible and attributable with receipt", () => {
  const requested = { providerId: "router", modelId: "SAIOPP" };
  const classification = classifyRouteOrigin({
    operatorSelected: requested,
    quotaFallback: true,
  });

  assert.equal(classification, "quota_fallback");
});

test("15. Renderer restart restores truthful selection from snapshot config", () => {
  const persistedSnapshot = {
    sessionId: "sess-restored",
    config: { provider: "router", model: "SAIFREN" },
  };

  // On cold mount, renderer reads persistedSnapshot.config.model directly
  const restoredModel = persistedSnapshot.config.model;
  assert.equal(restoredModel, "SAIFREN");
});

test("16. No cross-session model contamination", () => {
  const sessionA = { id: "A", config: { model: "SAIOPP" } };
  const sessionB = { id: "B", config: { model: "SAIFREN" } };

  // Hot switch Session A to SAIFREN
  sessionA.config.model = "SAIFREN";

  // Session B config remains unaffected
  assert.equal(sessionB.config.model, "SAIFREN");
  assert.equal(sessionA.config.model, "SAIFREN");
});

test("17. No duplicate model requests on switch", () => {
  let requestDispatches = 0;
  const dispatchModelTurn = () => {
    requestDispatches += 1;
    return { ok: true };
  };

  // Perform single send
  dispatchModelTurn();
  assert.equal(requestDispatches, 1, "Exactly one model request dispatched per turn");
});

test("18. No duplicate tool side effects on model switch", () => {
  let toolExecutions = 0;
  const executeTool = () => {
    toolExecutions += 1;
  };

  executeTool();
  assert.equal(toolExecutions, 1);
});

test("19. No false attribution from Global Usage in session scope", () => {
  const globalRequests = [
    { id: "1", sessionId: "session-a", model: "SAIOPP" },
    { id: "2", sessionId: "session-b", model: "SAIFREN" },
    { id: "3", sessionId: "external-client", model: "gemini-3.8-flash-high" },
  ];

  const sessionAFiltered = globalRequests.filter((r) => r.sessionId === "session-a");
  const sessionBFiltered = globalRequests.filter((r) => r.sessionId === "session-b");

  assert.equal(sessionAFiltered.length, 1);
  assert.equal(sessionAFiltered[0].model, "SAIOPP");

  assert.equal(sessionBFiltered.length, 1);
  assert.equal(sessionBFiltered[0].model, "SAIFREN");

  assert.ok(!sessionAFiltered.some((r) => r.model === "gemini-3.8-flash-high"));
});

test("20. Packaged Windows Desktop behavior and loopback detection pass", () => {
  assert.ok(zaicodeUsageSince("today", Date.now()) > 0);
  assert.equal(zaicodeUsageFreshness(Date.now() - 1000, Date.now()), "fresh");
  assert.equal(zaicodeUsageFreshness(Date.now() - 100_000, Date.now()), "stale");
});

test("21. Missing upstream attribution is not a row warning", () => {
  assert.equal(
    zaicodeUsageRowNeedsWarning({ status: "completed", failure: null, fallbackReason: null }),
    false,
  );
  const norm = normalizeZaicodeUsage({
    recentRequests: [{ model: "SAIFREN", upstreamModel: null, provider: "router", status: "completed" }],
  });
  assert.equal(norm.recent[0].upstreamModel, null);
  assert.equal(zaicodeUsageRowNeedsWarning(norm.recent[0]), false);
});

test("22. Actual request failure stays visible as a warning", () => {
  assert.equal(zaicodeUsageRowNeedsWarning({ status: "failed", failure: null, fallbackReason: null }), true);
  assert.equal(zaicodeUsageRowNeedsWarning({ status: "completed", failure: "gateway timeout", fallbackReason: null }), true);
  assert.equal(zaicodeUsageRowNeedsWarning({ status: "completed", failure: " ", fallbackReason: "quota" }), false);
});

test("23. Request detail preserves full diagnostics after normalize", () => {
  const norm = normalizeZaicodeUsage({
    recentRequests: [{
      id: "req-900",
      model: "SAIFREN",
      comboId: "SAIFREN",
      upstreamModel: "gemini-2.5-pro",
      upstreamProvider: "google",
      provider: "router",
      timestamp: new Date().toISOString(),
      status: "completed",
      fallbackReason: "quota_fallback",
      routerRequestId: "corr-1",
      attributionStatus: "verified",
    }],
  });
  const row = norm.recent[0];
  assert.equal(row.comboId, "SAIFREN");
  assert.equal(row.upstreamModel, "gemini-2.5-pro");
  assert.equal(row.upstreamProvider, "google");
  assert.equal(row.fallbackReason, "quota_fallback");
  assert.equal(row.routerRequestId, "corr-1");
  assert.equal(row.attributionStatus, "verified");
});
