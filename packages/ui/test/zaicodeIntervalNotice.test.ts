import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_INTERVAL_DEFAULT_RULE,
  ZAICODE_INTERVAL_PRESETS,
  formatZaicodeIntervalLength,
  zaicodeIntervalNotice,
  zaicodeIntervalWhen,
} from "../src/zaicode/zaicodeIntervalRules.js";

// SRC-061: "interval timer который по часам — чтобы уведомление как раз этот
// сам час и показывал, а не заданный интервал". A clock reminder names the
// time that came; an elapsed one says how long it has been.

test("a clock reminder's notice names the hour, not the interval", () => {
  const rule = { ...ZAICODE_INTERVAL_DEFAULT_RULE, name: "Hourly Reminder", alignMode: "clock" as const, minutes: 60 };
  assert.deepEqual(zaicodeIntervalNotice(rule, new Date(2026, 8, 27, 14, 0)), { title: "It's 14:00", status: "Hourly Reminder" });
  assert.equal(zaicodeIntervalNotice(rule, new Date(2026, 8, 27, 9, 30)).title, "It's 09:30");
});

test("an elapsed reminder says how long it has been", () => {
  const rule = { ...ZAICODE_INTERVAL_DEFAULT_RULE, name: "Stretch", alignMode: "elapsed" as const, minutes: 50 };
  assert.deepEqual(zaicodeIntervalNotice(rule, new Date()), { title: "50 min passed", status: "Stretch" });
  assert.equal(formatZaicodeIntervalLength(60), "1 hour");
  assert.equal(formatZaicodeIntervalLength(90), "1 h 30 min");
  assert.equal(formatZaicodeIntervalLength(120), "2 hours");
});

test("the list says when a rule rings, in clock marks", () => {
  assert.equal(zaicodeIntervalWhen({ alignMode: "clock", minutes: 60 }), "every hour :00");
  assert.equal(zaicodeIntervalWhen({ alignMode: "clock", minutes: 30 }), ":00 :30");
  assert.equal(zaicodeIntervalWhen({ alignMode: "clock", minutes: 15 }), ":00 :15 :30 :45");
  assert.equal(zaicodeIntervalWhen({ alignMode: "clock", minutes: 120 }), "every 2 hours on the clock");
  assert.equal(zaicodeIntervalWhen({ alignMode: "elapsed", minutes: 25 }), "every 25 min");
});

test("every preset makes enabled, well-formed rules", () => {
  assert.ok(ZAICODE_INTERVAL_PRESETS.length >= 10);
  for (const preset of ZAICODE_INTERVAL_PRESETS) {
    const rules = preset.rules();
    assert.ok(rules.length > 0, preset.id);
    for (const rule of rules) {
      assert.ok(rule.enabled && rule.minutes >= 1 && rule.name, `${preset.id}: ${rule.name}`);
      assert.match(rule.sound, /^fastprompter:/);
    }
  }
});
