import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * T-291 (SRC-193): the sidebar AUTO button owns a persisted A3-audit opt-out,
 * and right-click opens exactly those settings.
 *
 * R001: AUTO allows persisted opt-out of automatic A3 audit generation while
 * eligible existing project work continues (smartMode untouched).
 * R002: right-clicking the AUTO button opens its settings, including the
 * automatic-audit toggle and the audit cycle limit.
 *
 * Service behavior (admission gate, persistence, manual-still-works) is proven
 * in packages/services/test/zaicodeAudits.test.ts; this file pins the UI
 * wiring so a later refactor cannot silently drop the opt-out or the
 * right-click path.
 */

const uiSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (relative: string) => readFileSync(join(uiSrc, ...relative.split("/")), "utf8");

test("T-291 R002: the AUTO button opens its own settings on right-click", () => {
  const button = read("zaicode/ZaicodeAutoSettings.tsx");
  assert.ok(button.includes("<ZaicodeRightClickSettings"), "AUTO owns a right-click panel");
  assert.ok(button.includes('title="AUTO settings"'), "the panel is titled AUTO settings");
  assert.ok(button.includes("preferenceKey="), "the control registers its right-click key");
  assert.ok(
    button.includes("panel={<ZaicodeAutoSettingsPanel"),
    "right-click shows the AUTO settings panel, not a generic menu",
  );
});

test("T-291 R002: the AUTO panel holds the audit toggle and the cycle limit", () => {
  const panel = read("zaicode/ZaicodeAutoSettings.tsx");
  assert.ok(panel.includes("Run A3 audits after project work"), "automatic-audit toggle present");
  assert.ok(
    panel.includes("Maximum automatic audits per project"),
    "audit cycle limit present",
  );
  assert.ok(panel.includes("setAutoAudits"), "toggle persists through the audit store");
  assert.ok(panel.includes("setMaxCycles"), "cycle limit persists through the audit store");
});

test("T-291 R001: the automatic-admission gate respects the persisted opt-out", () => {
  const service = readFileSync(
    join(uiSrc, "..", "..", "services", "src", "zaicode", "zaicodeAuditService.ts"),
    "utf8",
  );
  assert.ok(
    service.includes("return policy.smartMode && policy.autoAudits && !project.disabled;") &&
      service.includes("if (!stillEnabled(project.workspaceKey)) continue;"),
    "the effective per-project AUTO and audit opt-outs gate automatic admission, including fresh rechecks",
  );
  assert.ok(
    service.includes("autoAudits: enabled"),
    "setAutoAudits persists the exact choice",
  );
  assert.ok(
    service.includes("autoAudits: raw?.autoAudits !== false"),
    "existing profiles default to audits on (opt-out, never forced-off)",
  );
});

test("T-291 R001: opting out of audits never disables ordinary AUTO work", () => {
  const service = readFileSync(
    join(uiSrc, "..", "..", "services", "src", "zaicode", "zaicodeAuditService.ts"),
    "utf8",
  );
  const setAuto = /async setAutoAudits\(enabled: boolean\)[^{]*\{([^}]*)\}/.exec(service);
  assert.ok(setAuto, "setAutoAudits exists");
  assert.ok(!setAuto![1].includes("smartMode"), "opt-out writes only the audit key");
});
