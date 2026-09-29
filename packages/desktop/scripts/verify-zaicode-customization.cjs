// Customization-folder end-to-end check for the packaged boot gate (T-126, SRC-089).
//
// The operator's ask: "the list of sounds updates in real time when I add my own", from one folder that is easy
// to find. The unit suites prove the pieces (header parsing, the write rules, the store); only the packaged app
// proves the chain: the folder is created where it is told to be, the watcher in the main process sees a file
// dropped from OUTSIDE the app, the notice crosses the preload bridge, the page's store re-lists, and the
// Sounds page shows the new count -- with nothing clicked and nothing restarted.
//
// It runs on the gate's throw-away profile with ZAICODE_CUSTOMIZATION_DIR pointing inside it, so the operator's
// real customization folder is never created, touched or listed by a gate run.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A tiny valid WAV: 8 kHz mono 8-bit, `seconds` long, every sample `fill`. */
function wav(seconds, fill) {
  const dataBytes = Math.round(seconds * 8000);
  const u32 = (value) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    return bytes;
  };
  const fmt = Buffer.concat([Buffer.from("fmt "), u32(16), Buffer.from([1, 0, 1, 0]), u32(8000), u32(8000), Buffer.from([1, 0, 8, 0])]);
  const body = Buffer.concat([Buffer.from("WAVE"), fmt, Buffer.from("data"), u32(dataBytes), Buffer.alloc(dataBytes, fill)]);
  return Buffer.concat([Buffer.from("RIFF"), u32(body.length), body]);
}

async function until(check, ms, what) {
  const stop = Date.now() + ms;
  let last;
  while (Date.now() < stop) {
    last = await check();
    if (last) return last;
    await sleep(150);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * @param {import("playwright-core").Page} page the main window
 * @param {string} dir the customization folder this gate run was started with
 * @returns {Promise<{ source: string, appeared: boolean, count: number[] }>}
 */
async function checkCustomization(page, dir) {
  // The gate's Settings walk ends on the SAIPEGGLE page, whose game dialog covers the window and swallows clicks: start from a fresh page.
  await page.reload();
  await page.waitForSelector('[data-workspace-shell="true"]', { timeout: 60_000 });
  await sleep(1500);
  await page.locator("button[aria-label='Settings']").first().click({ timeout: 10_000 });
  await page.locator("nav").filter({ hasText: "Keyboard Shortcuts" }).first().waitFor({ timeout: 15_000 });

  const info = await page.evaluate(() => window.zcode.getZaicodeCustomizationInfo());
  assert.equal(path.resolve(info.root), path.resolve(dir), "the app uses the folder it was told to");
  assert.equal(info.source, "env-dir");
  assert.ok(fs.existsSync(path.join(dir, "sounds")) && fs.existsSync(path.join(dir, "presets")), "both folders are created at start");
  assert.ok(fs.existsSync(path.join(dir, "README.txt")), "and a README says what goes where");

  // What arrives while nobody asks: a listener on the bridge's notice, installed before the file is dropped.
  await page.evaluate(() => {
    window.__customizationNotices = [];
    window.zcode.onZaicodeCustomizationChanged((change) => window.__customizationNotices.push(change));
  });

  // The Sounds page, where the operator looks for the folder.
  const nav = page.locator("nav").filter({ hasText: "Keyboard Shortcuts" }).first();
  await nav.locator("button", { hasText: /^Sounds$/ }).first().click({ timeout: 8000 });
  const strip = page.locator("[data-zaicode-custom-sounds]").first();
  await strip.waitFor({ timeout: 15_000 });
  assert.ok((await strip.innerText()).includes(path.join(dir, "sounds")), "the page names the folder");
  const counts = async () => {
    const text = await strip.innerText();
    const found = /(\d+) sounds?/.exec(text);
    return found ? Number(found[1]) : -1;
  };
  await until(async () => (await counts()) === 0, 15_000, "an empty folder to read 0 sounds");
  const seen = [0];

  // A sound picker held OPEN on its Mine tab: the operator's picture of "the list updates by itself".
  await page.locator("[data-zaicode-sound-picker]").first().click({ timeout: 8000 });
  await page.getByRole("tab", { name: /^Mine/ }).click({ timeout: 8000 });
  const listbox = page.getByRole("listbox", { name: "Sounds" });
  await listbox.getByText("Nothing here yet").waitFor({ timeout: 8000 });

  // A file dropped from outside the app, in a sub-folder like the operator's own layout.
  fs.mkdirSync(path.join(dir, "sounds", "Gate"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sounds", "Gate", "tick.wav"), wav(0.25, 1));
  await listbox.getByText("tick", { exact: true }).waitFor({ timeout: 15_000 });
  assert.ok((await listbox.innerText()).includes("Gate"), "the row shows the folder the file sits in");
  await page.keyboard.press("Escape");
  await until(async () => (await counts()) === 1, 15_000, "the Sounds page to count the dropped file (no click, no restart)");
  seen.push(1);
  const notices = await page.evaluate(() => window.__customizationNotices);
  assert.ok(notices.includes("sounds"), "main announced the change over the preload bridge");

  // Through main: the list, the bytes, and the folder's refusals.
  const list = await page.evaluate(() => window.zcode.listZaicodeCustomSounds());
  assert.deepEqual(list.sounds.map((sound) => [sound.path, sound.seconds]), [["Gate/tick.wav", 0.25]]);
  const read = await page.evaluate(() => window.zcode.readZaicodeCustomSound("Gate/tick.wav").then((result) => ({ ok: result.ok, length: result.ok ? result.bytes.length : 0 })));
  assert.deepEqual(read, { ok: true, length: wav(0.25, 1).length });
  // The length main read from the header is what the browser's own decoder says: the two agree on a real file.
  const decoded = await page.evaluate(async () => {
    const result = await window.zcode.readZaicodeCustomSound("Gate/tick.wav");
    const copy = result.bytes.buffer.slice(result.bytes.byteOffset, result.bytes.byteOffset + result.bytes.byteLength);
    return (await new AudioContext().decodeAudioData(copy)).duration;
  });
  assert.ok(Math.abs(decoded - list.sounds[0].seconds) < 0.005, `header length ${list.sounds[0].seconds} s equals decoded length ${decoded} s`);
  const refused = await page.evaluate(async () => {
    const outside = await window.zcode.readZaicodeCustomSound("../README.txt");
    const drive = await window.zcode.writeZaicodeCustomSound({ path: "C:/x.wav", bytes: new Uint8Array([1]) });
    return [outside.ok, drive.ok];
  });
  assert.deepEqual(refused, [false, false], "a path that leaves the folder is refused by main");
  const written = await page.evaluate(
    (bytes) => window.zcode.writeZaicodeCustomSound({ path: "Gate/tick.wav", bytes: new Uint8Array(bytes) }).then((result) => [result.ok, result.path, result.created]),
    [...wav(0.25, 2)],
  );
  assert.deepEqual(written, [true, "Gate/tick (2).wav", true], "a different sound under a taken name lands beside it");
  assert.deepEqual(fs.readFileSync(path.join(dir, "sounds", "Gate", "tick.wav")), wav(0.25, 1), "the original file is untouched");
  await until(async () => (await counts()) === 2, 15_000, "the Sounds page to count the file written through the app");
  seen.push(2);

  // A removed file leaves the list at once too.
  fs.rmSync(path.join(dir, "sounds", "Gate"), { recursive: true, force: true });
  await until(async () => (await counts()) === 0, 15_000, "the Sounds page to drop the deleted files");
  seen.push(0);

  // A preset file dropped into the presets folder is listed, and only .json names are.
  fs.writeFileSync(path.join(dir, "presets", "zaicode-preset-sounds-gate.json"), "{}");
  fs.writeFileSync(path.join(dir, "presets", "notes.txt"), "x");
  const presets = await until(
    async () => {
      const names = (await page.evaluate(() => window.zcode.listZaicodeCustomPresets())).map((entry) => entry.name);
      return names.length > 0 ? names : null;
    },
    15_000,
    "the presets folder to list a dropped preset",
  );
  assert.deepEqual(presets, ["zaicode-preset-sounds-gate.json"]);
  return { source: info.source, appeared: true, count: seen };
}

module.exports = { checkCustomization };
