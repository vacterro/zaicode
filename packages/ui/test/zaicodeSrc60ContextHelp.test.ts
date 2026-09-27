import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ZAICODE_HELP_ATTRIBUTE,
  ZAICODE_HELP_TOPIC_IDS,
  ZAICODE_NAV_HELP_TOPICS,
  isZaicodeHelpTopicId,
  zaicodeHelpTopicFor,
} from "../src/zaicode/zaicodeHelpTopics.js";
import { ZAICODE_HOTKEY_ACTIONS, zaicodeFKeyIndex } from "../src/zaicode/zaicodeHotkeys.js";
import { ZAICODE_NAV_ITEMS } from "../src/zaicode/zaicodeLayoutPrefs.js";

// SRC-060: "Shift + F1 на элемент сразу переводил в HELP секцию и объяснял это
// всё досконально, каждый элемент, каждый пункт".
//
// Nothing in the app tied an element to a help topic, so the jump had no
// origin: openZaicodeHelp(topic) worked, but nothing could supply the topic.
// The registry below is that missing origin, and these tests are the two ways
// it can rot -- an id with no card, and a card with no id.

const src = join(import.meta.dirname, "..", "src");
const read = (relative: string): string => readFileSync(join(src, relative), "utf8");

/** Minimal duck-typed node: the resolver only needs these two members. */
function node(topic: string | null, parent: FakeElement | null = null): FakeElement {
  return {
    parentElement: parent,
    getAttribute: (name: string) => (name === ZAICODE_HELP_ATTRIBUTE ? topic : null),
  };
}
type FakeElement = ReturnType<typeof node>;

test("every registered topic id has a card, and every card is registered", () => {
  const help = read("settings/zaicodeHelpContent.ts");
  const declared = new Set([...help.matchAll(/^\s{4}id: "([a-z]+)",$/gm)].map((m) => m[1]!));
  for (const id of ZAICODE_HELP_TOPIC_IDS) {
    assert.ok(declared.has(id), `topic "${id}" is registered but has no card`);
  }
  for (const id of declared) {
    assert.ok(
      (ZAICODE_HELP_TOPIC_IDS as readonly string[]).includes(id),
      `card "${id}" exists but is not registered, so no element can reach it`,
    );
  }
});

test("every sidebar menu line has a help topic", () => {
  for (const item of ZAICODE_NAV_ITEMS) {
    const topic = ZAICODE_NAV_HELP_TOPICS[item.id];
    assert.ok(topic, `nav line "${item.id}" has no help topic`);
    assert.ok(isZaicodeHelpTopicId(topic), `nav line "${item.id}" points at an unknown topic`);
  }
  // The map is typed against the nav id union, so an extra key cannot exist;
  // this asserts the other direction, that none is missing at runtime.
  assert.equal(Object.keys(ZAICODE_NAV_HELP_TOPICS).length, ZAICODE_NAV_ITEMS.length);
});

test("resolution walks up to the nearest tagged ancestor", () => {
  const panel = node("scheduler");
  const button = node(null, panel);
  const icon = node(null, button);
  assert.equal(zaicodeHelpTopicFor(icon), "scheduler");
});

test("a more specific ancestor wins over the one further out", () => {
  const outer = node("settings");
  const inner = node("sounds", outer);
  assert.equal(zaicodeHelpTopicFor(node(null, inner)), "sounds");
});

test("an unknown or absent tag resolves to null instead of a wrong card", () => {
  assert.equal(zaicodeHelpTopicFor(node("nonsense")), null);
  assert.equal(zaicodeHelpTopicFor(node(null, node("also-nonsense"))), null);
  assert.equal(zaicodeHelpTopicFor(null), null);
});

test("a deep chain cannot spin the walk", () => {
  let deep: FakeElement | null = node("saipeggle");
  for (let i = 0; i < 5000; i += 1) deep = node(null, deep);
  // The cap means a tagged element far above the walk is not found, and the
  // call still returns rather than hanging.
  assert.equal(zaicodeHelpTopicFor(deep), null);
});

test("Shift+F1 is bound and cannot be swallowed by the bare F-keys block", () => {
  const action = ZAICODE_HOTKEY_ACTIONS.find((a) => a.id === "ui.helpContext");
  assert.ok(action, "the contextual help action exists");
  assert.equal(action.defaults[0], "Shift+F1");
  // Plain F1 must keep meaning "open Help at the top".
  const plain = ZAICODE_HOTKEY_ACTIONS.find((a) => a.id === "ui.help");
  assert.equal(plain?.defaults[0], "F1");
  // The F-keys block only claims unmodified keys, so Shift+F1 reaches the loop.
  assert.equal(zaicodeFKeyIndex({ code: "F1", shiftKey: true } as KeyboardEvent), null);
  assert.equal(zaicodeFKeyIndex({ code: "F1" } as KeyboardEvent), 0);
});

test("no two ZAICODE hotkeys claim the same default binding", () => {
  const seen = new Map<string, string>();
  for (const action of ZAICODE_HOTKEY_ACTIONS) {
    for (const binding of action.defaults) {
      if (!binding) continue;
      const owner = seen.get(binding);
      assert.equal(owner, undefined, `"${binding}" is claimed by both ${owner} and ${action.id}`);
      seen.set(binding, action.id);
    }
  }
});

test("the dispatcher resolves the pointer and passes the topic through", () => {
  const runtime = read("zaicode/ZaicodeAppRuntime.tsx");
  assert.ok(
    runtime.includes("openZaicodeHelp(zaicodeHelpTopicUnderPointer() ?? undefined)"),
    "Shift+F1 must open Help at the resolved topic, or at the top when there is none",
  );
  // A keydown carries no coordinates, so the pointer has to be remembered.
  assert.ok(runtime.includes("rememberZaicodeHelpPointer"), "the pointer position is tracked");
  assert.ok(runtime.includes('addEventListener("pointermove"'), "the pointer listener is registered");
});

test("a jump while Help is already open still moves", () => {
  const actions = read("zaicode/zaicodeActions.ts");
  assert.ok(actions.includes("ZAICODE_HELP_TOPIC_EVENT"), "there is a live topic channel");
  assert.ok(
    actions.includes("window.dispatchEvent(new CustomEvent"),
    "openZaicodeHelp announces the topic live, not only in sessionStorage",
  );
  const help = read("settings/ZaicodeHelpSection.tsx");
  assert.ok(help.includes("onZaicodeHelpTopicRequest"), "the help section subscribes to it");
});
