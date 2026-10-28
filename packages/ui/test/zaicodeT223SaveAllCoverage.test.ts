// T-223 / SRC-153:R004 -- Save All covers every durable UI family incl ProTrail.
//
// Save All = captureZaicodeSettingsSnapshot() (renderer allowlist) + one atomic
// main-process write; reads go through readZaicodeSetting (explicit local value
// > bundled snapshot default > null). This suite pins the contract:
// every intended family round-trips (a deliberately omitted family fails),
// factory Motion Wake is OFF with user > snapshot > factory precedence,
// secrets and ephemeral state cannot leak (capture emits allowlist keys only),
// and a failed capture never produces a snapshot to save.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import bundledDefaults from "../src/zaicode/zaicodeSettingsDefaults.json" with { type: "json" };
import test from "node:test";
import {
  ZAICODE_SAVE_ALL_SETTING_KEYS,
  captureZaicodeSettingsSnapshot,
  readZaicodeSetting,
} from "../src/zaicode/zaicodeSettingsSnapshot.js";
import { protrailDefaults } from "../src/zaicode/protrail/protrailModel.js";
import { normalizeProtrailConfig } from "../src/zaicode/protrail/protrailNormalize.js";

/** The durable families Save All must carry. Extend deliberately, never silently. */
const EXPECTED_FAMILIES = [
  "zaicode-ui-prefs-v1",
  "zaicode-sidebar-prefs-v1",
  "zaicode-project-folders-v1",
  "zaicode-diamonds-v1",
  "zaicode-profiles",
  "zaicode-cues-v1",
  "zaicode-icon-overrides",
  "zaicode-audio-v1",
  "zaicode-palette",
  "zaicode-crisp",
  "zaicode-bevels",
  "zaicode-bevel-rows",
  "zaicode-font-settings",
  "zaicode-list-label-width",
  "zaicode-default-model",
  "zaicode-auto-session-title",
  "zaicode-help-hidden",
  "zaicode-sound-events-v1",
  "zaicode-sound-custom-names",
  "zaicode-fancyzones-settings",
  "zaicode-limit-meter-style",
  "zaicode-meter-prefs-v1",
  "zaicode-workers-prefs-v1",
  "zaicode-layout-v1",
  "zaicode-hotkeys-v1",
  "zaicode-notifications-v1",
  "zaicode-timer-prefs-v1",
  "zaicode-sound-picker-v1",
  "zaicode-color-studio-v1",
  "zaicode-avatar-uploads",
  "zaicode-saipen-log-order-v1",
  "zaicode-saipen-ticket-order-v1",
  "zaicode-lights-v1",
  "zaicode-model-appearance-v1",
  "zaicode-lights-presets-v1",
  "zaicode-composer-prefs-v1",
  "zaicode-saiasui-settings-v1",
  "zaicode-protrail-v1",
  "zaicode-auto-continue-v1",
  "zaicode-auto-goal-v1",
  "zaicode-autostart-v1",
  "zaicode-change-floaters-v1",
  "zaicode-dispatch-prefs-v1",
  "zaicode-engine-bar-v1",
  "zaicode-header-title-v1",
  "zaicode-home-v1",
  "zaicode-icon-profiles-v1",
  "zaicode-size",
  "zaicode-presentation",
  "zaicode-active-engine",
  "zaicode-scheduler-marks-v1",
  "zaicode-session-text-v1",
  "zaicode-session-text-presets-v1",
  "zaicode-saipeggle-v1",
  "zaicode-presets-v1",
];

function assertCoversAllFamilies(keys: readonly string[]): void {
  const missing = EXPECTED_FAMILIES.filter((family) => !keys.includes(family));
  assert.deepEqual(missing, []);
  const extra = [...keys].filter((key) => !EXPECTED_FAMILIES.includes(key));
  assert.deepEqual(extra, []);
}

function withLocalStorage(values: Map<string, string>, run: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null },
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

test("T-223: Save All covers every durable family, including ProTrail", () => {
  assertCoversAllFamilies(ZAICODE_SAVE_ALL_SETTING_KEYS);
});

test("T-223 RED-control: omitting a durable family fails the coverage check", () => {
  const withoutProtrail = ZAICODE_SAVE_ALL_SETTING_KEYS.filter((k) => k !== "zaicode-protrail-v1");
  assert.throws(() => assertCoversAllFamilies(withoutProtrail), /zaicode-protrail-v1/);
});

function mockLocalStorage(values: Map<string, string>): PropertyDescriptor | undefined {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null },
  });
  return previous;
}

function restoreLocalStorage(previous: PropertyDescriptor | undefined): void {
  if (previous) Object.defineProperty(globalThis, "localStorage", previous);
  else Reflect.deleteProperty(globalThis, "localStorage");
}

test("T-223: ProTrail round-trips through the snapshot byte-identical", async () => {
  const protrail = JSON.stringify({
    ...JSON.parse(JSON.stringify(protrailDefaults())),
    click: { ...protrailDefaults().click, holdWakeEnabled: true },
  });
  const values = new Map<string, string>([
    ["zaicode-protrail-v1", protrail],
    ["zaicode-ui-prefs-v1", JSON.stringify({ showGreeting: false })],
  ]);
  const previous = mockLocalStorage(values);
  try {
    const snapshot = JSON.parse(await captureZaicodeSettingsSnapshot()) as {
      version: number;
      settings: Record<string, string>;
    };
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.settings["zaicode-protrail-v1"], protrail);
  } finally {
    restoreLocalStorage(previous);
  }
});

test("T-223: factory Motion Wake default is OFF", () => {
  assert.equal(protrailDefaults().click.holdWakeEnabled, false);
  assert.equal(normalizeProtrailConfig(null).click.holdWakeEnabled, false);
  assert.equal(normalizeProtrailConfig(undefined).click.holdWakeEnabled, false);
});

test("T-223: explicit user choice beats snapshot beats factory", () => {
  const userOn = normalizeProtrailConfig({ click: { holdWakeEnabled: true } });
  assert.equal(userOn.click.holdWakeEnabled, true);
  const userOff = normalizeProtrailConfig({
    click: { ...protrailDefaults().click, holdWakeEnabled: false },
  });
  assert.equal(userOff.click.holdWakeEnabled, false);
  withLocalStorage(new Map([["zaicode-bevel-rows", "0"]]), () => {
    assert.equal(readZaicodeSetting("zaicode-bevel-rows"), "0");
  });
  withLocalStorage(new Map(), () => {
    // With no explicit value the reader falls through to the SHIPPED snapshot.
    // Compare against the shipped value rather than pinning it: this test is about
    // precedence (user > snapshot > factory), and the shipped default is a build
    // input that other waves deliberately change (T-225 moved bevel rows to "0").
    assert.equal(readZaicodeSetting("zaicode-bevel-rows"), bundledDefaults.settings["zaicode-bevel-rows"]);
  });
  withLocalStorage(
    new Map([["zaicode-protrail-v1", JSON.stringify({ click: { holdWakeEnabled: true } })]]),
    () => {
      const stored = readZaicodeSetting("zaicode-protrail-v1");
      assert.ok(stored !== null);
      assert.equal(normalizeProtrailConfig(JSON.parse(stored)).click.holdWakeEnabled, true);
    },
  );
});

test("T-223: secrets and ephemeral state cannot leak through the snapshot", async () => {
  const values = new Map<string, string>([
    ["zaicode-ui-prefs-v1", JSON.stringify({ showGreeting: false })],
    ["zaicode-main-sessions-v1", "session-id"],
    ["zaicode-timers-v1", JSON.stringify({ timers: [{ id: "live" }] })],
    ["zaicode-evil-token", "secret-token"],
    ["token", "secret-token"],
    ["sai-accounts", JSON.stringify({ apiKey: "secret" })],
  ]);
  const previous = mockLocalStorage(values);
  try {
    const snapshot = JSON.parse(await captureZaicodeSettingsSnapshot()) as {
      settings: Record<string, string>;
    };
    for (const key of Object.keys(snapshot.settings)) {
      assert.ok(
        (ZAICODE_SAVE_ALL_SETTING_KEYS as readonly string[]).includes(key),
      );
    }
    for (const forbidden of [
      "zaicode-main-sessions-v1",
      "zaicode-timers-v1",
      "zaicode-evil-token",
      "token",
      "sai-accounts",
    ]) {
      assert.equal(snapshot.settings[forbidden], undefined);
    }
    for (const key of ZAICODE_SAVE_ALL_SETTING_KEYS) {
      assert.doesNotMatch(
        key,
        /token|secret|credential|password|api[_-]?key|session[_-]?id|private|auth/i,
      );
    }
    assert.ok(!ZAICODE_SAVE_ALL_SETTING_KEYS.includes("zaicode-timers-v1"));
    assert.ok(!ZAICODE_SAVE_ALL_SETTING_KEYS.includes("zaicode-main-sessions-v1"));
  } finally {
    restoreLocalStorage(previous);
  }
});

test("T-223: a failed capture never produces a snapshot to save", () => {
  const section = readFileSync(
    join(import.meta.dirname, "..", "src", "settings", "ZaicodeSettingsSection.tsx"),
    "utf8",
  );
  const blockStart = section.indexOf("data-zaicode-save-settings");
  assert.ok(blockStart >= 0);
  const block = section.slice(blockStart, section.indexOf("</section>", blockStart));
  const captureAt = block.indexOf("captureZaicodeSettingsSnapshot()");
  const saveAt = block.indexOf("platform.saveZaicodeSettingsSnapshot!");
  assert.ok(captureAt >= 0 && saveAt > captureAt);
  const failBranch = block.slice(block.indexOf(".catch(", saveAt));
  assert.doesNotMatch(failBranch, /saveZaicodeSettingsSnapshot/);
});

// T-227 / HUNT-002: an allowlisted family must also be DELIVERABLE. Save All
// captures every allowlist key through readZaicodeSetting, so the family's own
// reader has to consult the same accessor; a reader on raw localStorage makes
// the captured release default unreachable and the allowlist entry a lie.
test("T-227: a captured Save All family reaches its own reader", async () => {
  const seeded = JSON.stringify([
    { id: "profile-probe", name: "Probe", savedAt: 1, overrides: {} },
  ]);
  const previous = bundledDefaults.settings["zaicode-icon-profiles-v1"];
  bundledDefaults.settings["zaicode-icon-profiles-v1"] = seeded;
  try {
    const { readZaicodeIconProfiles } = await import("../src/zaicode/zaicodeIconSlots.js");
    assert.equal(
      readZaicodeIconProfiles().length,
      1,
      "the captured release default must reach the icon-profile reader",
    );
  } finally {
    if (previous === undefined) delete bundledDefaults.settings["zaicode-icon-profiles-v1"];
    else bundledDefaults.settings["zaicode-icon-profiles-v1"] = previous;
  }
});

test("T-227: no allowlisted family reads raw localStorage past the accessor", () => {
  const sites: Array<[string, string]> = [
    ["zaicodeIconSlots.tsx", "localStorage.getItem(PROFILES_KEY)"],
    ["ZaicodeSaipenSidePane.tsx", "localStorage.getItem(LOG_ORDER_KEY)"],
    ["ZaicodeSaipenSidePane.tsx", "localStorage.getItem(TICKET_ORDER_KEY)"],
  ];
  for (const [file, needle] of sites) {
    const source = readFileSync(
      fileURLToPath(new URL(`../src/zaicode/${file}`, import.meta.url)),
      "utf8",
    );
    assert.ok(
      !source.includes(needle),
      `${file} must read its family through readZaicodeSetting, not ${needle}`,
    );
  }
});
