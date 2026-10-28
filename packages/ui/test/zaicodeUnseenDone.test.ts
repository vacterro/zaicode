import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pickZaicodeUnseenDone, type ZaicodeRunningSnapshot } from "../src/zaicode/zaicodeUnseenDone.js";
import type { ZaicodeSessionBrief } from "../src/zaicode/zaicodeContinue.js";

// SRC-131: a run that finished while the operator looked elsewhere must mark itself
// unread, and nothing else may.
const brief = (over: Partial<ZaicodeSessionBrief> & { sessionId: string }): ZaicodeSessionBrief =>
  ({
    running: false,
    waiting: false,
    failed: false,
    interrupted: false,
    manuallyStopped: false,
    crashCut: false,
    unreadAt: null,
    projectKey: "p1",
    workspacePath: "/w",
    ...over,
  }) as ZaicodeSessionBrief;

const running = (...ids: string[]): ZaicodeRunningSnapshot => new Map(ids.map((id) => [id, true]));
const idle = (...ids: string[]): ZaicodeRunningSnapshot => new Map(ids.map((id) => [id, false]));

test("SRC-131: only a session that was running and is now finished unseen gets stamped", () => {
  const picked = pickZaicodeUnseenDone(
    [
      brief({ sessionId: "a" }), // ran, finished, nobody is looking: the one answer
      brief({ sessionId: "b", running: true }), // still going
      brief({ sessionId: "c" }), // idle before and idle now: nothing finished here
      brief({ sessionId: "d", unreadAt: 1234 }), // already stamped
      brief({ sessionId: "e", waiting: true }),
      brief({ sessionId: "f", failed: true }),
      brief({ sessionId: "g", interrupted: true }),
      brief({ sessionId: "h", manuallyStopped: true }),
      brief({ sessionId: "i", crashCut: true }),
    ],
    // "c" was idle in the previous sweep too, so its stillness is not a finish.
    new Map([...running("a", "b", "d", "e", "f", "g", "h", "i"), ...idle("c")]),
    "z",
  );
  assert.deepEqual(
    picked.map((item) => item.sessionId),
    ["a"],
    "a cut-off, failed, waiting or already-stamped run is not a finished answer",
  );
});

test("SRC-131: the open session is never stamped — the operator is already looking at it", () => {
  const picked = pickZaicodeUnseenDone([brief({ sessionId: "a" })], running("a"), "a");
  assert.deepEqual(picked, [], "reading the result is the thing that counts as seen");
});

test("SRC-131: the first sweep after the window opens stamps nothing", () => {
  // An empty previous map is the seeded state: nothing was observed running, so
  // nothing was observed finishing.
  const picked = pickZaicodeUnseenDone([brief({ sessionId: "a", running: false })], idle(), null);
  assert.deepEqual(picked, [], "a session that was already idle at boot did not finish under us");
});

test("SRC-131: the producer is mounted, wired to the same field the manual action uses", () => {
  const runtime = readFileSync(new URL("../src/zaicode/ZaicodeAppRuntime.tsx", import.meta.url), "utf8");
  assert.match(runtime, /useZaicodeUnseenDoneWatch\(\);/);

  const host = readFileSync(new URL("../src/zaicode/zaicodeContinueHost.ts", import.meta.url), "utf8");
  assert.match(host, /setTaskUnread\(\{ \.\.\.scope, taskId: sessionId, unread: true \}\)/);
  assert.match(host, /"resumeTask" \| "createTask" \| "setTaskUnread"/);

  // Clearing on visit is the other half and already existed: do not re-implement it.
  const nav = readFileSync(new URL("../src/app-shell/useWorkspaceTaskNavigation.ts", import.meta.url), "utf8");
  assert.match(nav, /unread: false/);
});

test("SRC-131: a finished MAIN row wears the unread dot, an idle one wears the diamond", () => {
  const glyph = readFileSync(new URL("../src/zaicode/ZaicodeProjectMainGlyph.tsx", import.meta.url), "utf8");
  assert.match(glyph, /if \(state === "done"\) return <ZaicodeUnseenDoneDot/);
  // Same dot the task list uses, so the two surfaces read as one state.
  assert.match(glyph, /data-unread-indicator="true"/);
});