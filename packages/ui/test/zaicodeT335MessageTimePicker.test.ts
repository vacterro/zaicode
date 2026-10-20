import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as messageTime from "../src/v4/messageTimeLabel.js";
import { ZaicodeTimePicker } from "../src/zaicode/ZaicodeTimeFields.js";
import { zaicodeNowBucketChanged } from "../src/zaicode/zaicodeNowGate.js";

const sent = new Date(2026, 9, 14, 6, 20).getTime();
const intl = {
  formatMessage: (_: { id: string }, values?: Record<string, string | number>) =>
    `Yesterday ${values?.time}`,
};

test("T-335: elapsed display buckets align with send time, retaining the wall-clock default", () => {
  const sentBetweenMinutes = sent + 37_000;
  assert.equal(
    zaicodeNowBucketChanged(
      sentBetweenMinutes + 179_000,
      sentBetweenMinutes + 180_000,
      60_000,
      sentBetweenMinutes,
    ),
    true,
  );
  assert.equal(
    zaicodeNowBucketChanged(
      sentBetweenMinutes + 150_000,
      sentBetweenMinutes + 151_000,
      60_000,
      sentBetweenMinutes,
    ),
    false,
  );
  assert.equal(zaicodeNowBucketChanged(59_000, 60_000, 60_000), true);
});
const elapsed = (timestamp: number, locale: string, now: number) =>
  (
    messageTime as unknown as {
      formatMessageElapsedLabel: (timestamp: number, locale: string, now: number) => string | null;
    }
  ).formatMessageElapsedLabel(timestamp, locale, now);

test("T-335: elapsed time ages from the original send time across remounts", () => {
  assert.equal(elapsed(sent, "en-US", sent + 120_000), "2 min. ago");
  assert.equal(elapsed(sent, "en-US", sent + 3_600_000), "1 hr. ago");
  assert.equal(elapsed(sent, "en-US", sent + 172_800_000), "2 days ago");
  assert.equal(messageTime.formatMessageTimeLabel(sent, "en-GB", intl, sent + 120_000), "06:20");
});

test("T-335: unknown timestamps never become a fabricated current message", () => {
  for (const bad of [0, -1, NaN, Infinity, 1e20]) assert.equal(elapsed(bad, "en-US", sent), null);
  assert.equal(elapsed(sent, "en-US", NaN), null);
});

test("T-335: clock skew is clamped and sub-minute ages stay informative", () => {
  assert.equal(elapsed(sent, "en-US", sent - 60_000), "now");
  assert.equal(elapsed(sent, "en-US", sent + 30_000), "30 sec. ago");
});

test("T-335: elapsed labels follow the interface language", () => {
  assert.match(elapsed(sent, "ru-RU", sent + 120_000)!, /2.*назад/);
  assert.match(elapsed(sent, "et-EE", sent + 120_000)!, /2.*eest/);
  assert.match(elapsed(sent, "ded", sent + 120_000)!, /2.*назад/);
});

test("T-335: picker exposes every hour, minute stop and explicit commit/cancel", () => {
  const html = renderToStaticMarkup(
    createElement(ZaicodeTimePicker, { minute: 23 * 60 + 55, onCommit() {}, onDismiss() {} }),
  );
  assert.equal((html.match(/data-zaicode-time-picker-hour=/g) ?? []).length, 24);
  assert.equal((html.match(/data-zaicode-time-picker-minute=/g) ?? []).length, 12);
  assert.match(html, /aria-label="Hour 23" aria-pressed="true"/);
  assert.match(html, /aria-label="Minute 55" aria-pressed="true"/);
  assert.match(html, /data-zaicode-time-picker-done/);
  assert.match(html, /data-zaicode-time-picker-cancel/);
});
