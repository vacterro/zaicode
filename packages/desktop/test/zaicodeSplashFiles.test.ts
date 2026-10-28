import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findZaicodeCustomSplashImage,
  installZaicodeCustomSplashImage,
  sniffZaicodeSplashImage,
} from "../src/main/zaicodeSplashFiles.js";

// SRC-058: replacing the start-up picture with one of another format left the
// old custom.* behind. The root launcher tries custom.png before custom.jpg, so
// it kept showing the old picture while the app splash showed the new one.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const BMP = Buffer.concat([Buffer.from("BM", "latin1"), Buffer.alloc(8)]);

function scratch(t: { after: (fn: () => void) => void }): { dir: string; src: (name: string, bytes: Buffer) => string } {
  const root = mkdtempSync(join(tmpdir(), "zaicode-splash-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    dir: join(root, "zaicode-splash"),
    src: (name, bytes) => {
      const path = join(root, name);
      writeFileSync(path, bytes);
      return path;
    },
  };
}

const page = (file: string) => `<img src="${file}">`;

test("replacing a PNG with a JPG leaves exactly one custom picture, the new one", (t) => {
  const { dir, src } = scratch(t);
  assert.equal(installZaicodeCustomSplashImage(dir, src("a.png", PNG), page), "custom.png");
  assert.equal(installZaicodeCustomSplashImage(dir, src("b.jpeg", JPG), page), "custom.jpg");
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith("custom.")), ["custom.jpg"]);
  assert.equal(findZaicodeCustomSplashImage(dir), join(dir, "custom.jpg"));
  assert.equal(readFileSync(join(dir, "zaicode-splash.html"), "utf8"), '<img src="custom.jpg">');
});

test("a BMP replaced by a PNG is gone too (every format, not just the launcher's first)", (t) => {
  const { dir, src } = scratch(t);
  installZaicodeCustomSplashImage(dir, src("a.bmp", BMP), page);
  installZaicodeCustomSplashImage(dir, src("b.png", PNG), page);
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith("custom.")), ["custom.png"]);
});

test("a file that is not a supported picture changes nothing", (t) => {
  const { dir, src } = scratch(t);
  installZaicodeCustomSplashImage(dir, src("a.png", PNG), page);
  assert.equal(installZaicodeCustomSplashImage(dir, src("notes.png", Buffer.from("hello")), page), null);
  assert.deepEqual(readdirSync(dir).sort(), ["custom.png", "zaicode-splash.html"]);
});

test("format comes from the bytes, and a missing folder simply has no picture", (t) => {
  const { dir } = scratch(t);
  assert.equal(sniffZaicodeSplashImage(JPG), "jpg");
  assert.equal(sniffZaicodeSplashImage(Buffer.from("text")), null);
  assert.equal(findZaicodeCustomSplashImage(dir), null);
});
