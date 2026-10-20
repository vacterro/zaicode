import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ZaicodeOptimizationFindingDto,
  ZaicodeOptimizationSummaryDto,
} from "@zcode/shared";
import { ZaicodeUsageEfficiency } from "../src/zaicode/ZaicodeUsageEfficiency.js";

function makeSummary(partial: Partial<ZaicodeOptimizationSummaryDto> = {}): ZaicodeOptimizationSummaryDto {
  return {
    calls: 12,
    totalTokens: 40000,
    inputTokens: 30000,
    outputTokens: 10000,
    thinkingTokens: 0,
    cacheReadTokens: 5000,
    cacheWriteTokens: 1000,
    cacheHitRate: 0.32,
    avgTokensPerCall: 3333,
    avgCostPerCall: 0.0021,
    totalCostUsd: 0.0254,
    apiEquivalentCostUsd: 1.71,
    unpricedCalls: 0,
    potentialSavingsMonthlyUsd: 12.5,
    findingsCount: 1,
    windowDays: 30,
    byModel: [],
    byProvider: [],
    byProject: [],
    topWasteRules: [],
    ...partial,
  };
}

function makeFinding(partial: Partial<ZaicodeOptimizationFindingDto> = {}): ZaicodeOptimizationFindingDto {
  return {
    rule: "context-growth",
    category: "context",
    title: "Context grows past the useful window",
    detail: "Session input grew 4x while output stayed flat.",
    why: "Long sessions re-send a growing prefix every call.",
    severity: "medium",
    risk: "needs-verification",
    impact: "high",
    savingsWindowUsd: 1.2,
    savingsMonthlyUsd: 12.5,
    confidence: "medium",
    confidenceBasis: "measured token counts",
    evidenceKind: "measured",
    affectedCalls: 6,
    affectedModels: ["claude-3-5-sonnet"],
    fix: "Split the session or trim the prefix",
    ...partial,
  };
}

test("SRC-206: the efficiency panel shows the read-only summary split between billed spend and subscription value", () => {
  const html = renderToStaticMarkup(
    createElement(ZaicodeUsageEfficiency, { summary: makeSummary(), findings: [], loading: false }),
  );
  assert.ok(html.includes('data-testid="zaicode-optimization-efficiency"'), "panel is addressable");
  assert.ok(html.includes("Cache Hit Rate"));
  assert.ok(html.includes("32.0%"));
  // 当前 Usage 规则缩短展示金额；仍分别钉住真实账单、订阅等价与节省，不能互换。
  assert.match(html, /Billed API Spend<\/span><strong[^>]*>\$0\.03<\/strong>/);
  assert.match(html, /Subscription Value<\/span><strong[^>]*>\$1\.71<\/strong>/);
  assert.match(html, /Potential Monthly Savings<\/span><strong[^>]*>\$12\.5<\/strong>/);
  assert.doesNotMatch(html.replace("$0.03", "$99.99"), /Billed API Spend<\/span><strong[^>]*>\$0\.03<\/strong>/);
  assert.ok(html.includes("Not a bill"), "the API-equivalent figure never reads as money owed");
  assert.ok(html.includes("OBSERVE &amp; RECOMMEND"), "the panel advertises its read-only default");
  assert.equal((html.match(/data-optimization-finding=/g) ?? []).length, 0);
});

test("SRC-206: a finding renders its rule, evidence kind and recommended action", () => {
  const html = renderToStaticMarkup(
    createElement(ZaicodeUsageEfficiency, {
      summary: makeSummary({ findingsCount: 1 }),
      findings: [makeFinding(), makeFinding({ rule: "cold-cache-repeat", evidenceKind: "estimated" })],
      loading: false,
    }),
  );
  assert.equal((html.match(/data-optimization-finding=/g) ?? []).length, 2);
  assert.ok(html.includes('data-optimization-finding="context-growth"'));
  assert.ok(html.includes('data-optimization-finding="cold-cache-repeat"'));
  assert.ok(html.includes("measured"), "a finding carries its own evidence strength");
  assert.ok(html.includes("estimated"));
  assert.ok(html.includes("Findings &amp; Waste Recommendations (2)"));
  assert.ok(html.includes("Split the session or trim the prefix"));
  assert.ok(html.includes("6 calls"));
});

test("SRC-206: unpriced calls are named on the billed-spend card instead of reading as zero money", () => {
  const html = renderToStaticMarkup(
    createElement(ZaicodeUsageEfficiency, {
      summary: makeSummary({ unpricedCalls: 7 }),
      findings: [],
      loading: false,
    }),
  );
  assert.ok(html.includes("7 calls unpriced"), "unknown money is visible, not implied to be $0");
  const priced = renderToStaticMarkup(
    createElement(ZaicodeUsageEfficiency, { summary: makeSummary(), findings: [], loading: false }),
  );
  assert.ok(priced.includes("Direct provider invoices"));
});

test("SRC-206: an absent or failing host service degrades to not-measured instead of a wrong number", () => {
  const html = renderToStaticMarkup(
    createElement(ZaicodeUsageEfficiency, { summary: null, findings: [], loading: false }),
  );
  assert.equal((html.match(/>—</g) ?? []).length, 4, "every metric reads as not measured");
  assert.ok(html.includes("No efficiency waste detected."));
  assert.equal((html.match(/data-optimization-finding=/g) ?? []).length, 0);
  const loading = renderToStaticMarkup(
    createElement(ZaicodeUsageEfficiency, { summary: null, findings: [], loading: true }),
  );
  assert.ok(loading.includes("Evaluating usage with optimAIzr analytics…"));
});
