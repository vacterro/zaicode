import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ZAICODE_PROTRAIL_INPUT_CS } from "../src/main/zaicodeProtrailInputSource.js";

// SRC-062: ProTrail "must work fully, not only inside the program but globally
// in Windows". The desktop app draws over every monitor with click-through
// overlays and reads the mouse like ProTrail: Raw Input, never a hook. These
// pin that contract; the live check is on Windows (see the T-### evidence).

const main = (name: string) => readFileSync(join(import.meta.dirname, "../src/main", name), "utf8");

test("the input helper is ProTrail's Raw Input sink, and compiles with Windows' own C# 5 compiler", () => {
  const cs = ZAICODE_PROTRAIL_INPUT_CS;
  assert.match(cs, /RIDEV_INPUTSINK = 0x00000100/);
  assert.match(cs, /cp\.Parent = new IntPtr\(-3\)/, "a message-only window");
  assert.match(cs, /GetCursorPos/);
  assert.doesNotMatch(cs, /SetWindowsHookEx|GetAsyncKeyState|GetKeyState/, "no hook, no key polling: input is never delayed or read beyond the mouse");
  assert.doesNotMatch(cs, /\$"|\?\.|=> /, "C# 5 only: no interpolation, no ?. , no expression bodies");
  // Every left/right/middle transition of a packet, in ProTrail's flag order.
  assert.match(cs, /Button\(flags, 0x01, 0x02, 0, p, t\);\s+Button\(flags, 0x04, 0x08, 2, p, t\);\s+Button\(flags, 0x10, 0x20, 1, p, t\);/);
  assert.match(cs, /WatchParent/, "stdin closing ends the helper");
  assert.match(cs, /PENDING_LIMIT/, "a stalled reader drops events instead of blocking the mouse");
});

test("the helper is compiled once per source version and falls back to cursor polling", () => {
  const input = main("zaicodeProtrailInput.ts");
  assert.match(input, /Framework64/);
  assert.match(input, /\/target:winexe/);
  assert.match(input, /createHash\("sha256"\)\.update\(ZAICODE_PROTRAIL_INPUT_CS\)/);
  assert.match(input, /windowsHide: true/);
  assert.match(input, /getCursorScreenPoint/);
});

test("one click-through, never-focused, always-on-top overlay per monitor", () => {
  const global = main("zaicodeProtrailGlobal.ts");
  for (const option of ["transparent: true", "focusable: false", "skipTaskbar: true", "frame: false", "backgroundThrottling: false", "sandbox: true"]) {
    assert.ok(global.includes(option), option);
  }
  assert.match(global, /setIgnoreMouseEvents\(true\)/);
  assert.match(global, /setAlwaysOnTop\(true, "screen-saver"\)/);
  assert.match(global, /showInactive\(\)/);
  assert.match(global, /screen\.getAllDisplays\(\)/);
  assert.match(global, /"display-added"[\s\S]*"display-removed"[\s\S]*"display-metrics-changed"/);
  assert.match(global, /screenToDipPoint/, "Raw Input pixels become the overlays' DIP coordinates");
  assert.match(global, /sender\.once\("destroyed"/, "the overlays die with the ZAICODE window");
  assert.match(global, /app\.on\("will-quit", stop\)/);
});

test("overlays are never taken for the ZAICODE window", () => {
  assert.match(main("index.ts"), /!isZaicodeSplashWindow\(win\) &&\s+!isZaicodeProtrailWindow\(win\)/);
  assert.match(main("zaicodeGlobalHotkeys.ts"), /!isZaicodeProtrailWindow\(window\)/);
  assert.match(main("desktopMainIpcPlatform.ts"), /registerZaicodeProtrailGlobalIpc\(\);/);
});

test("the overlay page and its preload are part of the build", () => {
  const root = join(import.meta.dirname, "..");
  assert.match(readFileSync(join(root, "vite.config.ts"), "utf8"), /"zaicode-protrail": resolve\(__dirname, "src\/renderer\/zaicode-protrail\.html"\)/);
  assert.match(readFileSync(join(root, "tsup.config.ts"), "utf8"), /"preload\/zaicodeProtrailOverlay": "src\/preload\/zaicodeProtrailOverlay\.ts"/);
  const page = readFileSync(join(root, "src/renderer/zaicode-protrail.html"), "utf8");
  assert.match(page, /pointer-events: none/);
  assert.match(page, /background: transparent/);
});
