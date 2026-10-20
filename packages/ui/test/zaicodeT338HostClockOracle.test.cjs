const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { stripTypeScriptTypes } = require("node:module");
const path = require("node:path");
const test = require("node:test");

const source = readFileSync(path.resolve(__dirname, "../src/zaicode/zaicodeNowGate.ts"), "utf8");
const reactImport = /^import \{[^\n]+\} from "react";\r?\n/gm;
assert.equal([...source.matchAll(reactImport)].length, 1);
// This hook instrument observes the real initializer/updater and executes its real timer callback.
const shim = `const useRef=value=>({current:value});const useEffect=effect=>{const cleanup=effect();if(cleanup)globalThis.__T338_HOOK.cleanup=cleanup;};const useState=initializer=>{const state=globalThis.__T338_HOOK;state.value=typeof initializer==='function'?initializer():initializer;return [state.value,next=>{state.value=typeof next==='function'?next(state.value):next;}];};\n`;
const clock = import("data:text/javascript;base64," + Buffer.from(shim + stripTypeScriptTypes(source.replace(reactImport, ""), { mode: "strip" })).toString("base64"));
const timeSource = readFileSync(path.resolve(__dirname, "../src/v4/messageTimeLabel.ts"), "utf8");
const labels = import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(timeSource, { mode: "strip" })).toString("base64"));
const sent = Date.UTC(2026, 9, 14, 10, 0);

async function instrument(run) {
  const oldNow = Date.now, oldWindow = globalThis.window;
  const state = { value: undefined, tick: undefined, cleanup: undefined, wall: sent + 120000 };
  globalThis.__T338_HOOK = state;
  globalThis.window = { setInterval: callback => { state.tick = callback; return 1; }, clearInterval() {} };
  Date.now = () => state.wall;
  try { await run(await clock, await labels, state); }
  finally { state.cleanup?.(); Date.now = oldNow; globalThis.window = oldWindow; delete globalThis.__T338_HOOK; }
}

test("independent renderer wall-clock skew cannot change the Host's two-minute message age", async () => {
  for (const offset of [-14 * 86400000, 14 * 86400000]) await instrument(async (m, time, state) => {
    state.wall += offset;
    const now = m.useZaicodeGatedNow(() => 60000, sent, () => sent + 120000);
    assert.equal(now, sent + 120000);
    assert.equal(time.formatMessageElapsedLabel(sent, "en-US", now), "2 min. ago");
  });
});

test("monotonic Host advance survives a renderer wall-clock jump between ticks", async () => {
  await instrument(async (m, time, state) => {
    let host = sent + 120000;
    m.useZaicodeGatedNow(() => 60000, sent, () => host);
    host += 60000; state.wall -= 30 * 86400000;
    state.tick();
    assert.equal(state.value, sent + 180000);
    assert.equal(time.formatMessageElapsedLabel(sent, "en-US", state.value), "3 min. ago");
  });
});

test("unknown Host clock never falls back to renderer time and recovers on its next real tick", async () => {
  await instrument(async (m, _time, state) => {
    let host = null;
    assert.equal(m.useZaicodeGatedNow(() => 1000, sent, () => host), null);
    host = sent + 10000; state.tick();
    assert.equal(state.value, host);
    host = null; state.tick();
    assert.equal(state.value, null);
  });
});

test("invalid explicit clock readings remain unavailable", async () => {
  for (const value of [NaN, Infinity, -Infinity]) await instrument(async (m) => {
    assert.equal(m.useZaicodeGatedNow(() => 1000, sent, () => value), null);
  });
});

test("existing wall-clock consumers retain their numeric default and bucket origin", async () => {
  await instrument(async (m, _time, state) => {
    assert.equal(m.useZaicodeGatedNow(() => 60000), state.wall);
    assert.equal(m.zaicodeNowBucketChanged(59000, 60000, 60000), true);
    assert.equal(m.zaicodeNowBucketChanged(60000, 61000, 60000), false);
  });
});
