import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  isZaicodeAutoRetryStopped,
  stopZaicodeAutoRetryForError,
} from "../src/zaicode/zaicodeAutoRetry.js";

/**
 * A notification the operator cannot close (SRC-070 item D).
 *
 * The auto-retry notice had no close control at all, its only "Stop" button
 * was rendered only while the countdown ran, and closing the parent banner
 * hid that button without stopping the retry. Separately, a dismissed toast
 * was resurrected by the next poll of the same keyed source, which made the
 * notice impossible to get rid of.
 */

test("D1 stopping the retry for an error is recorded and survives a remount", () => {
  assert.equal(isZaicodeAutoRetryStopped("err-1"), false);
  stopZaicodeAutoRetryForError("err-1");
  assert.equal(isZaicodeAutoRetryStopped("err-1"), true, "a fresh pane still sees it as stopped");
});

test("D2 stopping one error does not silence the next one", () => {
  stopZaicodeAutoRetryForError("err-a");
  assert.equal(isZaicodeAutoRetryStopped("err-b"), false, "a genuinely new error arms the retry again");
  assert.equal(isZaicodeAutoRetryStopped("err-a"), true);
});

test("D3 an absent error key stops nothing", () => {
  stopZaicodeAutoRetryForError(null);
  stopZaicodeAutoRetryForError(undefined);
  stopZaicodeAutoRetryForError("");
  assert.equal(isZaicodeAutoRetryStopped(null), false);
});

test("D4 the stopped-key ring is bounded", () => {
  for (let index = 0; index < 80; index += 1) stopZaicodeAutoRetryForError(`ring-${index}`);
  assert.equal(isZaicodeAutoRetryStopped("ring-79"), true, "the newest is kept");
  assert.equal(isZaicodeAutoRetryStopped("ring-0"), false, "the oldest ages out");
});

test("D5 the notice has a real close control in every state it can be in", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/zaicode/ZaicodeAutoRetryNotice.tsx"), "utf8");
  assert.match(source, /data-zaicode-auto-retry-close/);
  assert.match(source, /aria-label="Close this notice and stop auto-retry for this error"/);
  // The close must stop the retry and hide the notice, not mute the event.
  assert.match(source, /const close = \(\) => \{\s*state\.stop\(\);\s*setClosed\(true\);/);
  assert.match(source, /if \(closed\) return null;/);
  // A native button gives Enter and Space activation for free.
  assert.match(source, /<button\s+type="button"[\s\S]{0,320}?onClick=\{close\}/);
});

test("D6 Stop is reachable whenever a retry is live, not only during the countdown", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/zaicode/ZaicodeAutoRetryNotice.tsx"), "utf8");
  assert.equal(source.includes("{state.nextAt ? (\n          <button"), false, "Stop must not be gated on the countdown");
  assert.match(source, /\{state\.available \? \(\s*<button[\s\S]{0,320}?onClick=\{state\.stop\}/);
});

test("D7 closing the composer error banner stops the retry behind it", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/v4/SessionPane.tsx"), "utf8");
  const dismiss = source.match(/const handleDismissComposerError[\s\S]{0,1200}?\n  \}, \[/);
  assert.ok(dismiss, "the banner dismiss handler exists");
  assert.match(dismiss[0], /stopZaicodeAutoRetryForError\(controlLastErrorKey\)/);
});

test("D8 a dismissed card is not resurrected by the same source, and the ring is bounded", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/zaicode/zaicodeNotifications.ts"), "utf8");
  assert.match(source, /DISMISSED_KEY_LIMIT = 40/);
  assert.match(source, /isDismissed: \(key\) => Boolean\(key\) && dismissedKeys\.includes\(key!\)/);
  assert.match(source, /rememberDismissed\(get\(\)\.toasts\.find\(\(toast\) => toast\.id === id\)\?\.key\)/);
  assert.match(source, /if \(input\.key && useZaicodeToasts\.getState\(\)\.isDismissed\(input\.key\)\) return null;/);
  // The source event itself still fires its system notification above that line.
  const push = source.match(/if \(channels\.system\)[\s\S]{0,600}?isDismissed\(input\.key\)/);
  assert.ok(push, "the system channel runs before the card is suppressed");
});

test("D9 the toast close control is a keyboard-reachable button with a real target", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/zaicode/ZaicodeToastHost.tsx"), "utf8");
  assert.match(source, /title="Dismiss"[\s\S]{0,200}?aria-label="Dismiss"/);
  assert.match(source, /data-zaicode-toast-close/);
  assert.match(source, /size-6 items-center justify-center/, "a 24px hit target, not 16px");
  assert.match(source, /<X className="size-3" aria-hidden="true" \/>/);
});
