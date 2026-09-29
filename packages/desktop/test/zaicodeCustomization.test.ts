import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createZaicodeChangeNotifier,
  ensureZaicodeCustomizationFolders,
  listZaicodeCustomPresets,
  listZaicodeCustomSounds,
  openZaicodeCustomization,
  readZaicodeCustomPreset,
  readZaicodeCustomSound,
  resolveZaicodeCustomizationRoot,
  watchZaicodeCustomization,
  writeZaicodeCustomPreset,
  writeZaicodeCustomSound,
  zaicodeCustomizationInfo,
} from "../src/main/zaicodeCustomization.js";

// T-126 (SRC-089): the folder the operator drops sounds into and the presets land in. What can go wrong here is
// data loss and escape: a write that replaces a file, a path that leaves the folder, a list that never shows the
// file that was just dropped. Each block below fails on the version of the module that has that fault.

function wav(seconds: number, fill = 0): Buffer {
  const byteRate = 8000;
  const data = Buffer.alloc(Math.round(seconds * byteRate), fill);
  const u32 = (value: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    return bytes;
  };
  const fmt = Buffer.concat([Buffer.from("fmt "), u32(16), Buffer.from([1, 0, 1, 0]), u32(8000), u32(byteRate), Buffer.from([1, 0, 8, 0])]);
  const body = Buffer.concat([Buffer.from("WAVE"), fmt, Buffer.from("data"), u32(data.length), data]);
  return Buffer.concat([Buffer.from("RIFF"), u32(body.length), body]);
}

function workspace(t: { after: (fn: () => void) => void }) {
  const base = mkdtempSync(join(tmpdir(), "zaicode-custom-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const info = zaicodeCustomizationInfo(join(base, "customization"), "env-dir");
  return { base, info };
}

async function opened(t: { after: (fn: () => void) => void }) {
  const made = workspace(t);
  await ensureZaicodeCustomizationFolders(made.info);
  return made;
}

// ---------------------------------------------------------------- root

test("root: the explicit folder wins, then the workspace variable, then the workspace above the executable, then app data", () => {
  const exists = (path: string) => path === join("W:", "ws", "zcode", "packages", "desktop");
  const execPath = join("W:", "ws", "zcode", "packages", "desktop", "dist-next", "win-unpacked", "ZAICODE.exe");
  const base = { execPath, appData: join("C:", "AppData"), exists };
  assert.deepEqual(resolveZaicodeCustomizationRoot({ ...base, env: { ZAICODE_CUSTOMIZATION_DIR: join("D:", "mine"), ZAICODE_ROOT: join("E:", "root") } }), { root: join("D:", "mine"), source: "env-dir" });
  assert.deepEqual(resolveZaicodeCustomizationRoot({ ...base, env: { ZAICODE_ROOT: join("E:", "root") } }), { root: join("E:", "root", "customization"), source: "env-root" });
  assert.deepEqual(resolveZaicodeCustomizationRoot({ ...base, env: {} }), { root: join("W:", "ws", "customization"), source: "workspace" });
  assert.deepEqual(
    resolveZaicodeCustomizationRoot({ ...base, env: {}, execPath: join("P:", "Programs", "ZAICODE", "ZAICODE.exe") }),
    { root: join("C:", "AppData", "ZAICODE", "customization"), source: "appdata" },
  );
});

test("root: a relative path in a variable is ignored (it would follow whatever the working folder is)", () => {
  const result = resolveZaicodeCustomizationRoot({ env: { ZAICODE_CUSTOMIZATION_DIR: "customization", ZAICODE_ROOT: "root" }, execPath: join("P:", "x", "a.exe"), appData: join("C:", "AppData"), exists: () => false });
  assert.equal(result.source, "appdata");
});

test("folders and README are created once and never rewritten", async (t) => {
  const { info } = workspace(t);
  await ensureZaicodeCustomizationFolders(info);
  assert.ok(existsSync(info.soundsDir) && existsSync(info.presetsDir));
  const readme = join(info.root, "README.txt");
  assert.match(readFileSync(readme, "utf8"), /sounds/);
  writeFileSync(readme, "my own notes");
  await ensureZaicodeCustomizationFolders(info);
  assert.equal(readFileSync(readme, "utf8"), "my own notes");
});

// ---------------------------------------------------------------- listing

test("list: sub-folders, upper-case extensions and the length of each file; other files and empty ones are left out", async (t) => {
  const { info } = await opened(t);
  mkdirSync(join(info.soundsDir, "Horse"));
  writeFileSync(join(info.soundsDir, "b tick.wav"), wav(0.25));
  writeFileSync(join(info.soundsDir, "Horse", "HORSE01.WAV"), wav(2));
  writeFileSync(join(info.soundsDir, "notes.txt"), "not a sound");
  writeFileSync(join(info.soundsDir, "empty.wav"), Buffer.alloc(0));
  const list = await listZaicodeCustomSounds(info);
  assert.deepEqual(list.sounds.map((sound) => [sound.path, sound.seconds]), [["b tick.wav", 0.25], ["Horse/HORSE01.WAV", 2]]);
  assert.equal(list.truncated, false);
});

test("list: a file is measured once (a re-scan on every window focus must not read 5000 headers again); a changed one is measured again", async (t) => {
  const { info } = await opened(t);
  const file = join(info.soundsDir, "a.wav");
  const bytes = wav(2);
  writeFileSync(file, bytes);
  const stamp = new Date(2026, 1, 1);
  utimesSync(file, stamp, stamp);
  assert.equal((await listZaicodeCustomSounds(info)).sounds[0]!.seconds, 2);
  // Same size and same modification time, but the header now says 1 s: only a cache can still answer 2.
  const edited = Buffer.from(bytes);
  edited.writeUInt32LE(8000, edited.indexOf("data") + 4);
  writeFileSync(file, edited);
  utimesSync(file, stamp, stamp);
  assert.equal((await listZaicodeCustomSounds(info)).sounds[0]!.seconds, 2, "unchanged as far as size and time can tell: not read again");
  // A new modification time is a change: measured again.
  const later = new Date(2026, 1, 2);
  utimesSync(file, later, later);
  assert.equal((await listZaicodeCustomSounds(info)).sounds[0]!.seconds, 1);
});

test("list: an MP3 whose cover-art tag is bigger than the header window still gets its length", async (t) => {
  const { info } = await opened(t);
  const tag = 200_000;
  // ID3v2 header: size as four 7-bit bytes.
  const size = [(tag >> 21) & 0x7f, (tag >> 14) & 0x7f, (tag >> 7) & 0x7f, tag & 0x7f];
  const frame = Buffer.alloc(417);
  Buffer.from([0xff, 0xfb, 0x90, 0x00]).copy(frame); // MPEG-1 Layer III, 128 kbps, 44.1 kHz
  const frames = 60;
  const file = Buffer.concat([Buffer.from("ID3"), Buffer.from([3, 0, 0, ...size]), Buffer.alloc(tag), ...Array.from({ length: frames }, () => frame)]);
  writeFileSync(join(info.soundsDir, "cover.mp3"), file);
  const listed = (await listZaicodeCustomSounds(info)).sounds[0]!;
  assert.ok(Math.abs(listed.seconds - (frames * 417) / 16000) < 0.001, `length ${listed.seconds} s`);
});

test("list: folders nested deeper than the scan looks are cut and the list says so", async (t) => {
  const { info } = await opened(t);
  let dir = info.soundsDir;
  for (const name of ["a", "b", "c", "d", "e", "f"]) {
    dir = join(dir, name);
    mkdirSync(dir);
  }
  writeFileSync(join(dir, "deep.wav"), wav(1));
  writeFileSync(join(info.soundsDir, "a", "b", "c", "d", "e", "ok.wav"), wav(1));
  const list = await listZaicodeCustomSounds(info);
  assert.deepEqual(list.sounds.map((sound) => sound.path), ["a/b/c/d/e/ok.wav"]);
  assert.equal(list.truncated, true);
});

test("list: a link out of the folder is not followed", async (t) => {
  const { base, info } = await opened(t);
  const outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.wav"), wav(1));
  try {
    symlinkSync(outside, join(info.soundsDir, "link"), "junction");
  } catch {
    t.skip("this machine cannot create a folder link");
    return;
  }
  assert.deepEqual((await listZaicodeCustomSounds(info)).sounds, []);
  assert.deepEqual(await readZaicodeCustomSound(info, "link/secret.wav"), { ok: false, reason: "outside the sounds folder" });
});

// ---------------------------------------------------------------- reading and writing

test("read: the bytes come back; a path that leaves the folder, a missing file or a non-sound is refused with a reason", async (t) => {
  const { info } = await opened(t);
  const bytes = wav(1, 7);
  writeFileSync(join(info.soundsDir, "a.wav"), bytes);
  writeFileSync(join(info.soundsDir, "fake.wav"), "this is not audio");
  const ok = await readZaicodeCustomSound(info, "a.wav");
  assert.ok(ok.ok && Buffer.compare(Buffer.from(ok.bytes), bytes) === 0);
  for (const bad of ["../a.wav", "..\\a.wav", "/etc/a.wav", "C:/a.wav", "a/../a.wav", "a.txt", "", "con.wav"]) {
    assert.equal((await readZaicodeCustomSound(info, bad)).ok, false, bad);
  }
  assert.deepEqual(await readZaicodeCustomSound(info, "missing.wav"), { ok: false, reason: "no such file" });
  assert.deepEqual(await readZaicodeCustomSound(info, "fake.wav"), { ok: false, reason: "not a WAV, MP3 or OGG file" });
});

test("write: a new file is created, the same bytes again are recognised, other bytes never replace it", async (t) => {
  const { info } = await opened(t);
  const first = wav(1, 1);
  const other = wav(1, 2);
  const created = await writeZaicodeCustomSound(info, { path: "Horse/a.wav", bytes: first });
  assert.deepEqual(created.ok && [created.path, created.created], ["Horse/a.wav", true]);
  const same = await writeZaicodeCustomSound(info, { path: "Horse/a.wav", bytes: first });
  assert.deepEqual(same.ok && [same.path, same.created], ["Horse/a.wav", false]);
  const beside = await writeZaicodeCustomSound(info, { path: "Horse/a.wav", bytes: other });
  assert.deepEqual(beside.ok && [beside.path, beside.created], ["Horse/a (2).wav", true]);
  // The second file is found again by its bytes: importing the same preset twice adds nothing.
  const again = await writeZaicodeCustomSound(info, { path: "Horse/a.wav", bytes: other });
  assert.deepEqual(again.ok && [again.path, again.created], ["Horse/a (2).wav", false]);
  assert.equal(Buffer.compare(readFileSync(join(info.soundsDir, "Horse", "a.wav")), first), 0);
  assert.equal(Buffer.compare(readFileSync(join(info.soundsDir, "Horse", "a (2).wav")), other), 0);
});

test("write: several writers racing for one name each keep their own sound (the one that lost the name takes the next)", async (t) => {
  const { info } = await opened(t);
  const versions = [1, 2, 3, 4, 5, 6].map((fill) => wav(1, fill));
  const results = await Promise.all(versions.map((bytes) => writeZaicodeCustomSound(info, { path: "race.wav", bytes })));
  assert.ok(results.every((result) => result.ok));
  const names = results.map((result) => (result.ok ? result.path : ""));
  assert.equal(new Set(names).size, versions.length, "six different sounds, six different names");
  const kept = results.map((result, index) => result.ok && Buffer.compare(readFileSync(join(info.soundsDir, result.path)), versions[index]!) === 0);
  assert.deepEqual(kept, versions.map(() => true), "nobody's bytes were replaced by somebody else's");
});

test("write: escapes, non-sounds and empty bytes are refused and nothing is written", async (t) => {
  const { base, info } = await opened(t);
  for (const path of ["../evil.wav", "a/../../evil.wav", "..\\evil.wav", "C:/evil.wav", "evil.exe", "nul.wav"]) {
    assert.equal((await writeZaicodeCustomSound(info, { path, bytes: wav(1) })).ok, false, path);
  }
  assert.deepEqual(await writeZaicodeCustomSound(info, { path: "a.wav", bytes: new Uint8Array(0) }), { ok: false, reason: "empty or too large" });
  assert.deepEqual(await writeZaicodeCustomSound(info, { path: "a.wav", bytes: new TextEncoder().encode("MZ program") }), { ok: false, reason: "not a WAV, MP3 or OGG file" });
  assert.equal(existsSync(join(base, "evil.wav")), false);
  assert.deepEqual((await listZaicodeCustomSounds(info)).sounds, []);
});

// ---------------------------------------------------------------- presets

test("presets: written under a taken name they land beside it, listed newest first, read back exactly", async (t) => {
  const { info } = await opened(t);
  const name = "zaicode-preset-sounds-my setup.json";
  const first = await writeZaicodeCustomPreset(info, { name, text: '{"a":1}' });
  assert.deepEqual(first.ok && [first.path, first.created], [name, true]);
  const same = await writeZaicodeCustomPreset(info, { name, text: '{"a":1}' });
  assert.deepEqual(same.ok && [same.path, same.created], [name, false]);
  const other = await writeZaicodeCustomPreset(info, { name, text: '{"a":2}' });
  assert.deepEqual(other.ok && [other.path, other.created], ["zaicode-preset-sounds-my setup (2).json", true]);
  utimesSync(join(info.presetsDir, name), new Date(2026, 0, 1), new Date(2026, 0, 1));
  utimesSync(join(info.presetsDir, "zaicode-preset-sounds-my setup (2).json"), new Date(2026, 5, 1), new Date(2026, 5, 1));
  const listed = await listZaicodeCustomPresets(info);
  assert.deepEqual(listed.map((entry) => entry.name), ["zaicode-preset-sounds-my setup (2).json", name]);
  assert.deepEqual(await readZaicodeCustomPreset(info, name), { ok: true, text: '{"a":1}' });
});

test("presets: only plain .json names inside the folder are listed, read or written", async (t) => {
  const { info } = await opened(t);
  writeFileSync(join(info.presetsDir, "notes.txt"), "x");
  writeFileSync(join(info.presetsDir, "ok.json"), "{}");
  mkdirSync(join(info.presetsDir, "dir.json"));
  assert.deepEqual((await listZaicodeCustomPresets(info)).map((entry) => entry.name), ["ok.json"]);
  for (const bad of ["../ok.json", "a/b.json", "..\\ok.json", "ok.txt", ".json", "con.json", "a:b.json"]) {
    assert.equal((await readZaicodeCustomPreset(info, bad)).ok, false, bad);
    assert.equal((await writeZaicodeCustomPreset(info, { name: bad, text: "{}" })).ok, false, bad);
  }
});

// ---------------------------------------------------------------- open in the file manager

test("open: folders open, a file is shown selected, anything that is not a file of the folder is refused", async (t) => {
  const { info } = await opened(t);
  writeFileSync(join(info.soundsDir, "a.wav"), wav(1));
  const calls: string[] = [];
  const shell = {
    openPath: async (path: string) => {
      calls.push(`open ${path}`);
      return "";
    },
    showItemInFolder: (path: string) => void calls.push(`show ${path}`),
  };
  assert.equal((await openZaicodeCustomization(info, { kind: "root" }, shell)).ok, true);
  assert.equal((await openZaicodeCustomization(info, { kind: "sounds" }, shell)).ok, true);
  assert.equal((await openZaicodeCustomization(info, { kind: "sounds", file: "a.wav" }, shell)).ok, true);
  assert.equal((await openZaicodeCustomization(info, { kind: "sounds", file: "../README.txt" }, shell)).ok, false);
  assert.equal((await openZaicodeCustomization(info, { kind: "root", file: "README.txt" }, shell)).ok, false);
  assert.deepEqual(calls, [`open ${info.root}`, `open ${info.soundsDir}`, `show ${join(info.soundsDir, "a.wav")}`]);
});

test("open: a file that is gone opens its folder instead of failing", async (t) => {
  const { info } = await opened(t);
  const calls: string[] = [];
  const result = await openZaicodeCustomization(info, { kind: "sounds", file: "gone.wav" }, { openPath: async (path) => (calls.push(path), ""), showItemInFolder: () => undefined });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [info.soundsDir]);
});

test("open: the shell's error text comes back as the failure", async (t) => {
  const { info } = await opened(t);
  const result = await openZaicodeCustomization(info, { kind: "presets" }, { openPath: async () => "no application", showItemInFolder: () => undefined });
  assert.deepEqual(result, { ok: false, message: "no application" });
});

// ---------------------------------------------------------------- live changes

function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    timers: {
      set: (run: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { at: now + ms, run });
        return id;
      },
      clear: (handle: unknown) => void pending.delete(handle as number),
    },
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at <= now) {
          pending.delete(id);
          entry.run();
        }
      }
    },
  };
}

test("a burst of events for one file is one notice, sent after the last event", () => {
  const clock = fakeTimers();
  const seen: string[] = [];
  const notifier = createZaicodeChangeNotifier((change) => seen.push(change), 300, clock.timers);
  for (let event = 0; event < 8; event += 1) {
    notifier.note("sounds");
    clock.advance(100);
  }
  assert.deepEqual(seen, []);
  clock.advance(300);
  assert.deepEqual(seen, ["sounds"]);
  clock.advance(1000);
  assert.deepEqual(seen, ["sounds"]);
});

test("sounds and presets are announced separately, and closing the notifier drops what is waiting", () => {
  const clock = fakeTimers();
  const seen: string[] = [];
  const notifier = createZaicodeChangeNotifier((change) => seen.push(change), 300, clock.timers);
  notifier.note("sounds");
  notifier.note("presets");
  clock.advance(300);
  assert.deepEqual(seen.sort(), ["presets", "sounds"]);
  notifier.note("sounds");
  notifier.close();
  clock.advance(1000);
  assert.equal(seen.length, 2);
});

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

test("a file dropped into the sounds folder is announced without a restart, and a preset file as presets", async (t) => {
  const { info } = await opened(t);
  const seen = new Set<string>();
  const watcher = watchZaicodeCustomization(info, (change) => seen.add(change), 60);
  t.after(() => watcher.close());
  await new Promise((resolve) => setTimeout(resolve, 100));
  mkdirSync(join(info.soundsDir, "Horse"));
  writeFileSync(join(info.soundsDir, "Horse", "new.wav"), wav(1));
  assert.ok(await until(() => seen.has("sounds"), 5000), "sounds announced");
  writeFileSync(join(info.presetsDir, "friend.json"), "{}");
  assert.ok(await until(() => seen.has("presets"), 5000), "presets announced");
  // And the list a window then asks for really has the file.
  assert.deepEqual((await listZaicodeCustomSounds(info)).sounds.map((sound) => sound.path), ["Horse/new.wav"]);
});

test("watching a folder that does not exist does not throw", () => {
  const info = zaicodeCustomizationInfo(join(tmpdir(), "zaicode-custom-missing-" + Date.now()), "env-dir");
  const watcher = watchZaicodeCustomization(info, () => undefined, 10);
  watcher.close();
});
