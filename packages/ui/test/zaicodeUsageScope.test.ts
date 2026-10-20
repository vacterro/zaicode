import assert from "node:assert/strict";
import test from "node:test";
import { emptyZaicodeStatsTotals } from "@zcode/shared";
import {
  zaicodeScopeIsEmpty,
  zaicodeScopeRequest,
  zaicodeScopeSessionLabel,
  zaicodeScopeSummary,
} from "../src/zaicode/home/zaicodeUsageScope.js";

test("REQ-012: scope requests resolve to recorded slices; unpicked tabs fetch nothing", () => {
  assert.deepEqual(zaicodeScopeRequest("global", { project: "a", sessionId: "s" }), { project: null, sessionId: null });
  assert.deepEqual(zaicodeScopeRequest("project", { project: "a", sessionId: null }), { project: "a", sessionId: null });
  assert.equal(zaicodeScopeRequest("project", { project: null, sessionId: null }), null);
  assert.deepEqual(zaicodeScopeRequest("session", { project: "a", sessionId: "s" }), { project: "a", sessionId: "s" });
  assert.deepEqual(zaicodeScopeRequest("session", { project: null, sessionId: "s" }), { project: null, sessionId: "s" });
  assert.equal(zaicodeScopeRequest("session", { project: "a", sessionId: null }), null);
});

test("REQ-012: zero rows read as no-recorded-events; summaries and session labels stay compact", () => {
  assert.equal(zaicodeScopeIsEmpty(emptyZaicodeStatsTotals()), true);
  const totals = { ...emptyZaicodeStatsTotals(), tokens: 1800, requests: 3, turns: 2, jobsDone: 1 };
  assert.equal(zaicodeScopeIsEmpty(totals), false);
  const grouped = (1800).toLocaleString(undefined, { maximumFractionDigits: 0 });
  assert.equal(zaicodeScopeSummary(totals), `${grouped} tokens · 3 requests · 2 turns · 1 done`);
  assert.equal(zaicodeScopeSessionLabel("s1", null), "s1");
  assert.equal(zaicodeScopeSessionLabel("averylongsessionid", "V:\\work\\_ZAICODE"), "averylongses… · V:\\work\\_ZAICODE");
});
