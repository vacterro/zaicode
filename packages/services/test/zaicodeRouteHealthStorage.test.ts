import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ZaicodeRouteHealthStorage } from "../src/zaicode/zaicodeRouteHealthStorage.js";
import {
  recordRouteFailure,
  getRouteHealth,
  resetAllRouteHealth,
  type RouteIdentity,
} from "@zcode/shared";

test("ZaicodeRouteHealthStorage saves and loads route health snapshots atomically", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-route-health-test-"));
  try {
    resetAllRouteHealth();

    // Record route failures to transition circuit state
    const route: RouteIdentity = {
      routerUrl: "http://127.0.0.1:9099",
      comboId: "combo-1",
      modelId: "gpt-4o",
    };
    recordRouteFailure(
      route,
      {
        statusCode: 429,
        code: "rate_limited",
        message: "Rate limit exceeded",
      },
      1000000,
    );
    recordRouteFailure(
      route,
      {
        statusCode: 429,
        code: "rate_limited",
        message: "Rate limit exceeded",
      },
      1001000,
    );
    recordRouteFailure(
      route,
      {
        statusCode: 429,
        code: "rate_limited",
        message: "Rate limit exceeded",
      },
      1002000,
    );

    const stateBefore = getRouteHealth(route, 1002000);
    assert.equal(stateBefore.state, "COOLDOWN");

    const storage = new ZaicodeRouteHealthStorage(tempDir);
    const saveRes = storage.saveSnapshot("default");
    assert.equal(saveRes.success, true);
    assert.ok(saveRes.filePath);
    assert.equal(fs.existsSync(saveRes.filePath!), true);

    // Reset circuit breakers in memory
    resetAllRouteHealth();
    assert.equal(getRouteHealth(route, 1002000).state, "UNKNOWN");

    // Load back while cooldown still active
    const loadRes = storage.loadSnapshot("default", 1002000);
    assert.equal(loadRes.success, true);
    assert.equal(getRouteHealth(route, 1002000).state, "COOLDOWN");

    // Load back after cooldown expired -> recovers to HALF_OPEN (never blindly HEALTHY)
    const afterCooldown = (stateBefore.cooldownUntil ?? 1002000) + 1000;
    const loadAfterCooldown = storage.loadSnapshot("default", afterCooldown);
    assert.equal(loadAfterCooldown.success, true);
    assert.equal(getRouteHealth(route, afterCooldown).state, "HALF_OPEN");
  } finally {
    resetAllRouteHealth();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ZaicodeRouteHealthStorage prevents directory traversal in namespace", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-route-traversal-"));
  try {
    const storage = new ZaicodeRouteHealthStorage(tempDir);
    const result = storage.saveSnapshot("../../../escaped");
    // safeNamespace replaces special characters with underscore so it stays inside storageDir safely
    assert.equal(result.success, true);
    assert.ok(result.filePath?.startsWith(tempDir));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
