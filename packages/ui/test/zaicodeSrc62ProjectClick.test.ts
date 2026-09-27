import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  decideZaicodeMainToggle,
  decideZaicodeProjectClick,
  zaicodeMainIsValid,
} from "../src/zaicode/zaicodeProjectClick.js";

// SRC-062 append: "click a project that has a session: the first click opens
// the session, fine; the next one opens some random session with a strange
// history; the next one finally a new session -- all mixed up. And the ◆ does
// nothing, or nothing I can understand; it should switch 'this project IS the
// session, the others are children'."

const base = { projectIsMain: true, sessionIds: ["main", "helper"], activeTaskId: null } as const;

test("repeated clicks on a MAIN row: open MAIN, then only fold -- never a draft, never another session", () => {
  const first = decideZaicodeProjectClick({ ...base, mainId: "main", activeWorkspace: false });
  assert.deepEqual(first, { action: "open", sessionId: "main" });
  // MAIN is now open: every further click folds / unfolds.
  for (let click = 0; click < 3; click += 1) {
    assert.deepEqual(
      decideZaicodeProjectClick({ ...base, mainId: "main", activeWorkspace: true, activeTaskId: "main" }),
      { action: "fold" },
    );
  }
  // A helper of the same project is open: the row click goes back to MAIN.
  assert.deepEqual(
    decideZaicodeProjectClick({ ...base, mainId: "main", activeWorkspace: true, activeTaskId: "helper" }),
    { action: "open", sessionId: "main" },
  );
});

test("a stale MAIN id (the session is gone from the list) is never opened", () => {
  assert.equal(zaicodeMainIsValid("gone", ["a", "b"]), false);
  assert.deepEqual(decideZaicodeProjectClick({ ...base, mainId: "gone", activeWorkspace: false }), { action: "draft" });
  // A cold project whose list has not loaded yet still trusts its MAIN.
  assert.deepEqual(
    decideZaicodeProjectClick({ ...base, sessionIds: [], mainId: "main", activeWorkspace: false }),
    { action: "open", sessionId: "main" },
  );
});

test("a folder row: the first click goes to the project, the next ones only fold", () => {
  assert.deepEqual(decideZaicodeProjectClick({ ...base, mainId: null, activeWorkspace: false }), { action: "draft" });
  assert.deepEqual(decideZaicodeProjectClick({ ...base, mainId: null, activeWorkspace: true }), { action: "fold" });
  // The MAIN view is off: a MAIN exists but the row is a folder.
  assert.deepEqual(
    decideZaicodeProjectClick({ ...base, projectIsMain: false, mainId: "main", activeWorkspace: true, activeTaskId: "main" }),
    { action: "fold" },
  );
});

test("the diamond switches: on -> off, off -> the open session, else the newest, else a new one", () => {
  const sessions = [
    { taskId: "old", updatedAt: 10 },
    { taskId: "new", updatedAt: 50 },
    { taskId: "mid", updatedAt: 30 },
  ];
  assert.deepEqual(decideZaicodeMainToggle({ mainId: "mid", sessions, activeWorkspace: true, activeTaskId: "old" }), {
    action: "unset",
    sessionId: "mid",
  });
  assert.deepEqual(decideZaicodeMainToggle({ mainId: null, sessions, activeWorkspace: true, activeTaskId: "old" }), {
    action: "set",
    sessionId: "old",
  });
  assert.deepEqual(decideZaicodeMainToggle({ mainId: null, sessions, activeWorkspace: false, activeTaskId: "old" }), {
    action: "set",
    sessionId: "new",
  });
  // A stale MAIN is "off": the switch turns it on with a real session.
  assert.deepEqual(decideZaicodeMainToggle({ mainId: "gone", sessions, activeWorkspace: false, activeTaskId: null }), {
    action: "set",
    sessionId: "new",
  });
  assert.deepEqual(decideZaicodeMainToggle({ mainId: null, sessions: [], activeWorkspace: false, activeTaskId: null }), {
    action: "arm",
  });
});

test("the sidebar row uses both decisions and the diamond shows its state", () => {
  const row = readFileSync(join(import.meta.dirname, "..", "src", "WorkspaceSidebarItem.tsx"), "utf8");
  assert.ok(row.includes("decideZaicodeProjectClick({"), "the row click");
  assert.ok(row.includes("decideZaicodeMainToggle({"), "the diamond");
  assert.ok(row.includes("aria-pressed={Boolean(zaicodeMainListed)}"), "the diamond is a pressed / not pressed switch");
  assert.doesNotMatch(row, /zaicodeMainOpen\) return false/, "the old fall-through to upstream's draft path is gone");
});
