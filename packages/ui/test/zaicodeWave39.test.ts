import assert from "node:assert/strict";
import test from "node:test";
import { formatZaicodeReset, formatZaicodeTimeOfDay, readZaicodeHour12, setZaicodeHour12, zaicodeIsoWeek } from "@zcode/shared";
import { isZaicodeCalm, normalizeZaicodeUiPrefs, zaicodeCalmClasses } from "../src/zaicode/zaicodeUiPrefs.js";
import { ZAICODE_CLOCK_DEFAULTS } from "../src/zaicode/zaicodeTimerStore.js";

test("calm interface: off by default, three switches, three <html> classes", () => {
  const defaults = normalizeZaicodeUiPrefs(null);
  assert.deepEqual([defaults.noMotion, defaults.noDim, defaults.noHoverPopups], [false, false, false]);
  const calm = normalizeZaicodeUiPrefs({ noMotion: true, noDim: true, noHoverPopups: true });
  assert.equal(isZaicodeCalm(calm), true);
  assert.equal(isZaicodeCalm({ ...calm, noDim: false }), false);
  assert.deepEqual(zaicodeCalmClasses({ noMotion: true, noDim: false, noHoverPopups: true }), {
    "zaicode-no-motion": true,
    "zaicode-no-dim": false,
    "zaicode-no-popups": true,
  });
  assert.equal(normalizeZaicodeUiPrefs({ noMotion: "yes" }).noMotion, false);
});

test("time of day: 24-hour by default, 12-hour on the switch, seconds optional", () => {
  const evening = new Date(2026, 8, 25, 17, 5, 9);
  const midnight = new Date(2026, 8, 25, 0, 7);
  const noon = new Date(2026, 8, 25, 12, 0);
  assert.equal(formatZaicodeTimeOfDay(evening), "17:05");
  assert.equal(formatZaicodeTimeOfDay(evening, { seconds: true }), "17:05:09");
  assert.equal(formatZaicodeTimeOfDay(evening, { hour12: true }), "5:05 pm");
  assert.equal(formatZaicodeTimeOfDay(midnight, { hour12: true }), "12:07 am");
  assert.equal(formatZaicodeTimeOfDay(noon, { hour12: true, seconds: true }), "12:00:00 pm");
  // The stored clock setting drives every display that does not pass its own choice.
  setZaicodeHour12(true);
  assert.equal(readZaicodeHour12(), true);
  assert.equal(formatZaicodeTimeOfDay(evening), "5:05 pm");
  const now = new Date(2026, 8, 25, 10, 0).getTime();
  assert.match(formatZaicodeReset(new Date(2026, 8, 29, 17, 0).getTime(), now), /^resets \w{3} 5:00 pm$/);
  setZaicodeHour12(false);
  assert.match(formatZaicodeReset(new Date(2026, 8, 29, 17, 0).getTime(), now), /^resets \w{3} 17:00$/);
});

test("ISO week numbers", () => {
  assert.equal(zaicodeIsoWeek(new Date(2026, 8, 25)), 39);
  assert.equal(zaicodeIsoWeek(new Date(2026, 0, 1)), 1);
  assert.equal(zaicodeIsoWeek(new Date(2021, 0, 3)), 53);
  assert.equal(zaicodeIsoWeek(new Date(2024, 11, 30)), 1);
});

test("clock essentials exist and stay off unless chosen", () => {
  assert.deepEqual(
    [ZAICODE_CLOCK_DEFAULTS.hour12, ZAICODE_CLOCK_DEFAULTS.showWeekday, ZAICODE_CLOCK_DEFAULTS.showYear, ZAICODE_CLOCK_DEFAULTS.showWeekNumber, ZAICODE_CLOCK_DEFAULTS.showTimeZone],
    [false, false, false, false, false],
  );
});
