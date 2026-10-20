import assert from "node:assert/strict";
import { test } from "node:test";
import { zaicodeSaipenPollerKey } from "../src/zaicode/zaicodeSaipen.js";
import { resolveWorkspaceKey } from "@zcode/shared";

/**
 * T-289 (SRC-191): the Board opened from the composer must be the active
 * chat's own project. The shared SAIPEN poller cache keyed by path alone, so
 * two workspace identities over one path shared one poller — and `subscribe`
 * replays the cached snapshot instantly, flashing the other project's Board.
 */

test("T-289: the poller key separates workspace identities on one path", () => {
  const a = zaicodeSaipenPollerKey("V:/proj", "id-a");
  const b = zaicodeSaipenPollerKey("V:/proj", "id-b");
  assert.notEqual(a, b, "different identities must not share a poller");
});

test("T-289: the poller key is stable for one identity", () => {
  assert.equal(
    zaicodeSaipenPollerKey("V:/proj", "id-a"),
    zaicodeSaipenPollerKey("V:/proj", "id-a"),
  );
  assert.notEqual(
    zaicodeSaipenPollerKey("V:/proj"),
    zaicodeSaipenPollerKey("V:/proj", "id-a"),
    "anonymous and identified mounts must not share a poller",
  );
});

test("T-289: the poller key matches the canonical workspace key", () => {
  assert.equal(
    zaicodeSaipenPollerKey("V:/proj", "id-a"),
    resolveWorkspaceKey({ workspacePath: "V:/proj", workspaceIdentity: "id-a" }),
  );
});
