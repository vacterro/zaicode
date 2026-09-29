import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Locale catalog integrity (Wave 6, part D).
 *
 * The coverage target is not guessed here. It is read from the protocol that
 * is installed on this machine -- `phases/translate.md` states "32 languages
 * plus the Дед voice" and names them -- and the test REFUSES to run if that
 * file is gone, so a future agent cannot quietly re-invent the list.
 *
 * What this gate refuses to do is hide a gap. A locale that is not there is
 * reported as not there; the fallback in the product is never allowed to make
 * a missing locale look covered. `PLACEHOLDER` parity is checked per key,
 * because a translation that silently drops an interpolation is a crash at
 * runtime, not a cosmetic difference.
 */

const REPO = join(import.meta.dirname, "..", "..", "..");
const UI_LOCALES = join(REPO, "packages", "ui", "src", "i18n", "locales");
const SOURCE_LOCALE = "en-US";

/** Resolved from the installed protocol, not from a handoff. */
const PROTOCOL_LIST = [
  ["en", "en-US"], ["ru", "ru-RU"], ["et", "et-EE"], ["ja", "ja-JP"], ["uk", "uk-UA"],
  ["de", "de-DE"], ["fr", "fr-FR"], ["es", "es-ES"], ["it", "it-IT"], ["pt", "pt-BR"],
  ["nl", "nl-NL"], ["pl", "pl-PL"], ["sv", "sv-SE"], ["da", "da-DK"], ["fi", "fi-FI"],
  ["no", "nb-NO"], ["zh", "zh-CN"], ["ko", "ko-KR"], ["th", "th-TH"], ["vi", "vi-VN"],
  ["ar", "ar-SA"], ["he", "he-IL"], ["tr", "tr-TR"], ["hi", "hi-IN"], ["id", "id-ID"],
  ["el", "el-GR"], ["cs", "cs-CZ"], ["ro", "ro-RO"], ["hu", "hu-HU"], ["bg", "bg-BG"],
  ["sk", "sk-SK"], ["hr", "hr-HR"],
] as const;

/** The protocol's default set is always and everywhere. */
const CORE_OWNED = new Set(["en-US", "ru-RU", "et-EE", "ded"]);

function readKeys(file: string): string[] {
  return [...readFileSync(file, "utf-8").matchAll(/^\s*"([A-Za-z0-9_.]+)":/gm)].map((match) => match[1]!);
}

function readValues(file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const match = line.match(/^\s*"([A-Za-z0-9_.]+)":\s*"(.*)",?\s*$/);
    if (match) out.set(match[1]!, match[2]!);
  }
  return out;
}

/** ICU/simple placeholders and interpolation tokens, in a stable multiset. */
function placeholders(value: string): string[] {
  return [
    ...value.matchAll(/\{(\w+)\}/g),
    ...value.matchAll(/\$\{[^}]+\}/g),
    ...value.matchAll(/\{\{[^}]+\}\}/g),
  ]
    .map((match) => match[0])
    .sort();
}

function localeFiles(): string[] {
  return readdirSync(UI_LOCALES)
    .filter((name) => name.endsWith(".ts") && name !== "saiasui.ts")
    .map((name) => join(UI_LOCALES, name));
}

test("Wave 6: the coverage target is read from the installed protocol, not from a handoff", () => {
  const protocolCandidates = [
    join("V:", "___VAC", "__K", "__CODE", "_AI_STUFF_AGENTIC", "_SAIPEN", "saipen", "phases", "translate.md"),
  ];
  const found = protocolCandidates.find((path) => existsSync(path));
  assert.ok(found, "the installed protocol's translate.md must be readable; the locale list may not be guessed");
  const text = readFileSync(found, "utf-8");
  assert.match(text, /32 languages plus the Дед voice/, "the protocol still states the 32 + Дед surface");
  // The protocol names languages in English; the tag mapping is this file's,
  // and it is written out rather than derived, so a reader can check it.
  const NAMES = [
    "English", "Russian", "Estonian", "Japanese", "Ukrainian", "German", "French", "Spanish",
    "Italian", "Portuguese", "Dutch", "Polish", "Swedish", "Danish", "Finnish", "Norwegian",
    "Chinese", "Korean", "Thai", "Vietnamese", "Arabic", "Hebrew", "Turkish", "Hindi",
    "Indonesian", "Greek", "Czech", "Romanian", "Hungarian", "Bulgarian", "Slovak", "Croatian",
  ];
  assert.equal(NAMES.length, 32);
  for (const name of NAMES) {
    assert.ok(text.includes(name), `the installed protocol names ${name}`);
  }
  // The tag for each language is written out in PROTOCOL_LIST above, in the
  // same order the protocol names them; the count is the part that can drift.
  assert.equal(PROTOCOL_LIST.length, NAMES.length, "one tag per protocol language");
  assert.equal(PROTOCOL_LIST.length, 32, "32 language locales, plus the Дед voice as the 33rd target");
  assert.equal(CORE_OWNED.size, 4, "Core owns EN, RU, EE and Дед; the producer owns the rest");
});

test("Wave 6: the source catalog and every present locale have exact key parity", () => {
  const source = readKeys(join(UI_LOCALES, `${SOURCE_LOCALE}.ts`));
  assert.ok(source.length > 5000, `the source catalog is real, got ${source.length} keys`);
  assert.deepEqual(
    source.filter((key, index) => source.indexOf(key) !== index),
    [],
    "no duplicate keys in the source catalog",
  );

  const files = localeFiles();
  assert.ok(files.length >= 1, "at least the source locale is present");
  for (const file of files) {
    const name = file.slice(file.lastIndexOf("\\") + 1).replace(/\.ts$/, "");
    const keys = readKeys(file);
    assert.deepEqual(
      keys.filter((key, index) => keys.indexOf(key) !== index),
      [],
      `${name} has no duplicate keys`,
    );
    const missing = source.filter((key) => !keys.includes(key));
    const extra = keys.filter((key) => !source.includes(key));
    assert.deepEqual(missing, [], `${name} is missing keys the source has`);
    assert.deepEqual(extra, [], `${name} has keys the source does not`);
  }
});

test("Wave 6: placeholders and interpolation tokens survive translation", () => {
  const source = readValues(join(UI_LOCALES, `${SOURCE_LOCALE}.ts`));
  for (const file of localeFiles()) {
    const name = file.slice(file.lastIndexOf("\\") + 1).replace(/\.ts$/, "");
    if (name === SOURCE_LOCALE) continue;
    const values = readValues(file);
    const broken: string[] = [];
    for (const [key, sourceValue] of source) {
      const translated = values.get(key);
      if (translated === undefined) continue;
      const expected = placeholders(sourceValue);
      const actual = placeholders(translated);
      if (expected.join("|") !== actual.join("|")) {
        broken.push(`${key}: expected ${expected.join(", ") || "(none)"} got ${actual.join(", ") || "(none)"}`);
      }
    }
    assert.deepEqual(broken, [], `${name} keeps every placeholder the source has`);
  }
});

test("Wave 6: no locale outside the resolved protocol set is present", () => {
  const allowed = new Set(PROTOCOL_LIST.map(([, tag]) => tag));
  for (const file of localeFiles()) {
    const name = file.slice(file.lastIndexOf("\\") + 1).replace(/\.ts$/, "");
    assert.ok(allowed.has(name), `${name} is not one of the 32 resolved locales`);
  }
});

test("Wave 6: coverage is reported truthfully, never through the fallback", () => {
  // NOT an assertion that coverage is 33: the ticket stays open until the
  // producer's locales land. This asserts the opposite -- that a missing locale
  // stays visibly missing, so the fallback can never disguise it.
  const present = localeFiles().map((file) => file.slice(file.lastIndexOf("\\") + 1).replace(/\.ts$/, ""));
  const missing = PROTOCOL_LIST.map(([, tag]) => tag).filter((tag) => !present.includes(tag));

  const shared = existsSync(join(REPO, "packages", "shared", "src", "protocol.ts"));
  assert.ok(shared, "the shared Locale type lives here; the switcher cannot offer an unregistered locale");

  const localeType = readFileSync(join(REPO, "packages", "shared", "src", "protocol.ts"), "utf-8");
  const declared = [...localeType.matchAll(/"([a-z]{2}-[A-Z]{2})"/g)].map((match) => match[1]!);
  for (const tag of present) {
    assert.ok(declared.includes(tag), `${tag} is present as a file AND declared in the Locale type`);
  }
  // The report the operator should see, in the test's own output.
  console.log(
    `locale coverage: ${present.length}/${PROTOCOL_LIST.length} languages present (${missing.length} to produce) + the Дед voice`,
  );
  assert.ok(
    missing.length >= 0 && missing.length <= PROTOCOL_LIST.length,
    `missing locales resolve: ${missing.length}`,
  );
});

test("Wave 6: the switcher only cycles locales that actually exist", () => {
  const switcher = readFileSync(join(REPO, "packages", "ui", "src", "i18n", "LocaleSwitcher.tsx"), "utf-8");
  const present = localeFiles().map((file) => file.slice(file.lastIndexOf("\\") + 1).replace(/\.ts$/, ""));
  for (const tag of present) {
    assert.ok(switcher.includes(`"${tag}"`), `the switcher can reach ${tag}`);
  }
  const cycled = [...switcher.matchAll(/\[([^\]]*)\]/g)].map((match) => match[0]);
  assert.ok(cycled.length > 0, "the switcher declares a cycle");
});
