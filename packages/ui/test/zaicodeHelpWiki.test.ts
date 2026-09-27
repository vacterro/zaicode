import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ZAICODE_HELP_TOPIC_IDS, ZAICODE_NAV_HELP_TOPICS } from "../src/zaicode/zaicodeHelpTopics.js";
import { ZAICODE_HELP_WIKI } from "../src/settings/zaicodeHelpWiki.js";

// SRC-060: "обнови вообще весь HELP… каждый элемент, каждый пункт, что зачем
// для чего почему… база для чайников… Shift+F1 на элемент сразу переводил в
// HELP секцию". Every topic has a full article; every surface tag names a real
// topic; Shift+F1 can reach nearly every topic from the screen.

const root = join(import.meta.dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "assets" ? [] : sourceFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

const tagged = new Set<string>();
for (const file of sourceFiles(root)) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/data-zaicode-help="([a-z]+)"/g)) tagged.add(match[1]!);
  // The workspace tab bar picks its topic per tab.
  for (const match of text.matchAll(/data-zaicode-help=\{[^}]*\}/g)) {
    // Only the chosen values (after ? or :), not the ids they are compared with.
    for (const literal of match[0].matchAll(/[?:]\s*"([a-z]+)"/g)) tagged.add(literal[1]!);
  }
}

test("every Help topic has a full article with a plain-words why", () => {
  for (const id of ZAICODE_HELP_TOPIC_IDS) {
    const article = ZAICODE_HELP_WIKI[id];
    assert.ok(article, `topic "${id}" has no article`);
    assert.ok(article.why.length >= 60, `topic "${id}" explains itself in under 60 characters`);
  }
});

test("the glossary explains the words a beginner meets", () => {
  const words = new Set((ZAICODE_HELP_WIKI.glossary.terms ?? []).map(([term]) => term.toLowerCase()));
  assert.ok(words.size >= 20, `only ${words.size} glossary words`);
  for (const word of ["agent", "model", "session", "quota / limit", "reset", "worker", "saipen", "live"]) {
    assert.ok(words.has(word), `the glossary lacks "${word}"`);
  }
});

test("every surface tag names a real Help topic", () => {
  const known = new Set<string>(ZAICODE_HELP_TOPIC_IDS);
  assert.deepEqual([...tagged].filter((id) => !known.has(id)), []);
});

test("Shift+F1 reaches every topic that has a place on screen", () => {
  const reachable = new Set([...tagged, ...Object.values(ZAICODE_NAV_HELP_TOPICS)]);
  // Concepts and settings pages with no single element of their own; F1 / the Help list reach them.
  const conceptOnly = new Set(["glossary", "memory", "home", "autostart"]);
  const unreachable = ZAICODE_HELP_TOPIC_IDS.filter((id) => !reachable.has(id) && !conceptOnly.has(id));
  assert.deepEqual(unreachable, []);
});
