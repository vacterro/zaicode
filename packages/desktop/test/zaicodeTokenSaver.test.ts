import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ZaicodeRouterCall, ZaicodeRouterResponse } from "@zcode/shared";
import {
  ZAICODE_TOKEN_SAVER_VERSION,
  applyZaicodeTokenSaverDefaults,
  zaicodeTokenSaverPatch,
} from "../src/main/zaicodeRouterSetup.js";
import { callZaicodeRouterInternal, setZaicodeRouterTarget } from "../src/main/zaicodeRouterTransport.js";
import { ZaicodeRouterProcess } from "../src/main/zaicodeRouterProcess.js";

// SRC-061: "CAVEMAN и другие, которые НЕ НАНОСЯТ УЩЕРБА логике ... частью
// ZAICODE по умолчанию". RTK and Caveman lite go on once; Ponytail (changes
// what gets built) and Headroom (needs its own service) are left alone; the
// operator's later choices are never overwritten.

function fakeRouter(settings: Record<string, unknown>, accept = true) {
  const calls: ZaicodeRouterCall[] = [];
  const call = async (request: ZaicodeRouterCall): Promise<ZaicodeRouterResponse> => {
    calls.push(request);
    if (request.method === "GET") return { ok: true, status: 200, data: { ...settings }, message: "" };
    if (!accept) return { ok: false, status: 404, data: null, message: "not found" };
    Object.assign(settings, request.body as object);
    return { ok: true, status: 200, data: { ...settings }, message: "" };
  };
  return { call, calls, settings };
}

test("the patch turns on RTK and Caveman lite and never touches Ponytail", () => {
  assert.deepEqual(zaicodeTokenSaverPatch({ rtkEnabled: false, cavemanEnabled: false, ponytailEnabled: false }), {
    rtkEnabled: true,
    cavemanEnabled: true,
    cavemanLevel: "lite",
  });
  // A Caveman level the operator already runs is kept; nothing is switched off.
  assert.deepEqual(zaicodeTokenSaverPatch({ rtkEnabled: true, cavemanEnabled: true, cavemanLevel: "ultra", ponytailEnabled: true }), {});
});

test("applied once: afterwards the operator's own settings stay", async () => {
  const router = fakeRouter({ rtkEnabled: false, cavemanEnabled: false });
  const first = await applyZaicodeTokenSaverDefaults(router.call, 0);
  assert.equal(first.step.status, "fixed");
  assert.equal(first.appliedVersion, ZAICODE_TOKEN_SAVER_VERSION);
  assert.equal(router.settings.cavemanLevel, "lite");
  // The operator switches Caveman off in 9router; the next start leaves it off.
  router.settings.cavemanEnabled = false;
  router.calls.length = 0;
  const again = await applyZaicodeTokenSaverDefaults(router.call, first.appliedVersion);
  assert.equal(again.step.status, "ok");
  assert.deepEqual(router.calls, [], "not even read");
  assert.equal(router.settings.cavemanEnabled, false);
});

test("an older 9router that refuses the settings does not fail the setup", async () => {
  const router = fakeRouter({}, false);
  const result = await applyZaicodeTokenSaverDefaults(router.call, 0);
  assert.equal(result.step.status, "skipped");
  assert.equal(result.appliedVersion, 0, "tried again next start");
});

// Against a real 9router when its package is on this machine (ZAICODE_ROUTER_PACKAGE).
const packageDir = process.env.ZAICODE_ROUTER_PACKAGE;
const real = packageDir && existsSync(join(packageDir, "app", "server.js")) ? packageDir : null;
const PORT = 20151;
const dataDir = mkdtempSync(join(tmpdir(), "zaicode-token-saver-"));
let server: ZaicodeRouterProcess | null = null;

before(async () => {
  if (!real) return;
  server = new ZaicodeRouterProcess({ execPath: process.execPath, packageDir: real, dataDir, port: PORT, logFile: join(dataDir, "router.log") });
  await server.start();
  setZaicodeRouterTarget({ url: `http://127.0.0.1:${PORT}`, dataDir });
});

after(() => {
  server?.stop();
  setZaicodeRouterTarget(null);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // the server may still hold its files for a moment
  }
});

test("a real 9router takes the defaults through its own settings API", { skip: real ? false : "no 9router package (ZAICODE_ROUTER_PACKAGE)" }, async () => {
  const result = await applyZaicodeTokenSaverDefaults(callZaicodeRouterInternal, 0);
  assert.notEqual(result.step.status, "failed", result.step.detail);
  const read = await callZaicodeRouterInternal({ method: "GET", path: "/api/settings" });
  const settings = read.data as Record<string, unknown>;
  assert.equal(settings.rtkEnabled, true);
  assert.equal(settings.cavemanEnabled, true);
  assert.equal(settings.cavemanLevel, "lite");
  assert.notEqual(settings.ponytailEnabled, true);
});
