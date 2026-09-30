import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  zaicodeChangeSoundFor,
  zaicodeClickSoundFor,
  type ZaicodeSoundTarget,
} from "../src/zaicode/zaicodeSoundVoices.js";

const root = join(import.meta.dirname, "..", "src");
const source = readFileSync(join(root, "zaicode", "zaicodeSoundSettingsModel.ts"), "utf8");

test("every default event sound ships in the FastPrompter library", () => {
  const files = [...source.matchAll(/fp\("([^"]+)"\)/g)].map((match) => match[1]!);
  assert.ok(files.length >= 35, `expected many defaults, got ${files.length}`);
  const missing = files.filter((file) => !existsSync(join(root, "assets", "fastprompter-sounds", file)));
  assert.deepEqual(missing, []);
});

test("sound event ids are unique and every group is known", () => {
  const ids = [...source.matchAll(/\{ id: "([^"]+)", group: "([^"]+)"/g)];
  const unique = new Set(ids.map((match) => match[1]));
  assert.equal(unique.size, ids.length);
  // T-134 added "Updates" (ZAICODE / SAIPEN / SAIMAIL updates).
  const groups = new Set(["Agent", "Sessions", "Composer", "Sidebar", "Window", "Engines", "SAIMAIL", "Interface", "Orchestra", "Updates", "SAIPEGGLE"]);
  for (const match of ids) assert.ok(groups.has(match[2]!), `unknown group ${match[2]}`);
  // Every former cue keeps a row, so migrated settings land somewhere.
  for (const cue of ["done", "failed", "question", "human", "update", "started"]) assert.ok(unique.has(`agent.${cue}`));
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "assets" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test("every Sounds-table row has a place that plays it", () => {
  const texts = sourceFiles(root).map((file) => readFileSync(file, "utf8"));
  const everything = texts.join("\n");
  // A row is live when its id appears somewhere besides its own definition line.
  const uses = (id: string) => everything.split(`"${id}"`).length - 1;
  const missing = (id: string) =>
    id.startsWith("agent.") ? !everything.includes("playZaicodeSoundAsync(`agent.${event}`") : uses(id) < 2;
  const ids = [...source.matchAll(/\{ id: "([^"]+)", group:/g)].map((match) => match[1]!);
  assert.deepEqual(ids.filter(missing), []);
  // The instrument itself: an id nobody plays is reported.
  assert.equal(missing("session.never-played"), true);
});

/** A fake element that "matches" the given selector parts, with attributes. */
function el(matches: readonly string[], attrs: Record<string, string> = {}): ZaicodeSoundTarget {
  const self: ZaicodeSoundTarget = {
    closest: (selector) =>
      selector.split(",").some((part) => matches.includes(part.trim())) ? self : null,
    getAttribute: (name) => attrs[name] ?? null,
  };
  return self;
}

test("SRC-060 orchestra: each kind of control has its own voice", () => {
  assert.equal(zaicodeClickSoundFor(el(["[role='tab']"]), null), "ui.tab");
  assert.equal(zaicodeClickSoundFor(el(["[role='menuitem']"]), null), "ui.menuItem");
  assert.equal(zaicodeClickSoundFor(el(["[role='option']"]), null), "ui.menuItem");
  assert.equal(zaicodeClickSoundFor(el(["[role='switch']", "button"]), null), "ui.toggle");
  assert.equal(zaicodeClickSoundFor(el(["button"], { "aria-haspopup": "menu" }), "false"), "ui.menuOpen");
  assert.equal(zaicodeClickSoundFor(el(["button"], { "aria-haspopup": "menu" }), "true"), "ui.collapse");
  assert.equal(zaicodeClickSoundFor(el(["button"]), "false"), "ui.expand");
  assert.equal(zaicodeClickSoundFor(el(["button"]), "true"), "ui.collapse");
  assert.equal(zaicodeClickSoundFor(el(["button"]), null), "ui.button");
  assert.equal(zaicodeClickSoundFor(el(["a[href]"]), null), "ui.link");
  // Controls with their own cue, disabled ones and form fields stay out of the click voice.
  assert.equal(zaicodeClickSoundFor(el(["[data-zaicode-sound]", "button"]), null), null);
  assert.equal(zaicodeClickSoundFor(el([":disabled", "button"]), null), null);
  assert.equal(zaicodeClickSoundFor(el(["input"]), null), null);
  assert.equal(zaicodeClickSoundFor(el([]), null), null);
});

test("SRC-060 orchestra: form fields answer on change", () => {
  assert.equal(zaicodeChangeSoundFor(el([]), { type: "checkbox", checked: true }), "ui.checkOn");
  assert.equal(zaicodeChangeSoundFor(el([]), { type: "checkbox", checked: false }), "ui.checkOff");
  assert.equal(zaicodeChangeSoundFor(el([]), { type: "range" }), "ui.slider");
  assert.equal(zaicodeChangeSoundFor(el([]), { type: "radio" }), "ui.select");
  assert.equal(zaicodeChangeSoundFor(el(["select"]), {}), "ui.select");
  assert.equal(zaicodeChangeSoundFor(el(["[role='switch']"]), { type: "checkbox", checked: true }), "ui.toggle");
  assert.equal(zaicodeChangeSoundFor(el([]), { type: "text" }), null);
});

test("SRC-060 orchestra: every voice the classifiers name is a row in the Sounds table", () => {
  const ids = new Set([...source.matchAll(/\{ id: "([^"]+)", group:/g)].map((match) => match[1]!));
  const voicesSource = readFileSync(join(root, "zaicode", "zaicodeSoundVoices.ts"), "utf8");
  const voices = [...voicesSource.matchAll(/return (?:[^;]*?)"(ui\.[A-Za-z]+)"/g)].map((match) => match[1]!);
  assert.ok(voices.length >= 12, `found ${voices.length} voices`);
  assert.deepEqual(voices.filter((id) => !ids.has(id)), []);
  const orchestra = [...source.matchAll(/group: "Orchestra"/g)].length;
  assert.ok(orchestra >= 15, `orchestra has ${orchestra} voices`);
});
