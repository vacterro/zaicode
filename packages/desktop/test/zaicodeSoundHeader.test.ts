import assert from "node:assert/strict";
import test from "node:test";
import { parseZaicodeSoundLength, sniffZaicodeSoundFormat } from "../src/main/zaicodeSoundHeader.js";

// T-126: the customization folder lists files with a length so the picker can sort clicks from loops. The length
// comes from the header alone (no decoding of hundreds of files), so each format's header has a test that fails
// when the arithmetic is wrong: a picker that called every file "?" or a 2 s jingle a 20 s ambience would be
// the visible symptom.

function le32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function wav(seconds: number, options: { rate?: number; channels?: number; bits?: number; dataSize?: number; extraChunk?: boolean } = {}): Buffer {
  const rate = options.rate ?? 8000;
  const channels = options.channels ?? 1;
  const bits = options.bits ?? 8;
  const byteRate = (rate * channels * bits) / 8;
  const dataBytes = Math.round(seconds * byteRate);
  const fmt = Buffer.concat([Buffer.from("fmt "), le32(16), Buffer.from([1, 0, channels, 0]), le32(rate), le32(byteRate), Buffer.from([(channels * bits) / 8, 0, bits, 0])]);
  const list = options.extraChunk ? Buffer.concat([Buffer.from("LIST"), le32(5), Buffer.from("abcde\0")]) : Buffer.alloc(0);
  const data = Buffer.concat([Buffer.from("data"), le32(options.dataSize ?? dataBytes), Buffer.alloc(dataBytes)]);
  const body = Buffer.concat([Buffer.from("WAVE"), fmt, list, data]);
  return Buffer.concat([Buffer.from("RIFF"), le32(body.length), body]);
}

const window = (buffer: Buffer, from: number, to: number): Uint8Array => new Uint8Array(buffer.subarray(from, to));
const head = (buffer: Buffer): Uint8Array => window(buffer, 0, 65536);
const tail = (buffer: Buffer): Uint8Array => window(buffer, Math.max(0, buffer.length - 65536), buffer.length);
const length = (format: "wav" | "mp3" | "ogg", buffer: Buffer): number => parseZaicodeSoundLength(format, head(buffer), tail(buffer), buffer.length);

test("WAV: length is the data bytes over the byte rate, whatever chunks come before the data", () => {
  assert.equal(length("wav", wav(2)), 2);
  assert.equal(length("wav", wav(0.25, { rate: 44100, channels: 2, bits: 16 })), 0.25);
  assert.equal(length("wav", wav(1.5, { extraChunk: true })), 1.5);
});

test("WAV: a streamed file that wrote 0 or 0xFFFFFFFF as the data size is measured by what is really there", () => {
  assert.equal(length("wav", wav(3, { dataSize: 0xffffffff })), 3);
  assert.equal(length("wav", wav(3, { dataSize: 0 })), 3);
});

test("WAV: no data chunk, or a zero byte rate, is unknown (-1), never a guess", () => {
  const noData = wav(1).subarray(0, 36);
  assert.equal(length("wav", noData), -1);
  assert.equal(length("wav", wav(1, { rate: 0 })), -1);
});

function oggPage(granule: bigint, packet: Buffer, headerType: number): Buffer {
  const granuleBytes = Buffer.alloc(8);
  granuleBytes.writeBigUInt64LE(granule);
  return Buffer.concat([Buffer.from("OggS"), Buffer.from([0, headerType]), granuleBytes, le32(1), le32(0), le32(0), Buffer.from([1, packet.length]), packet]);
}

function vorbisId(rate: number): Buffer {
  return Buffer.concat([Buffer.from([1]), Buffer.from("vorbis"), le32(0), Buffer.from([2]), le32(rate), Buffer.alloc(12)]);
}

test("OGG Vorbis: last page granule over the sample rate of the id header", () => {
  const file = Buffer.concat([oggPage(0n, vorbisId(44100), 2), Buffer.alloc(500), oggPage(BigInt(44100 * 3), Buffer.alloc(10), 4)]);
  assert.equal(length("ogg", file), 3);
});

test("OGG Opus: granule counts 48 kHz samples minus the pre-skip", () => {
  const opusHead = Buffer.concat([Buffer.from("OpusHead"), Buffer.from([1, 2]), Buffer.from([0x38, 0x01]), le32(44100), Buffer.alloc(3)]);
  const file = Buffer.concat([oggPage(0n, opusHead, 2), Buffer.alloc(300), oggPage(BigInt(48000 * 2 + 312), Buffer.alloc(10), 4)]);
  assert.equal(length("ogg", file), 2);
});

test("OGG: a position past 32 bits is read whole (a long recording), not cut to its low half", () => {
  const seconds = 100000;
  const file = Buffer.concat([oggPage(0n, vorbisId(44100), 2), Buffer.alloc(200), oggPage(BigInt(44100 * seconds), Buffer.alloc(10), 4)]);
  assert.ok(44100 * seconds > 2 ** 32);
  assert.equal(length("ogg", file), seconds);
});

test("OGG: a stream whose last page has no position yet (all ones) is unknown", () => {
  const file = Buffer.concat([oggPage(0n, vorbisId(44100), 2), oggPage(0xffffffffffffffffn, Buffer.alloc(10), 0)]);
  assert.equal(length("ogg", file), -1);
});

const MP3_HEADER = [0xff, 0xfb, 0x90, 0x00]; // MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo
const MP3_FRAME_BYTES = 417;

function mp3Frames(count: number, options: { xingFrames?: number; id3?: number } = {}): Buffer {
  const frames: Buffer[] = [];
  for (let index = 0; index < count; index += 1) {
    const frame = Buffer.alloc(MP3_FRAME_BYTES);
    Buffer.from(MP3_HEADER).copy(frame);
    if (index === 0 && options.xingFrames !== undefined) {
      Buffer.from("Xing").copy(frame, 36);
      frame.writeUInt32BE(1, 40);
      frame.writeUInt32BE(options.xingFrames, 44);
    }
    frames.push(frame);
  }
  const id3 = options.id3 === undefined ? Buffer.alloc(0) : Buffer.concat([Buffer.from("ID3"), Buffer.from([3, 0, 0, 0, 0, 0, options.id3]), Buffer.alloc(options.id3)]);
  return Buffer.concat([id3, ...frames]);
}

test("MP3: a Xing frame count wins over the bitrate estimate", () => {
  const seconds = (100 * 1152) / 44100;
  assert.ok(Math.abs(length("mp3", mp3Frames(20, { xingFrames: 100 })) - seconds) < 0.001);
});

test("MP3: constant bitrate is estimated from the bytes after the tag", () => {
  const file = mp3Frames(60, { id3: 30 });
  const expected = (file.length - 40) / 16000; // 10 header bytes + 30 of tag, then 128 kbps = 16000 bytes/s
  assert.ok(Math.abs(length("mp3", file) - expected) < 0.001);
});

test("MP3: garbage that only looks like a sync is skipped or unknown, never a crash", () => {
  assert.equal(length("mp3", Buffer.from([0xff, 0xe0, 0x00, 0x00, 1, 2, 3])), -1);
  assert.equal(length("mp3", Buffer.alloc(0)), -1);
  assert.equal(length("wav", Buffer.from("RIFF")), -1);
  assert.equal(length("ogg", Buffer.from("OggS")), -1);
});

test("the format comes from the bytes, not from the name", () => {
  assert.equal(sniffZaicodeSoundFormat(wav(1)), "wav");
  assert.equal(sniffZaicodeSoundFormat(oggPage(0n, vorbisId(8000), 2)), "ogg");
  assert.equal(sniffZaicodeSoundFormat(mp3Frames(2)), "mp3");
  assert.equal(sniffZaicodeSoundFormat(mp3Frames(1, { id3: 4 })), "mp3");
  assert.equal(sniffZaicodeSoundFormat(Buffer.from("MZ\x90\x00 not a sound")), null);
  assert.equal(sniffZaicodeSoundFormat(new Uint8Array(0)), null);
});
