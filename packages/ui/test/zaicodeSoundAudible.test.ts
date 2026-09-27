import assert from "node:assert/strict";
import test from "node:test";
import {
  playZaicodeSound,
  registerZaicodeSoundAudible,
  registerZaicodeSoundPlayer,
} from "../src/zaicode/zaicodeSoundBus.js";

// SRC-060 review: the Orchestra fires its hover and typing voices on every
// pointer move and key press, and both are off by default. A voice nobody
// hears must not count as "a sound just played", or it silences the notice or
// window sound that follows (echoes are dropped within 700 ms of a direct one).

test("a switched-off voice does not silence the echo that follows it", () => {
  const played: string[] = [];
  registerZaicodeSoundPlayer((id) => played.push(id));
  registerZaicodeSoundAudible((id) => id !== "ui.hover");
  playZaicodeSound("ui.hover");
  playZaicodeSound("ui.toast", { echo: true });
  assert.deepEqual(played, ["ui.toast"]);
});

test("an audible direct sound still swallows its own echo", () => {
  const played: string[] = [];
  registerZaicodeSoundPlayer((id) => played.push(id));
  registerZaicodeSoundAudible(() => true);
  playZaicodeSound("audit.start");
  playZaicodeSound("ui.dialogOpen", { echo: true });
  assert.deepEqual(played, ["audit.start"]);
});
