import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { useZaicodeArchiveUndo } from "../src/zaicode/zaicodeArchiveUndo.js";

/**
 * R016 (SRC-151) regression pin: the archive/cleanup notice used to cover part of the
 * sidebar for a few seconds. It now occupies one bounded row of the workspace column,
 * in normal flow, so it can never overlap the sidebar.
 *
 * The layout acceptance is a CSS contract (jsdom has no layout), so the geometry is
 * pinned by source invariant and the store's announce/undo behaviour is pinned by
 * exercising the real store.
 */
const here = import.meta.dirname;
const noticeSource = readFileSync(join(here, "../src/zaicode/ZaicodeArchiveNotice.tsx"), "utf8");
const shellSource = readFileSync(join(here, "../src/app-shell/WorkspaceShellLayout.tsx"), "utf8");

test("R016 the notice is one bounded in-flow row, not an overlay", () => {
  assert.match(noticeSource, /data-zaicode-archive-notice/);
  assert.match(noticeSource, /role="status"/);
  // Bounded row: a fixed short height, it may shrink, and long titles truncate.
  assert.match(noticeSource, /flex h-8 min-w-0 shrink-0 items-center/);
  assert.match(noticeSource, /className="min-w-0 flex-1 truncate"/);
  // In normal flow. Absolute/fixed positioning is what let it cover the sidebar before.
  assert.equal(/\b(absolute|fixed)\b/.test(noticeSource), false, "the notice must stay in flow");
  assert.equal(/\binset-|\btop-\[|\bleft-\[|\bbottom-\[/.test(noticeSource), false);
});

test("R016 the notice is mounted inside the workspace column, over the chat", () => {
  const mount = shellSource.match(/\{[^}]*<ZaicodeArchiveNotice \/>[^}]*\}/);
  assert.ok(mount, "the notice must be mounted by the workspace shell");
  assert.match(mount[0], /isWorkspaceVisible/);
  assert.match(mount[0], /isZaicodeProductMode\(\)/);
});

test("R016 an archive announces itself with an undo, and undo restores the last batch", async () => {
  const state = useZaicodeArchiveUndo.getState();
  state.clearNotice();
  const restored: string[] = [];
  state.push({ label: "sess-1", restore: async () => void restored.push("sess-1") });
  const announced = useZaicodeArchiveUndo.getState();
  assert.equal(announced.noticeUndoable, true, "an archive offers Undo");
  assert.match(String(announced.notice), /^Archived sess-1/);
  assert.equal(await useZaicodeArchiveUndo.getState().undo(), true);
  assert.deepEqual(restored, ["sess-1"], "Undo really restores");
  const afterUndo = useZaicodeArchiveUndo.getState();
  assert.equal(afterUndo.noticeUndoable, false, "a restore is not itself undoable");
  assert.match(String(afterUndo.notice), /^Restored sess-1/);
});

test("R016 a restore that fails says so instead of silently claiming success", async () => {
  useZaicodeArchiveUndo.getState().clearNotice();
  useZaicodeArchiveUndo.getState().push({ label: "sess-2", restore: async () => Promise.reject(new Error("boom")) });
  assert.equal(await useZaicodeArchiveUndo.getState().undo(), false);
  assert.match(String(useZaicodeArchiveUndo.getState().notice), /^Restore failed: boom$/);
});

test("R016 the archive undo ring stays bounded", () => {
  useZaicodeArchiveUndo.getState().clearNotice();
  for (let index = 0; index < 80; index += 1)
    useZaicodeArchiveUndo.getState().push({ label: `ring-${index}`, restore: async () => {} });
  const entries = useZaicodeArchiveUndo.getState().entries;
  assert.equal(entries.length <= 50, true, "the ring must not grow without bound");
  assert.equal(entries.at(-1)?.label, "ring-79", "the newest entry is kept");
});

test("R016 clearing the notice leaves nothing announcing an archive", () => {
  useZaicodeArchiveUndo.getState().push({ label: "sess-3", restore: async () => {} });
  useZaicodeArchiveUndo.getState().clearNotice();
  const cleared = useZaicodeArchiveUndo.getState();
  assert.equal(cleared.notice, null);
  assert.equal(cleared.noticeUndoable, false);
});
