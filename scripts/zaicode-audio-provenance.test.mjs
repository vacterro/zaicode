import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyFallbackSounds } from "./audio/verify-fallback-sounds.mjs";

const relative = "packages/ui/src/assets/fastprompter-sounds/problip/blip01.wav";
const original = Buffer.from("RIFF-original-synthesized-WAVE-data");

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "zaicode-audio-"));
  const put = (name, data) => {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), data);
  };
  put(relative, original);
  put("scripts/audio/fallback-sounds.manifest", "problip/blip01.wav\n");
  put("scripts/audio/fallback-sounds.sha256.json", JSON.stringify({
    [relative]: createHash("sha256").update(original).digest("hex"),
  }));
  try { run(root, put); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("reviewed audio passes its byte identity check", () => fixture(root => {
  assert.equal(verifyFallbackSounds(root), 1);
}));

test("same named replacement is refused", () => fixture((root, put) => {
  put(relative, Buffer.from("RIFF-unreviewed-replacement-WAVE-data"));
  assert.throws(() => verifyFallbackSounds(root), /SHA256 MISMATCH/);
}));

test("missing byte manifest fails closed", () => fixture(root => {
  rmSync(join(root, "scripts/audio/fallback-sounds.sha256.json"));
  assert.throws(() => verifyFallbackSounds(root), /audio hash manifest/);
}));

test("notification cues need their own reviewed digest", () => fixture((root, put) => {
  put("packages/ui/src/assets/notification-sounds/task-notification-pop.wav", original);
  assert.throws(() => verifyFallbackSounds(root), /MISSING SHA256/);
}));

test("outside audio and absent sounds remain refused", () => fixture((root, put) => {
  put("outside.wav", original);
  assert.throws(() => verifyFallbackSounds(root), /AUDIO OUTSIDE/);
  rmSync(join(root, "outside.wav"));
  rmSync(join(root, relative));
  assert.throws(() => verifyFallbackSounds(root), /MANIFESTED BUT ABSENT/);
}));

test("all supported recorded-audio formats require reviewed identities", () => fixture((root, put) => {
  for (const extension of ["m4a", "aiff", "aif", "opus", "wma"]) {
    const path = `outside.${extension}`;
    put(path, original);
    assert.throws(() => verifyFallbackSounds(root), /AUDIO OUTSIDE/, extension);
    rmSync(join(root, path));
  }
}));

test("directory links cannot hide or redirect audio enumeration", () => fixture(root => {
  const destination = mkdtempSync(join(tmpdir(), "zaicode-audio-external-"));
  const link = join(root, "external");
  try {
    symlinkSync(destination, link, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => verifyFallbackSounds(root), /symbolic link|junction/i);
    // Removing the link must leave the independently owned destination intact.
  } finally {
    rmSync(link, {recursive:true, force:true});
    rmSync(destination, {recursive:true, force:true});
  }
}));
