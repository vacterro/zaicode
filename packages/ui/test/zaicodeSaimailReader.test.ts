import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { normalizeZaicodeUiPrefs } from "../src/zaicode/zaicodeUiPrefs.js";
import {
  applyZaicodeSaimailOpenedLetter,
  emptyZaicodeSaimailReaderState,
} from "../src/zaicode/zaicodeSaimailModel.js";

/**
 * The operator letter reader's security contract (SRC-079), checked at the
 * source level because it lives in component wiring, not in a pure function:
 * passive surfaces (poller, hover preview, home cards) never touch the open
 * channel; exactly one component calls it, only from an explicit click, and
 * forgets every body when it closes. The desktop suite proves the canonical
 * CLI behaviour itself end to end.
 */

const UI = join(import.meta.dirname, "..", "src");
const read = (relative: string) => readFileSync(join(UI, relative), "utf8");

const poller = read("zaicode/zaicodeSaimail.ts");
const reader = read("zaicode/ZaicodeSaimailReaderPopover.tsx");
const button = read("zaicode/ZaicodeSaimailHeaderButton.tsx");
const model = read("zaicode/zaicodeSaimailModel.ts");

test("listing stays metadata-only: the poller and the snapshot have no body and no open call", () => {
  assert.equal(poller.includes("openZaicodeSaimailLetter"), false, "the poller never opens a letter");
  assert.match(poller, /Never touches envelope files/, "the poller documents its header-only read");
  const headerShape = model.match(/export interface ZaicodeTelegramHeader \{[^}]+\}/)![0];
  assert.equal(headerShape.includes("body"), false, "a telegram header cannot carry a body");
  assert.equal(headerShape.includes("claim"), false, "a telegram header cannot carry a claim");
});

test("refresh and the passive surfaces cannot decrypt: nobody else opens letters", () => {
  assert.equal(poller.includes("listZaicodeSaimailReadLetters"), false, "refresh never asks for the read list either");
  for (const surface of ["ZaicodeSaimailHeaderButton.tsx", "home/ZaicodeHomeCards.tsx", "ZaicodeFooterMenus.tsx", "home/zaicodeHomeJournal.ts"]) {
    const source = read(join("zaicode", surface));
    assert.equal(source.includes("openZaicodeSaimailLetter"), false, `${surface} renders without opening letters`);
  }
});

test("exactly one component can open a letter, and only from its Open/Reopen click", () => {
  // The popover is the only caller of the open channel in the UI tree.
  assert.match(reader, /platform\.openZaicodeSaimailLetter\(\{ envelopeId, state \}\)/);
  const callSites = [...reader.matchAll(/openZaicodeSaimailLetter/g)].length;
  assert.equal(callSites, 3, "capability check, guard, and exactly one real call");
  // The call happens inside openLetter, which is reached only from LetterRow's
  // action button (Open for UNREAD rows, Reopen for READ rows).
  assert.match(reader, /"Open", "UNREAD"/);
  assert.match(reader, /"Reopen", "READ"/);
  assert.match(reader, /onAction=\{\(\) => void openLetter\(envelopeId, state\)\}/);
});

test("a selection is not an open: rendering a row draws headers, bodies come only from `opened`", () => {
  // The body block is guarded by readerState.opened[envelopeId], which only
  // openLetter fills after the backend answered ok -- never from hover, list
  // or mount. The ok/failure split itself is the reducer's, tested below.
  assert.match(reader, /readerState\.opened\[envelopeId\] \?/);
  // The only invocation site is the row's action button; the two effects
  // (capability probe, read-list load) never call it.
  assert.equal([...reader.matchAll(/void openLetter\(/g)].length, 1, "one invocation site: the Open/Reopen click");
  const effects = [...reader.matchAll(/useEffect\(\(\) => \{[\s\S]*?\n\s*\}, \[[^\]]*\]\);/g)].map((m) => m[0]);
  assert.ok(effects.length >= 2, "the two effects are found");
  for (const effect of effects) {
    assert.equal(effect.includes("openLetter"), false, "no effect opens letters by itself");
  }
});

test("read state is the backend's word: the poller re-syncs only on a canonical READ result", () => {
  // Pure reducer: only a backend-reported READ raises the refresh flag.
  const opened = applyZaicodeSaimailOpenedLetter(emptyZaicodeSaimailReaderState(), "sha256:" + "1".repeat(64), {
    ok: true,
    state: "READ",
    body: "b",
    message: "",
  });
  assert.equal(opened.needsRefresh, true, "a canonical UNREAD->READ asks the poller to re-sync");
  assert.equal(opened.opened["sha256:" + "1".repeat(64)]?.state, "READ", "the recorded state is the backend's");
  assert.match(reader, /if \(refresh\) refreshZaicodeSaimail\(\);/, "the popover refreshes only through the flag");
});

test("a failed open keeps the header, its durable state and says why", () => {
  // Pure reducer: a refusal records only the failure text -- no body, no
  // invented read state, no refresh flag, no neighbour damage.
  const id = "sha256:" + "2".repeat(64);
  const neighbour = "sha256:" + "9".repeat(64);
  const before = applyZaicodeSaimailOpenedLetter(emptyZaicodeSaimailReaderState(), neighbour, {
    ok: true, state: "READ", body: "neighbour", message: "",
  });
  const after = applyZaicodeSaimailOpenedLetter(before, id, { ok: false, state: null, body: null, message: "REFUSED" });
  assert.equal(after.failures[id], "REFUSED");
  assert.equal(after.opened[id], undefined, "a failed open never shows a body");
  assert.equal(after.opened[neighbour]?.body, "neighbour", "the neighbour's body is untouched");
  assert.equal(after.needsRefresh, before.needsRefresh);
  assert.match(reader, /failure=\{readerState\.failures\[envelopeId\] \?\? null\}/);
});

test("no cross-letter leakage: bodies are keyed per envelope, failures and busy flags too", () => {
  assert.match(reader, /busyId === envelopeId/);
  assert.match(reader, /readerState\.failures\[envelopeId\]/);
});

test("closing the reader forgets every body: close() wipes the plaintext state", () => {
  const close = reader.match(/const close = \(\) => \{[\s\S]*?\n  \};/)![0];
  assert.match(close, /setReaderState\(emptyZaicodeSaimailReaderState\(\)\)/, "bodies die with the popover");
  assert.deepEqual(emptyZaicodeSaimailReaderState(), { opened: {}, failures: {}, needsRefresh: false });
});

test("the degraded state is said out loud when the build cannot open letters", () => {
  assert.match(reader, /This build cannot open letters directly/);
  assert.match(reader, /platform\?\.openZaicodeSaimailLetter && platform\?\.listZaicodeSaimailReadLetters/);
});

test("the passive hover preview keeps its header-only wording and no agent round-trip", () => {
  assert.match(button, /Headers only\. Open a letter to read it\./);
  assert.doesNotMatch(button, /ask the agent to read the desk/i);
});

test("the widget needs no agent: click opens the reader by default, brief stays a choice", () => {
  const prefs = normalizeZaicodeUiPrefs({});
  assert.equal(prefs.saimailClick, "reader", "a fresh install reads letters directly");
  assert.equal(normalizeZaicodeUiPrefs({ saimailClick: "brief" }).saimailClick, "brief");
  assert.equal(normalizeZaicodeUiPrefs({ saimailClick: "settings" }).saimailClick, "settings");
  assert.equal(
    normalizeZaicodeUiPrefs({ saimailClick: "junk" }).saimailClick,
    normalizeZaicodeUiPrefs({}).saimailClick,
    "junk falls back to the default, never to a crash",
  );
  assert.match(button, /prefs\.saimailClick === "reader"/);
  assert.match(button, /prefs\.saimailClick === "brief"\) draftBrief\(\)/, "the agent brief stays available");
  assert.equal([...button.matchAll(/<ZaicodeSaimailReaderPopover/g)].length, 1, "one reader mount, not two");
});

test("agent-to-agent SAIMAIL is unchanged: the desk guidance and brief prompt survive", () => {
  const homeScreen = read("zaicode/ZaicodeHomeScreen.tsx");
  assert.match(homeScreen, /value: "reader", label: "Open the letter reader"/);
  assert.match(homeScreen, /value: "brief", label: "Ask the agent to read the desk"/, "the brief option is still selectable");
  assert.match(model, /export function saimailBriefPrompt/, "the agent brief prompt is untouched");
});
