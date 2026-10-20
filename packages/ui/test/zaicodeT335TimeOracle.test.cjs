// Native SAIPEN regression oracle: only Node 24 builtins, with no package installation in copied subjects.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { stripTypeScriptTypes } = require("node:module");
const path = require("node:path");
const test = require("node:test");

async function loadPure(relative, clock = false) {
  let source = readFileSync(path.resolve(__dirname, relative), "utf8");
  if (clock) {
    // The pure clock export does not execute React hooks. Remove only the one unused runtime import.
    const reactImport = /^import \{[^\n]+\} from "react";\r?\n/gm;
    assert.equal([...source.matchAll(reactImport)].length, 1, "pin the pure-module projection");
    source = source.replace(reactImport, "");
  }
  const js = stripTypeScriptTypes(source, { mode: "strip" });
  return import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
}
const modules = Promise.all([
  loadPure("../src/v4/messageTimeLabel.ts"),
  loadPure("../src/zaicode/zaicodeNowGate.ts", true),
]);
const stamp = new Date(2026, 9, 14, 6, 20, 37).getTime();

test("persisted send time ages correctly after remount and over day boundaries", async () => {
  const [time] = await modules;
  for (const [offset, expected] of [
    [120_000, "2 min. ago"],
    [3_600_000, "1 hr. ago"],
    [172_800_000, "2 days ago"],
  ]) {
    assert.equal(time.formatMessageElapsedLabel(stamp, "en-US", stamp + offset), expected);
  }
});

test("unknown time is omitted and future clock skew never makes a negative age", async () => {
  const [time] = await modules;
  for (const invalid of [0, -1, NaN, Infinity, 1e20])
    assert.equal(time.formatMessageElapsedLabel(invalid, "en-US", stamp), null);
  assert.equal(time.formatMessageElapsedLabel(stamp, "en-US", NaN), null);
  assert.equal(time.formatMessageElapsedLabel(stamp, "en-US", stamp - 60_000), "now");
});

test("localized age stays informative below a minute", async () => {
  const [time] = await modules;
  assert.equal(time.formatMessageElapsedLabel(stamp, "en-US", stamp + 30_000), "30 sec. ago");
  assert.match(time.formatMessageElapsedLabel(stamp, "et-EE", stamp + 120_000), /2.*eest/);
  assert.match(time.formatMessageElapsedLabel(stamp, "ru-RU", stamp + 120_000), /2.*назад/);
  assert.match(time.formatMessageElapsedLabel(stamp, "ded", stamp + 120_000), /2.*назад/);
});

test("the display changes exactly on its message-age minute boundary", async () => {
  const [, clock] = await modules;
  assert.equal(
    clock.zaicodeNowBucketChanged(stamp + 179_000, stamp + 180_000, 60_000, stamp),
    true,
  );
  assert.equal(
    clock.zaicodeNowBucketChanged(stamp + 150_000, stamp + 151_000, 60_000, stamp),
    false,
  );
});

test("existing wall-clock consumers retain their original default buckets", async () => {
  const [, clock] = await modules;
  assert.equal(clock.zaicodeNowBucketChanged(59_000, 60_000, 60_000), true);
  assert.equal(clock.zaicodeNowBucketChanged(60_000, 61_000, 60_000), false);
});
