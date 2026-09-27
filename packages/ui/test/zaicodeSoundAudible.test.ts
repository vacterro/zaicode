import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_SOUND_ECHO_DEFER_MS,
  playZaicodeSound,
  registerZaicodeSoundAudible,
  registerZaicodeSoundPlayer,
} from "../src/zaicode/zaicodeSoundBus.js";

// SRC-060 review: the Orchestra fires its hover and typing voices on every
// pointer move and key press, and both are off by default. A voice nobody
// hears must not count as "a sound just played", or it silences the notice or
// window sound that follows (echoes are dropped within 700 ms of a direct one).

test("a switched-off voice does not silence the echo that follows it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const played: string[] = [];
  registerZaicodeSoundPlayer((id) => played.push(id));
  registerZaicodeSoundAudible((id) => id !== "ui.hover");
  playZaicodeSound("ui.hover");
  playZaicodeSound("ui.toast", { echo: true });
  t.mock.timers.tick(ZAICODE_SOUND_ECHO_DEFER_MS);
  assert.deepEqual(played, ["ui.toast"]);
});

test("an audible direct sound still swallows its own echo", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 2_000_000 });
  const played: string[] = [];
  registerZaicodeSoundPlayer((id) => played.push(id));
  registerZaicodeSoundAudible(() => true);
  playZaicodeSound("audit.start");
  playZaicodeSound("ui.dialogOpen", { echo: true });
  t.mock.timers.tick(ZAICODE_SOUND_ECHO_DEFER_MS);
  assert.deepEqual(played, ["audit.start"]);
});

// SRC-061: "нажатие на problip ... 2 звука на втором щелке, а правый клик
// всегда 2 звука спавнит". React opens / closes the panel inside the click
// (or right-click) handler, so the panel's echo was asked for BEFORE the
// document listener played the click's own sound, and both were heard.
test("an echo asked for before the click's own sound yields to it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 3_000_000 });
  const played: string[] = [];
  registerZaicodeSoundPlayer((id) => played.push(id));
  registerZaicodeSoundAudible(() => true);
  playZaicodeSound("ui.dialogOpen", { echo: true }); // the panel opened inside the handler
  t.mock.timers.tick(1);
  playZaicodeSound("ui.contextMenu"); // then the document listener
  t.mock.timers.tick(ZAICODE_SOUND_ECHO_DEFER_MS);
  assert.deepEqual(played, ["ui.contextMenu"]);
});

test("an echo with no action behind it still plays, a moment later", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 4_000_000 });
  const played: string[] = [];
  registerZaicodeSoundPlayer((id) => played.push(id));
  registerZaicodeSoundAudible(() => true);
  playZaicodeSound("ui.toast", { echo: true });
  assert.deepEqual(played, [], "not at once");
  t.mock.timers.tick(ZAICODE_SOUND_ECHO_DEFER_MS);
  assert.deepEqual(played, ["ui.toast"]);
});
