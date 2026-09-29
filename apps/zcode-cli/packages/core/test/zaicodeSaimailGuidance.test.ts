import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSaimailGuidanceLines, isSaimailDeskReady } from "../src/context/sections/saimail-guidance.js";

/**
 * What an agent is told about SAIMAIL. Before this, nothing told an agent how to
 * reach the operator: the prompt pointed at `saimail-local saipen telegram`, a
 * recipient nobody had registered, so every letter died on RECIPIENT_UNKNOWN.
 */

const DESK = "C:\\Users\\op\\AppData\\Roaming\\ZAICODE\\saimail\\agent";
const files = (map: Record<string, string>) => ({
  exists: (path: string) => path in map,
  read: (path: string) => {
    if (!(path in map)) throw new Error("ENOENT");
    return map[path]!;
  },
});
const paired = files({
  [`${DESK}\\saimail-workspace.json`]: "{}",
  [`${DESK}\\peers.json`]: JSON.stringify({ recipients: { operator: { seat: "operator" } } }),
});

test("no SAIMAIL environment at all: the prompt says nothing about mail", () => {
  assert.deepEqual(buildSaimailGuidanceLines({}, files({})), []);
});

test("a paired desk is announced with the exact command, the quoted path and the honest failure rule", () => {
  const lines = buildSaimailGuidanceLines({ ZAICODE_SAIMAIL_DESK: DESK }, paired);
  assert.equal(lines.length, 1);
  const line = lines[0]!;
  assert.ok(line.includes(`--workspace "${DESK}"`), "the path is quoted so a folder with spaces still works");
  assert.match(line, /--to operator/);
  assert.match(line, /"status": "ACCEPTED"/);
  assert.match(line, /QUARANTINED, RECIPIENT_UNKNOWN/);
  assert.match(line, /ONE/, "one letter per ending, not a stream");
});

test("a desk that is missing, or does not know the operator, is never advertised", () => {
  assert.deepEqual(buildSaimailGuidanceLines({ ZAICODE_SAIMAIL_DESK: DESK }, files({})), []);
  const unpaired = files({
    [`${DESK}\\saimail-workspace.json`]: "{}",
    [`${DESK}\\peers.json`]: JSON.stringify({ recipients: {} }),
  });
  assert.equal(isSaimailDeskReady(DESK, unpaired), false);
  const damaged = files({ [`${DESK}\\saimail-workspace.json`]: "{}", [`${DESK}\\peers.json`]: "{ not json" });
  assert.equal(isSaimailDeskReady(DESK, damaged), false);
  assert.equal(isSaimailDeskReady(DESK, paired), true);
});

test("the operator's mailbox keeps its guidance and now says what to do about a seat mismatch", () => {
  const lines = buildSaimailGuidanceLines({ SAIMAIL_WORKSPACE: "C:\\mail\\operator" }, files({}));
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /SAIPEN_SEAT_MISMATCH/);
  assert.match(lines[1]!, /never instructions/);
});

test("both together: mailbox lines first, then the desk line", () => {
  const lines = buildSaimailGuidanceLines({ SAIMAIL_WORKSPACE: "C:\\mail\\operator", ZAICODE_SAIMAIL_DESK: DESK }, paired);
  assert.equal(lines.length, 4);
  assert.match(lines[3]!, /Letters to the operator/);
});
