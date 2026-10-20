import assert from "node:assert/strict";
import test from "node:test";
import type { IPlatformService } from "@zcode/shared";
import { loadZaicodeSystemFonts } from "../src/zaicode/ZaicodeFontSelect.js";

const provider = (listZaicodeSystemFonts?: () => Promise<string[]>): IPlatformService =>
  ({ listZaicodeSystemFonts }) as IPlatformService;

test("system fonts use the injected platform and retain its method receiver", async () => {
  const platform = provider(async function (this: IPlatformService) {
    assert.strictEqual(this, platform);
    return ["Arial", "Verdana"];
  });
  assert.deepEqual(await loadZaicodeSystemFonts(platform), ["Arial", "Verdana"]);
});

test("two pickers share the request only within the same platform", async () => {
  let requests = 0;
  const first = provider(async () => { requests += 1; return ["First platform face"]; });
  const second = provider(async () => ["Second platform face"]);
  const left = loadZaicodeSystemFonts(first);
  const right = loadZaicodeSystemFonts(first);
  assert.strictEqual(left, right);
  assert.deepEqual(await left, ["First platform face"]);
  assert.deepEqual(await loadZaicodeSystemFonts(first), ["First platform face"]);
  assert.equal(requests, 1);
  assert.deepEqual(await loadZaicodeSystemFonts(second), ["Second platform face"]);
});

test("missing native capability has no installed choices", async () => {
  assert.deepEqual(await loadZaicodeSystemFonts(provider()), []);
});

test("empty and rejected font lists permit a later retry", async () => {
  let requests = 0;
  const platform = provider(async () => {
    requests += 1;
    if (requests === 1) throw new Error("native enumeration unavailable");
    return requests === 2 ? [] : ["Recovered native face"];
  });
  assert.deepEqual(await loadZaicodeSystemFonts(platform), []);
  assert.deepEqual(await loadZaicodeSystemFonts(platform), []);
  assert.deepEqual(await loadZaicodeSystemFonts(platform), ["Recovered native face"]);
  assert.equal(requests, 3);
});

test("a synchronous native exception remains an unavailable list and permits retry", async () => {
  let requests = 0;
  const platform = provider(() => {
    requests += 1;
    if (requests === 1) throw new Error("bridge unavailable");
    return Promise.resolve(["Recovered native face"]);
  });
  assert.deepEqual(await loadZaicodeSystemFonts(platform), []);
  assert.deepEqual(await loadZaicodeSystemFonts(platform), ["Recovered native face"]);
});
