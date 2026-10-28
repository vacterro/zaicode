import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyZaicodeStatsTotals, type ZaicodeHomeStats, type ZaicodeStatsTotals } from "@zcode/shared";
import { ZaicodeHomeTokenRibbon } from "../src/zaicode/home/ZaicodeHomeStatsCards.js";
import { normalizeZaicodeHomePrefs } from "../src/zaicode/home/zaicodeHomePrefs.js";

// T-52 (SRC-038): token totals today / yesterday / week / month / all on the home screen, top left.

function totals(tokens: number): ZaicodeStatsTotals {
  return { ...emptyZaicodeStatsTotals(), tokens, requests: Math.round(tokens / 1000) };
}

function stats(state: "fresh" | "stale"): ZaicodeHomeStats {
  return {
    periods: {
      today: totals(1_234_567),
      yesterday: totals(987_000),
      week: totals(12_500_000),
      month: totals(48_000_000),
      all: totals(3_550_534_108),
    },
    sources: [{ source: "agent-db", state }],
  } as unknown as ZaicodeHomeStats;
}

test("the SAIHOME token ribbon lists today, yesterday, week, month and all time in that order", () => {
  const html = renderToStaticMarkup(createElement(ZaicodeHomeTokenRibbon, { stats: stats("fresh"), error: null }));
  const labels = [...html.matchAll(/>(TODAY|YDAY|WEEK|MONTH|ALL)</g)].map((match) => match[1]);
  assert.deepEqual(labels, ["TODAY", "YDAY", "WEEK", "MONTH", "ALL"]);
  assert.match(html, /data-zaicode-token-ribbon/);
  assert.match(html, /Today: 1,234,567 tokens/, "the exact count is on the tooltip");
  assert.doesNotMatch(html, /\(stale\)/);
});

test("stale statistics are marked, missing statistics render nothing", () => {
  const html = renderToStaticMarkup(createElement(ZaicodeHomeTokenRibbon, { stats: stats("fresh"), error: "timeout" }));
  assert.match(html, /\(stale\)/);
  assert.equal(renderToStaticMarkup(createElement(ZaicodeHomeTokenRibbon, { stats: null, error: null })), "");
});

test("the ribbon is on by default and the operator's choice is kept", () => {
  assert.equal(normalizeZaicodeHomePrefs(null).tokenRibbon, true);
  assert.equal(normalizeZaicodeHomePrefs({ tokenRibbon: false }).tokenRibbon, false);
  assert.equal(normalizeZaicodeHomePrefs({ tokenRibbon: "yes" }).tokenRibbon, true);
});
