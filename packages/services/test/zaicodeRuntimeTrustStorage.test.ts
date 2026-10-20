import assert from "node:assert/strict";
import { test } from "node:test";
import { planStorageClean } from "../src/storage/domain/cleanPlan.js";

const now = 1_700_000_000_000;
const old = { relativePath: "cli/agents/sess-old/sub-1/transcript.jsonl", bytes: 100, mtimeMs: now - 172_800_000 };
const context = { rootId: "zaicode" as const, hasCustomDataBaseDir: false };

test("storage activity: absence of a runtime provider preserves an old transcript", () => {
  assert.equal(planStorageClean({ categoryId: "subagentTranscripts", candidates: [old], context, now }).targets.length, 0);
});

test("storage activity: unknown result preserves an old transcript", () => {
  const unknown = (() => undefined) as unknown as (sessionId: string) => boolean;
  assert.equal(planStorageClean({ categoryId: "subagentTranscripts", candidates: [old], context, now, isSessionActive: unknown }).targets.length, 0);
});

test("storage activity: a failing runtime provider preserves rather than authorizing deletion", () => {
  assert.equal(planStorageClean({
    categoryId: "subagentTranscripts", candidates: [old], context, now,
    isSessionActive: () => { throw Error("runtime unavailable"); },
  }).targets.length, 0);
});

test("storage activity: only explicit inactivity permits an old transcript; active and recent stay", () => {
  const plan = (active: boolean, mtimeMs = old.mtimeMs) => planStorageClean({
    categoryId: "subagentTranscripts", candidates: [{ ...old, mtimeMs }], context, now, isSessionActive: () => active,
  });
  assert.equal(plan(false).targets.length, 1);
  assert.equal(plan(true).targets.length, 0);
  assert.equal(plan(false, now - 1000).targets.length, 0);
  assert.equal(plan(false, now + 1000).targets.length, 0);
  assert.equal(plan(false, Number.NaN).targets.length, 0);
});
