import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isZaicodeSelectAllKey, isZaicodeTextEntry, zaicodeChatForSelectAll } from "../src/zaicode/zaicodeChatSelectAll.js";

/**
 * SRC-094 (T-131): "I want Ctrl+A in the chat to select only the chat's content, not half the program." With no text field focused the
 * browser's select-all takes the whole page. The decision (which chat, if any) is pure; these tests give it small stand-ins for the
 * elements so every case of "where is the keyboard" is a fact, and the wiring test pins the listener the real window installs.
 */

interface Fake {
  tagName?: string;
  isContentEditable?: boolean;
  parentElement: Fake | null;
  closest(selector: string): Fake | null;
  name: string;
}

/** A tree of stand-in elements: `chat` matches the transcript selector, `editable` matches contenteditable. */
function node(name: string, parent: Fake | null, traits: { chat?: boolean; editable?: boolean; tag?: string } = {}): Fake {
  const self: Fake = {
    name,
    ...(traits.tag ? { tagName: traits.tag } : {}),
    parentElement: parent,
    closest(selector: string): Fake | null {
      for (let at: Fake | null = self; at; at = at.parentElement) {
        const own = at as Fake & { __chat?: boolean; __editable?: boolean };
        if (own.__chat && selector.includes("data-v4-timeline-scroll")) return at;
        if (own.__editable && selector.includes("contenteditable")) return at;
      }
      return null;
    },
  };
  Object.assign(self, { __chat: traits.chat ?? false, __editable: traits.editable ?? false });
  return self;
}

const page = node("body", null);
const sidebar = node("sidebar", page);
const chat = node("timeline", page, { chat: true });
const message = node("message-text", chat);
const nested = node("code block", message);
const composer = node("composer", page, { tag: "TEXTAREA" });
const rename = node("rename box", chat, { tag: "INPUT" });
const editableBlock = node("editable", chat, { editable: true });
const editableChild = node("editable child", editableBlock);

const where = (patch: Partial<{ active: unknown; anchor: unknown; pointer: unknown }>) => ({ active: page, anchor: null, pointer: null, ...patch });

test("K1 with the keyboard in the chat (focus, selection or the last click) select-all takes that chat", () => {
  assert.equal(zaicodeChatForSelectAll(where({ active: message })), chat, "focus in a message");
  assert.equal(zaicodeChatForSelectAll(where({ anchor: nested })), chat, "the selection began inside the chat");
  assert.equal(zaicodeChatForSelectAll(where({ pointer: chat })), chat, "the last click was blank space in the chat");
  assert.equal(zaicodeChatForSelectAll(where({ pointer: message })), chat);
});

test("K2 anywhere else it is left to the browser: the sidebar, the page, nothing", () => {
  assert.equal(zaicodeChatForSelectAll(where({ active: sidebar, anchor: sidebar, pointer: sidebar })), null);
  assert.equal(zaicodeChatForSelectAll(where({})), null);
  assert.equal(zaicodeChatForSelectAll({ active: null, anchor: null, pointer: null }), null);
});

test("K3 in a text field select-all keeps its meaning (that field's text), even when the field sits inside the chat", () => {
  assert.equal(zaicodeChatForSelectAll(where({ active: composer, anchor: message, pointer: message })), null, "the composer");
  assert.equal(zaicodeChatForSelectAll(where({ active: rename, pointer: chat })), null, "a box inside the chat");
  assert.equal(zaicodeChatForSelectAll(where({ active: editableChild })), null, "inside editable content");
  assert.equal(isZaicodeTextEntry(composer), true);
  assert.equal(isZaicodeTextEntry(editableBlock), true);
  assert.equal(isZaicodeTextEntry(message), false);
  assert.equal(isZaicodeTextEntry(null), false);
  assert.equal(isZaicodeTextEntry({ tagName: "select", parentElement: null, closest: () => null }), true);
});

test("K4 only plain Ctrl+A or Cmd+A counts; Shift/Alt combinations and keys somebody already handled do not", () => {
  const key = (patch: Record<string, unknown> = {}) => ({ key: "a", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...patch });
  assert.equal(isZaicodeSelectAllKey(key()), true);
  assert.equal(isZaicodeSelectAllKey(key({ key: "A" })), true, "caps lock");
  assert.equal(isZaicodeSelectAllKey(key({ ctrlKey: false, metaKey: true })), true);
  assert.equal(isZaicodeSelectAllKey(key({ ctrlKey: false })), false, "no modifier: typing an a");
  assert.equal(isZaicodeSelectAllKey(key({ shiftKey: true })), false);
  assert.equal(isZaicodeSelectAllKey(key({ altKey: true })), false);
  assert.equal(isZaicodeSelectAllKey(key({ defaultPrevented: true })), false);
  assert.equal(isZaicodeSelectAllKey(key({ key: "b" })), false);
});

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const source = (path: string): string => readFileSync(join(srcRoot, path), "utf8").replace(/\r\n/g, "\n");

test("K5 the listener is installed at app start, in the capture phase, and takes the chat's contents only", () => {
  assert.match(source("App.tsx"), /installZaicodeChatSelectAll\(\);/);
  const module = source("zaicode/zaicodeChatSelectAll.ts");
  assert.match(module, /document\.addEventListener\(\s*"keydown"/);
  assert.match(module, /\btrue,\s*\);\s*}\s*$/, "the key listener is a capture listener");
  assert.match(module, /event\.preventDefault\(\);/);
  assert.match(module, /range\.selectNodeContents\(chat as unknown as Node\);/, "the range is the chat's contents, not the page");
  assert.match(module, /data-v4-timeline-scroll="true"/, "the chat is the real timeline container");
  assert.match(source("v4/ConversationTimeline.tsx"), /data-v4-timeline-scroll="true"/, "and that marker still exists in the timeline");
});
