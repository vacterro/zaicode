import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ZAICODE_SPLASH_OPTIONS,
  normalizeZaicodeSplashOptions,
  zaicodeSplashBootMirror,
  zaicodeSplashPictureRect,
  zaicodeSplashSize,
} from "@zcode/shared";
import {
  parseZaicodeSplashPrefsInput,
  refreshZaicodeCustomSplashPage,
  zaicodeSplashPage,
} from "../src/main/zaicodeSplashFiles.js";

// SRC-060: the first splash was cut off, a grey block came before the app, and
// the Start-up splash settings could not be changed. These pin the parts of the
// fix that do not need a desktop session.

const here = dirname(fileURLToPath(import.meta.url));
const packages = join(here, "..", "..");

test("a large picture is scaled into the box, never drawn at its own size", () => {
  const box = zaicodeSplashSize(1);
  assert.deepEqual(box, { width: 560, height: 300 });
  // 1920x1080 (16:9) into 560x300: the whole picture, bands left and right.
  assert.deepEqual(zaicodeSplashPictureRect({ width: 1920, height: 1080 }, box, "contain"), {
    x: 14,
    y: 0,
    width: 533,
    height: 300,
  });
  // Cover fills the box and crops evenly; stretch fills it exactly.
  const cover = zaicodeSplashPictureRect({ width: 1920, height: 1080 }, box, "cover");
  assert.equal(cover.width, 560);
  assert.ok(cover.height >= 300 && cover.y <= 0);
  assert.deepEqual(zaicodeSplashPictureRect({ width: 100, height: 900 }, box, "stretch"), {
    x: 0,
    y: 0,
    width: 560,
    height: 300,
  });
  // The bundled 560x300 picture at 2x is an exact whole-number scale.
  assert.deepEqual(zaicodeSplashPictureRect({ width: 560, height: 300 }, zaicodeSplashSize(2), "contain"), {
    x: 0,
    y: 0,
    width: 1120,
    height: 600,
  });
});

test("splash options normalize: unknown values fall back to the defaults", () => {
  assert.deepEqual(normalizeZaicodeSplashOptions(null), DEFAULT_ZAICODE_SPLASH_OPTIONS);
  assert.deepEqual(
    normalizeZaicodeSplashOptions({ fit: "zoom", scale: 3, status: "no", holdUntilReady: 1, maxWaitSec: 45 }),
    DEFAULT_ZAICODE_SPLASH_OPTIONS,
  );
  assert.deepEqual(
    normalizeZaicodeSplashOptions({ fit: "cover", scale: 1.5, status: false, holdUntilReady: false, maxWaitSec: 90 }),
    { fit: "cover", scale: 1.5, status: false, holdUntilReady: false, maxWaitSec: 90 },
  );
  assert.deepEqual(zaicodeSplashBootMirror({ ...DEFAULT_ZAICODE_SPLASH_OPTIONS, maxWaitSec: 20 }), {
    hold: true,
    maxWaitMs: 20_000,
    fit: "contain",
  });
});

test("flipping the splash switch leaves the custom picture alone (imagePath stays undefined)", () => {
  // The old handler sent `imagePath ?? null`, and null means "back to the bundled picture".
  assert.deepEqual(parseZaicodeSplashPrefsInput({ enabled: false }), { enabled: false });
  assert.deepEqual(parseZaicodeSplashPrefsInput({ enabled: true, imagePath: null }), { enabled: true, imagePath: null });
  assert.deepEqual(parseZaicodeSplashPrefsInput({ enabled: true, imagePath: "C:\\a.png" }), {
    enabled: true,
    imagePath: "C:\\a.png",
  });
  // Only the option keys that were sent, each one checked.
  assert.deepEqual(parseZaicodeSplashPrefsInput({ enabled: true, options: { fit: "cover", scale: 9 } }), {
    enabled: true,
    options: { fit: "cover", scale: 1 },
  });
  assert.throws(() => parseZaicodeSplashPrefsInput({ enabled: "yes" }), TypeError);
  assert.throws(() => parseZaicodeSplashPrefsInput({ enabled: true, imagePath: 7 }), TypeError);
});

test("the bundled splash page is the template's output (one page for both pictures)", () => {
  const bundled = readFileSync(join(packages, "desktop", "build", "zaicode-splash", "splash.html"), "utf8");
  // Newlines are normalized on both sides: the generator emits LF, but
  // core.autocrlf=true turns the committed file into CRLF on checkout, so a
  // byte comparison fails on every Windows clone while the content is correct.
  // The assertion is about the page's content, not about Git's line endings.
  const lf = (text: string) => text.replace(/\r\n/g, "\n");
  assert.equal(lf(bundled), lf(zaicodeSplashPage("splash.png")));
  const page = zaicodeSplashPage("custom.jpg");
  // It fills its window and never draws the picture at a fixed 560x300.
  assert.match(page, /width: 100vw;/);
  assert.doesNotMatch(page, /width: 560px/);
  assert.match(page, /src="custom\.jpg"/);
});

test("a custom page from an older template is rewritten; no picture, no page", (t) => {
  const root = mkdtempSync(join(tmpdir(), "zaicode-splash-page-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "zaicode-splash");
  assert.equal(refreshZaicodeCustomSplashPage(dir), false);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "custom.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0]));
  writeFileSync(join(dir, "zaicode-splash.html"), "<style>img{width:560px;height:300px}</style>", "utf8");
  assert.equal(refreshZaicodeCustomSplashPage(dir), true);
  assert.equal(readFileSync(join(dir, "zaicode-splash.html"), "utf8"), zaicodeSplashPage("custom.png"));
});

/**
 * SRC-060 root cause of the locked settings card: preload exposed the splash
 * pair, but createDesktopPlatform never mapped it, so `platform.getZaicodeSplashPrefs`
 * was undefined in the renderer. The same slip locked the SAIMAIL field once
 * before. Every platform method the UI calls and preload exposes must be mapped.
 */
test("every platform method the UI calls and preload exposes is mapped by the desktop adapter", () => {
  const read = (path: string) => readFileSync(join(packages, path), "utf8");
  const preload = read("desktop/src/preload/index.ts");
  const adapter =
    read("desktop/src/renderer/src/desktopPlatform.ts") +
    read("desktop/src/renderer/src/desktopBrowserPlatformBridge.ts");
  const exposed = new Set([...preload.matchAll(/^ {2}(\w+):\s*(?:\(|async\b)/gm)].map((match) => match[1]!));
  const used = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirRecursive(dir)) {
      for (const match of readFileSync(entry, "utf8").matchAll(/\bplatform\??\.(\w+)/g)) used.add(match[1]!);
    }
  };
  walk(join(packages, "ui", "src"));
  const unmapped = [...used]
    .filter((name) => exposed.has(name))
    .filter((name) => !new RegExp(`\\b${name}\\b`).test(adapter))
    .sort();
  assert.deepEqual(unmapped, []);
});

function readdirRecursive(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...readdirRecursive(path));
    else if (/\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}
