/**
 * Length and kind of a sound file from its header bytes alone (T-126). The customization folder can hold
 * hundreds of files; decoding each one to learn its length would stall the list, and the picker only needs a
 * number to sort clicks from jingles from loops. Pure functions over byte views: the caller reads the first and
 * last 64 KiB of a file and passes them with the file size. -1 means "the header does not say".
 */

export type ZaicodeSoundFormat = "wav" | "mp3" | "ogg";

export const ZAICODE_SOUND_HEADER_WINDOW = 64 * 1024;

const ascii = (bytes: Uint8Array, at: number, length: number): string => {
  let text = "";
  for (let index = at; index < at + length && index < bytes.length; index += 1) text += String.fromCharCode(bytes[index]!);
  return text;
};

const u16 = (bytes: Uint8Array, at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u32 = (bytes: Uint8Array, at: number): number => (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0;
const u32be = (bytes: Uint8Array, at: number): number =>
  (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0;

/** The format the leading bytes show, whatever the file name says; null = not a sound this app plays. */
export function sniffZaicodeSoundFormat(bytes: Uint8Array): ZaicodeSoundFormat | null {
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "wav";
  if (ascii(bytes, 0, 4) === "OggS") return "ogg";
  if (ascii(bytes, 0, 3) === "ID3") return "mp3";
  if ((bytes[0] ?? 0) === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return "mp3";
  return null;
}

function wavSeconds(head: Uint8Array, fileSize: number): number {
  let at = 12;
  let byteRate = 0;
  while (at + 8 <= head.length) {
    const id = ascii(head, at, 4);
    const size = u32(head, at + 4);
    if (id === "fmt ") {
      byteRate = u32(head, at + 16);
    } else if (id === "data") {
      const start = at + 8;
      const room = Math.max(0, fileSize - start);
      // A streamed file writes 0 or 0xFFFFFFFF as the size: the rest of the file is the data.
      const dataBytes = size === 0 || size === 0xffffffff || size > room ? room : size;
      return byteRate > 0 ? dataBytes / byteRate : -1;
    }
    at += 8 + size + (size % 2);
  }
  return -1;
}

function lastOggGranule(tail: Uint8Array): number | null {
  for (let at = tail.length - 27; at >= 0; at -= 1) {
    if (tail[at] === 0x4f && ascii(tail, at, 4) === "OggS") {
      const low = u32(tail, at + 6);
      const high = u32(tail, at + 10);
      if (low === 0xffffffff && high === 0xffffffff) return null;
      return high * 2 ** 32 + low;
    }
  }
  return null;
}

function oggSeconds(head: Uint8Array, tail: Uint8Array): number {
  const segments = head[26] ?? 0;
  const packet = 27 + segments;
  const granule = lastOggGranule(tail);
  if (granule === null) return -1;
  if (ascii(head, packet, 7) === "\u0001vorbis") {
    const rate = u32(head, packet + 12);
    return rate > 0 ? granule / rate : -1;
  }
  if (ascii(head, packet, 8) === "OpusHead") {
    const preSkip = u16(head, packet + 10);
    return Math.max(0, granule - preSkip) / 48000;
  }
  return -1;
}

const MPEG1_L3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Bytes an ID3v2 tag takes at the start of the file (0 = none). Cover art can make it far bigger than the header window. */
export function zaicodeMp3TagLength(head: Uint8Array): number {
  if (ascii(head, 0, 3) !== "ID3") return 0;
  const size = ((head[6] ?? 0) & 0x7f) * 2 ** 21 + ((head[7] ?? 0) & 0x7f) * 2 ** 14 + ((head[8] ?? 0) & 0x7f) * 2 ** 7 + ((head[9] ?? 0) & 0x7f);
  return 10 + size + ((head[5] ?? 0) & 0x10 ? 10 : 0);
}

/** `base` is the file offset `head` starts at: 0 for the file's start, the tag's length when the caller skipped a big tag. */
function mp3Seconds(head: Uint8Array, fileSize: number, base: number): number {
  const skip = base === 0 ? zaicodeMp3TagLength(head) : 0;
  for (let at = skip; at + 4 <= head.length; at += 1) {
    if (head[at] !== 0xff || ((head[at + 1] ?? 0) & 0xe0) !== 0xe0) continue;
    const version = ((head[at + 1] ?? 0) >> 3) & 3;
    const layer = ((head[at + 1] ?? 0) >> 1) & 3;
    const bitrateIndex = ((head[at + 2] ?? 0) >> 4) & 15;
    const rateIndex = ((head[at + 2] ?? 0) >> 2) & 3;
    // Not a frame after all (reserved version/layer, "free" or bad bitrate, reserved rate): keep looking.
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) continue;
    const sampleRate = SAMPLE_RATES[version]?.[rateIndex];
    if (!sampleRate) continue;
    const mpeg1 = version === 3;
    const mono = (((head[at + 3] ?? 0) >> 6) & 3) === 3;
    const samplesPerFrame = mpeg1 ? 1152 : 576;
    const sideInfo = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const tag = at + 4 + sideInfo;
    const kind = ascii(head, tag, 4);
    if ((kind === "Xing" || kind === "Info") && ((u32be(head, tag + 4)) & 1) === 1) {
      const frames = u32be(head, tag + 8);
      if (frames > 0) return (frames * samplesPerFrame) / sampleRate;
    }
    if (ascii(head, at + 36, 4) === "VBRI") {
      // "VBRI", version, delay, quality (2 bytes each), byte count (4), then the frame count.
      const frames = u32be(head, at + 36 + 14);
      if (frames > 0) return (frames * samplesPerFrame) / sampleRate;
    }
    const kbps = (mpeg1 ? MPEG1_L3_KBPS : MPEG2_L3_KBPS)[bitrateIndex];
    if (!kbps) return -1;
    // Constant bitrate: the rest of the file over the bitrate. A VBR file without a Xing frame is off by a little.
    return Math.max(0, fileSize - base - at) / ((kbps * 1000) / 8);
  }
  return -1;
}

/**
 * Length in seconds (millisecond precision), or -1 when the header cannot say. Never throws on hostile bytes.
 * For an MP3 whose ID3 tag is bigger than the window, pass the window read AT the end of the tag as `head` and the
 * tag's length as `headOffset`.
 */
export function parseZaicodeSoundLength(format: ZaicodeSoundFormat, head: Uint8Array, tail: Uint8Array, fileSize: number, headOffset = 0): number {
  try {
    const seconds = format === "wav" ? wavSeconds(head, fileSize) : format === "ogg" ? oggSeconds(head, tail) : mp3Seconds(head, fileSize, headOffset);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) / 1000 : -1;
  } catch {
    return -1;
  }
}
