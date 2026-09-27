import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeZaicodeEngineBarPrefs,
  zaicodeEngineBarLabel,
  zaicodeEngineBarPools,
} from "../src/zaicode/zaicodeEngineBarPrefs.js";

// SRC-061: the sidebar engine block is simpler and fully under control:
// by default only SAIFREN and SAIOPP, the operator picks up to four.

const options = ["SAIFREN", "SAIOPP", "ag/claude-opus-4-6-thinking", "kilo/free"].map((modelId) => ({ modelId }));

test("by default only the two ZAICODE pools show", () => {
  assert.deepEqual(zaicodeEngineBarPools(options, { pools: null }).map((option) => option.modelId), ["SAIFREN", "SAIOPP"]);
  // A router without them shows its first two instead of nothing.
  assert.deepEqual(zaicodeEngineBarPools(options.slice(2), { pools: null }).map((option) => option.modelId), [
    "ag/claude-opus-4-6-thinking",
    "kilo/free",
  ]);
});

test("the operator's own list wins; a model that disappeared is skipped", () => {
  assert.deepEqual(
    zaicodeEngineBarPools(options, { pools: ["ag/claude-opus-4-6-thinking", "gone", "SAIFREN"] }).map((option) => option.modelId),
    ["ag/claude-opus-4-6-thinking", "SAIFREN"],
  );
});

test("stored prefs normalize: at most four, no duplicates, subs on by default", () => {
  assert.deepEqual(normalizeZaicodeEngineBarPrefs(null), { pools: null, showSubs: true });
  assert.deepEqual(normalizeZaicodeEngineBarPrefs({ pools: ["a", "a", "b", "c", "d", "e", 3], showSubs: false }), {
    pools: ["a", "b", "c", "d"],
    showSubs: false,
  });
  assert.equal(zaicodeEngineBarLabel("ag/claude-opus-4-6-thinking"), "claude-opus-4-6-thinking");
  assert.equal(zaicodeEngineBarLabel("SAIFREN"), "SAIFREN");
});
