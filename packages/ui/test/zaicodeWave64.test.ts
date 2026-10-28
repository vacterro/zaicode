import assert from "node:assert/strict";
import test from "node:test";
import {
  filterZaicodeSaipenTickets,
  sortZaicodeSaipenTickets,
} from "../src/zaicode/zaicodeSaipenDetail.js";
import {
  matchZaicodeBinding,
  ZAICODE_HOTKEY_ACTIONS,
} from "../src/zaicode/zaicodeHotkeys.js";
import type { ZaicodeSaipenBoardTicket } from "../src/zaicode/zaicodeSaipenModel.js";

function ticket(id: string, title: string, fields: Record<string, string> = {}): ZaicodeSaipenBoardTicket {
  return { id, section: "TODO", priority: null, title, fields };
}

test("SAIPEN pane tickets sort by number, T-2 before T-10 (SRC-049)", () => {
  const board = [ticket("T-10", "later"), ticket("T-2", "early"), ticket("T-9", "mid")];
  assert.deepEqual(
    sortZaicodeSaipenTickets(board, "number").map((entry) => entry.id),
    ["T-2", "T-9", "T-10"],
  );
});

test("board order mode keeps the file's order and both modes are stable", () => {
  const board = [ticket("T-10", "a"), ticket("T-2", "b"), ticket("T-2b", "c")];
  assert.deepEqual(
    sortZaicodeSaipenTickets(board, "board").map((entry) => entry.id),
    ["T-10", "T-2", "T-2b"],
  );
  const numbered = sortZaicodeSaipenTickets(board, "number");
  assert.deepEqual(numbered.map((entry) => entry.id), ["T-2", "T-10", "T-2b"]);
  // no mutation of the caller's array
  assert.deepEqual(board.map((entry) => entry.id), ["T-10", "T-2", "T-2b"]);
});

test("the find field matches id, title, priority and field values, case-insensitively", () => {
  const board = [
    ticket("T-64", "Splash settings"),
    ticket("T-65", "Sidebar section", { needs: "T-64" }),
    ticket("T-66", "Audit machine", { priority: "P1" } as Record<string, string>),
  ];
  assert.deepEqual(filterZaicodeSaipenTickets(board, "t-6").map((entry) => entry.id), ["T-64", "T-65", "T-66"]);
  assert.deepEqual(filterZaicodeSaipenTickets(board, "splash").map((entry) => entry.id), ["T-64"]);
  assert.deepEqual(filterZaicodeSaipenTickets(board, "needs").map((entry) => entry.id), ["T-65"]);
  assert.deepEqual(filterZaicodeSaipenTickets(board, "").length, 3);
  assert.deepEqual(filterZaicodeSaipenTickets(board, "  ").length, 3);
  assert.deepEqual(filterZaicodeSaipenTickets(board, "nope").length, 0);
});

test("a full Exit hotkey exists in-app and globally, Alt+F4 by default (SRC-049)", () => {
  const appExit = ZAICODE_HOTKEY_ACTIONS.find((action) => action.id === "app.exit");
  assert.ok(appExit, "app.exit action registered");
  assert.equal(appExit.scope, "app");
  assert.equal(appExit.defaults[0], "Alt+F4");
  const globalExit = ZAICODE_HOTKEY_ACTIONS.find((action) => action.id === "global.exit");
  assert.ok(globalExit, "global.exit action registered");
  assert.equal(globalExit.scope, "global");
  // Alt+F4 itself must match so the dispatcher can prevent hide-to-tray.
  assert.equal(matchZaicodeBinding("Alt+F4", { key: "F4", code: "F4", ctrlKey: false, altKey: true, shiftKey: false, metaKey: false }), true);
  assert.equal(matchZaicodeBinding("Alt+F4", { key: "F4", code: "F4", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }), false);
});
