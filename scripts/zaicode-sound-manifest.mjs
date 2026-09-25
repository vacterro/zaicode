#!/usr/bin/env node
/**
 * Writes packages/ui/src/zaicode/zaicodeSoundManifest.json: the duration of
 * every file in the bundled FastPrompter sound library, so the sound picker
 * can tell a 0.2 s click from a 40 s ambience loop without decoding 1300
 * files in the renderer.
 *
 * Run after adding or removing sounds:
 *   node scripts/zaicode-sound-manifest.mjs
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..", "packages", "ui", "src", "assets", "fastprompter-sounds");
const out = join(import.meta.dirname, "..", "packages", "ui", "src", "zaicode", "zaicodeSoundManifest.json");

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (/\.(wav|mp3|ogg)$/i.test(name)) files.push(full);
  }
  return files;
}

/** RIFF/WAVE: data chunk size / byte rate. Null when the header is not PCM-readable. */
function wavSeconds(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") byteRate = buffer.readUInt32LE(offset + 16);
    if (id === "data") {
      if (!byteRate) return null;
      const bytes = Math.min(size, buffer.length - offset - 8);
      return bytes / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** Ogg Vorbis: last page granule position / sample rate of the identification header. */
function oggSeconds(buffer) {
  const vorbis = buffer.indexOf("\x01vorbis", 0, "binary");
  if (vorbis < 0) return null;
  const rate = buffer.readUInt32LE(vorbis + 12);
  const last = buffer.lastIndexOf("OggS", buffer.length, "binary");
  if (last < 0 || !rate) return null;
  const granule = Number(buffer.readBigInt64LE(last + 6));
  return granule > 0 ? granule / rate : null;
}

/** MP3 without a decoder: size at the common 128 kbps. Good enough to sort short from long. */
function mp3Seconds(buffer) {
  return (buffer.length * 8) / 128_000;
}

const manifest = {};
for (const file of walk(root).sort()) {
  const rel = relative(root, file).split("\\").join("/");
  const buffer = readFileSync(file);
  const seconds = /\.wav$/i.test(file) ? wavSeconds(buffer) : /\.ogg$/i.test(file) ? oggSeconds(buffer) : mp3Seconds(buffer);
  manifest[rel] = seconds === null ? -1 : Math.round(seconds * 100) / 100;
}

writeFileSync(out, `${JSON.stringify(manifest, null, 0).replace(/,"/g, ',\n"')}\n`);
const values = Object.values(manifest);
console.log(
  `${values.length} sounds -> ${relative(process.cwd(), out)} (${values.filter((value) => value < 0).length} unreadable, ${values.filter((value) => value > 15).length} longer than 15 s)`,
);
