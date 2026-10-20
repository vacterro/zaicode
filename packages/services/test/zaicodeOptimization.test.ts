import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptZaicodeStatsRowToUsageEvent,
  adaptStatsEventsToOptimizationDataset,
  buildOptimizationSummaryDto,
  normalizeModelForPricing,
} from "../src/zaicode/zaicodeOptimizationAdapter.js";
import { findWaste } from "../src/zaicode/optimaizr/index.js";
import {
  ZaicodeOptimizationService,
} from "../src/zaicode/zaicodeOptimizationService.js";
import type { ZaicodeStatsEventRow } from "../src/zaicode/zaicodeStatsRepo.js";

function makeRow(partial: Partial<ZaicodeStatsEventRow>): ZaicodeStatsEventRow {
  return {
    id: "ev-1",
    source: "agent-db",
    kind: "model.request",
    at: 1775836800000,
    startedAt: 1775836798800,
    durationMs: 1200,
    project: "/work/zcode",
    sessionId: "sess-1",
    jobId: "job-1",
    agent: "orchestrator",
    engine: "claude",
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 300,
    cacheWriteTokens: 200,
    reasoningTokens: 0,
    totalTokens: 1500,
    result: "completed",
    failure: null,
    retryOf: null,
    ...partial,
  };
}

test("adaptation: correctly converts ZaicodeStatsEventRow into UsageEvent", () => {
  const row = makeRow({
    id: "ev-100",
    at: 1775836800000,
    provider: "openai",
    model: "gpt-4o",
  });

  const event = adaptZaicodeStatsRowToUsageEvent(row);
  assert.ok(event !== null);
  assert.equal(event.id, "ev-100");
  assert.equal(event.model, "gpt-4o");
  assert.equal(event.provider, "openai");
  assert.equal(event.inputTokens, 1000);
  assert.equal(event.outputTokens, 500);
  assert.equal(event.cacheReadTokens, 300);
  assert.equal(event.cacheWrite5mTokens, 200);
  assert.equal(event.isApiEquivalentSubscription, false);
  assert.equal(event.project, "/work/zcode");
  assert.equal(event.sessionId, "sess-1");
});

test("cost separation: distinguishes direct billed API costs from subscription plan value", () => {
  const directRow = makeRow({
    id: "direct-1",
    provider: "openrouter",
    model: "claude-opus-4-6",
  });
  const subRow = makeRow({
    id: "sub-1",
    provider: "SAIRoute",
    model: "claude-opus-4-6",
  });

  const directEvent = adaptZaicodeStatsRowToUsageEvent(directRow);
  const subEvent = adaptZaicodeStatsRowToUsageEvent(subRow);

  assert.ok(directEvent !== null);
  assert.ok(subEvent !== null);
  assert.equal(directEvent.isApiEquivalentSubscription, false);
  assert.equal(subEvent.isApiEquivalentSubscription, true);

  const dataset = adaptStatsEventsToOptimizationDataset([directRow, subRow]);
  const summary = buildOptimizationSummaryDto(dataset, []);
  assert.ok(summary.totalCostUsd > 0); // Only direct billed API spend
  assert.ok(summary.apiEquivalentCostUsd > 0); // Subscription plan equivalent
  assert.equal(summary.unpricedCalls, 0);
});

test("honesty: an unpriced model is reported as unpriced, never billed as a guessed version", () => {
  // A routed id loses its vendor prefix but keeps its identity.
  assert.equal(normalizeModelForPricing("anthropic/claude-opus-4-6"), "claude-opus-4-6");
  const unknownRow = makeRow({ id: "unknown-1", provider: "openrouter", model: "claude-3-5-sonnet" });
  const unknown = adaptZaicodeStatsRowToUsageEvent(unknownRow);
  const known = adaptZaicodeStatsRowToUsageEvent(
    makeRow({ id: "known-1", provider: "openrouter", model: "anthropic/claude-opus-4-6" }),
  );
  assert.ok(unknown !== null && known !== null);
  assert.equal(unknown.costUnpriced, true, "a model the catalogue lacks is never priced as its successor");
  assert.equal(unknown.cost.total, 0);
  assert.equal(known.costUnpriced, false);

  const summary = buildOptimizationSummaryDto(
    adaptStatsEventsToOptimizationDataset([
      unknownRow,
      makeRow({ id: "known-1", provider: "openrouter", model: "anthropic/claude-opus-4-6" }),
    ]),
    [],
  );
  assert.equal(summary.calls, 2);
  assert.equal(summary.unpricedCalls, 1, "the unpriced call is surfaced, not silently zero");
});

test("dataset: deduplicates identical events and builds window totals", () => {
  const row1 = makeRow({ id: "ev-dup", totalTokens: 1000, inputTokens: 800, outputTokens: 200 });
  const row2 = makeRow({ id: "ev-dup", totalTokens: 1000, inputTokens: 800, outputTokens: 200 }); // duplicate
  const row3 = makeRow({ id: "ev-unique", totalTokens: 2000, inputTokens: 1500, outputTokens: 500 });

  const dataset = adaptStatsEventsToOptimizationDataset([row1, row2, row3]);
  assert.equal(dataset.events.length, 2);
  const summary = buildOptimizationSummaryDto(dataset, []);
  assert.equal(summary.calls, 2);
  assert.equal(summary.inputTokens, 2300);
});

test("optimaizr engine: findWaste analyzes context and emits findings with evidence", () => {
  // Construct events across sessions with low cache hit rate
  const rows: ZaicodeStatsEventRow[] = [];
  const baseTime = Date.now() - 3600000;
  for (let i = 0; i < 6; i++) {
    rows.push(
      makeRow({
        id: `ev-${i}`,
        sessionId: `sess-${i}`,
        at: baseTime + i * 10000,
        model: "gpt-4o",
        inputTokens: i === 0 ? 500000 : 1000,
        outputTokens: i === 0 ? 50000 : 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    );
  }

  const dataset = adaptStatsEventsToOptimizationDataset(rows);
  const summary = buildOptimizationSummaryDto(dataset, []);

  assert.equal(summary.calls, 6);
  assert.ok(summary.totalCostUsd > 0);
  assert.equal(summary.cacheHitRate, 0);

  // Directly exercise finding waste
  const findings = findWaste(dataset);

  assert.ok(findings.length > 0, "Waste detection should produce findings for un-cached high-volume calls");
  const first = findings[0];
  assert.ok(first.rule);
  assert.ok(first.title);
  assert.ok(["measured", "inferred", "estimated"].includes(first.savings.evidence.kind.toLowerCase()));
});

test("policy enforcement: mutations remain locked and prompt capture strictly forbidden", () => {
  const dummyRepo = {
    ensureReady: async () => {},
    all: () => [],
  };

  const service = new ZaicodeOptimizationService({
    repo: dummyRepo as any,
  });

  const defaultPolicy = service.getPolicy();
  assert.equal(defaultPolicy.enabled, true);
  assert.equal(defaultPolicy.preventMutations, true);
  assert.equal(defaultPolicy.allowPromptCapture, false);
  assert.equal(defaultPolicy.recommend, true);

  // Attempt to tamper with prompt capture
  const updated = service.updatePolicy({
    allowPromptCapture: true as any,
    observeOnly: true,
  });

  // Prompt capture must be forcibly clamped to false
  assert.equal(updated.allowPromptCapture, false);
  assert.equal(service.getPolicy().allowPromptCapture, false);
  assert.equal(service.getPolicy().preventMutations, true);
});

test("service: getSummary and getFindings filter by project and session gracefully", async () => {
  const rows: ZaicodeStatsEventRow[] = [
    makeRow({ id: "e1", project: "/projA", sessionId: "s1" }),
    makeRow({ id: "e2", project: "/projA", sessionId: "s2" }),
    makeRow({ id: "e3", project: "/projB", sessionId: "s3" }),
  ];

  const dummyRepo = {
    ensureReady: async () => {},
    all: () => rows,
  };

  const service = new ZaicodeOptimizationService({
    repo: dummyRepo as any,
  });

  const projSummary = await service.getSummary({ project: "/projA" });
  assert.equal(projSummary.calls, 2);

  const sessionSummary = await service.getSummary({ sessionId: "s3" });
  assert.equal(sessionSummary.calls, 1);

  const findings = await service.getFindings({ project: "/projB" });
  assert.ok(Array.isArray(findings));
});

test("graceful error boundary: repo or engine failure does not throw", async () => {
  const brokenRepo = {
    ensureReady: async () => {
      throw new Error("Disk corruption");
    },
    all: () => {
      throw new Error("Disk corruption");
    },
  };

  let loggedWarning = false;
  const service = new ZaicodeOptimizationService({
    repo: brokenRepo as any,
    logger: {
      warn: (msg, err) => {
        loggedWarning = true;
      },
      info: () => {},
    },
  });

  const summary = await service.getSummary();
  assert.equal(summary.calls, 0);
  assert.equal(summary.totalTokens, 0);
  assert.equal(loggedWarning, true);

  const findings = await service.getFindings();
  assert.deepEqual(findings, []);
});
