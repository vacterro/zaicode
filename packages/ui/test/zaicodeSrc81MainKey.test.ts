import assert from "node:assert/strict";
import test from "node:test";
import {
  foldZaicodeMainKeys,
  resolveZaicodeMainKey,
  useZaicodeMainSessions,
  zaicodeMainKeyForm,
  zaicodeMainSessionIdOf,
} from "../src/zaicode/zaicodeMainSession.js";

// SRC-081: "the bug where Main can still be a child". A MAIN written under one spelling of a
// project's path (C:\a\b) was invisible under another (c:/a/b/): the row did not know its own
// MAIN and listed that session as its child.

test("one project, one key, whatever the spelling of its path", () => {
  const forms = ["V:\\___VAC\\proj", "v:/___vac/proj/", "V:/___VAC/proj"];
  assert.equal(new Set(forms.map(zaicodeMainKeyForm)).size, 1);
  // Identities and non-drive paths are compared as written.
  assert.notEqual(zaicodeMainKeyForm("ssh://Host/a"), zaicodeMainKeyForm("ssh://host/a"));
  assert.notEqual(zaicodeMainKeyForm("/srv/A"), zaicodeMainKeyForm("/srv/a"));
});

test("a MAIN set under one spelling is found, replaced and cleared under another", () => {
  const store = useZaicodeMainSessions;
  store.setState({ byWorkspace: {}, armed: {} });
  store.getState().setMain("V:\\p\\one", "s-1");
  assert.equal(zaicodeMainSessionIdOf(store.getState().byWorkspace, "v:/p/one/"), "s-1", "found under another spelling");
  store.getState().setMain("v:/p/one", "s-2");
  assert.deepEqual(Object.keys(store.getState().byWorkspace), ["V:\\p\\one"], "still one entry, not two");
  assert.equal(zaicodeMainSessionIdOf(store.getState().byWorkspace, "V:/p/one"), "s-2");
  store.getState().clearMain("V:/P/ONE/");
  assert.deepEqual(store.getState().byWorkspace, {});
  // The armed claim ("the next session started here is MAIN") crosses spellings too.
  store.getState().arm("V:\\p\\two");
  assert.equal(store.getState().claimIfArmed("v:/p/two", "s-9"), true);
  assert.equal(zaicodeMainSessionIdOf(store.getState().byWorkspace, "V:\\p\\two"), "s-9");
});

test("saved duplicates fold into one entry, the later one wins; unknown keys resolve to themselves", () => {
  assert.deepEqual(foldZaicodeMainKeys({ "V:\\a": "old", "v:/a/": "new", "V:/b": "b" }), { "v:/a/": "new", "V:/b": "b" });
  assert.equal(resolveZaicodeMainKey({}, "V:/nothing"), "V:/nothing");
});
