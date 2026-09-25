import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  isZaicodeWorkspaceDisabled,
  normalizeZaicodeDisabledWorkspaces,
  setZaicodeWorkspaceDisabledIn,
} from "@zcode/shared";
import {
  formatZaicodeClockMinute,
  formatZaicodeDay,
  parseZaicodeClockText,
  parseZaicodeDayText,
  stepZaicodeClockMinute,
  zaicodeMomentOf,
} from "../src/zaicode/zaicodeClockText.js";
import { readZaicodeSlotDropTarget, zaicodeSlotDropId } from "../src/zaicode/ZaicodeSlotDrop.js";
import { collectTerminalTaskNotificationPayloads } from "../src/lib/taskNotificationOrchestrator.js";

test("typed clock times: zeros work, 24-hour, no guessing", () => {
  assert.equal(parseZaicodeClockText("0"), 0);
  assert.equal(parseZaicodeClockText("00"), 0);
  assert.equal(parseZaicodeClockText("00:00"), 0);
  assert.equal(parseZaicodeClockText("0005"), 5);
  assert.equal(parseZaicodeClockText("7"), 420);
  assert.equal(parseZaicodeClockText("730"), 450);
  assert.equal(parseZaicodeClockText("07:30"), 450);
  assert.equal(parseZaicodeClockText("7.30"), 450);
  assert.equal(parseZaicodeClockText("7h30"), 450);
  assert.equal(parseZaicodeClockText("23:59"), 1439);
  assert.equal(parseZaicodeClockText("12am"), 0);
  assert.equal(parseZaicodeClockText("12 pm"), 720);
  assert.equal(parseZaicodeClockText("1:05 pm"), 785);
  for (const bad of ["", "24:00", "7:60", "25", "13pm", "abc", "12:3:4"]) {
    assert.equal(parseZaicodeClockText(bad), null, bad);
  }
  assert.equal(formatZaicodeClockMinute(0), "00:00");
  assert.equal(formatZaicodeClockMinute(450), "07:30");
  assert.equal(stepZaicodeClockMinute(0, -1), 1439);
  assert.equal(stepZaicodeClockMinute(1439, 1), 0);
});

test("typed dates: DD.MM.YYYY, ISO, missing year, impossible dates refused", () => {
  assert.deepEqual(parseZaicodeDayText("25.09.2026", 2020), { year: 2026, month: 9, day: 25 });
  assert.deepEqual(parseZaicodeDayText("2026-09-25", 2020), { year: 2026, month: 9, day: 25 });
  assert.deepEqual(parseZaicodeDayText("25.09", 2027), { year: 2027, month: 9, day: 25 });
  assert.deepEqual(parseZaicodeDayText("1/2/26", 2020), { year: 2026, month: 2, day: 1 });
  assert.equal(parseZaicodeDayText("31.02.2026", 2026), null);
  assert.equal(parseZaicodeDayText("tomorrow", 2026), null);
  assert.equal(formatZaicodeDay({ year: 2026, month: 9, day: 5 }), "05.09.2026");
  const moment = new Date(zaicodeMomentOf({ year: 2026, month: 9, day: 25 }, 0));
  assert.deepEqual([moment.getDate(), moment.getHours(), moment.getMinutes()], [25, 0, 0]);
});

test("project on / off list: normalized, case- and slash-insensitive, bounded", () => {
  assert.deepEqual(normalizeZaicodeDisabledWorkspaces('["V:\\\\a", "V:\\\\a", "", 3]'), ["V:\\a"]);
  assert.deepEqual(normalizeZaicodeDisabledWorkspaces("not json"), []);
  const off = setZaicodeWorkspaceDisabledIn([], "V:\\Work\\_ZAICODE", true);
  assert.equal(isZaicodeWorkspaceDisabled(off, "v:/work/_zaicode"), true);
  assert.equal(isZaicodeWorkspaceDisabled(off, "V:\\Work\\_OTHER"), false);
  assert.deepEqual(setZaicodeWorkspaceDisabledIn(off, "V:\\Work\\_ZAICODE", false), []);
  assert.equal(isZaicodeWorkspaceDisabled(off, null), false);
});

test("slot drop targets are recognised only for real slots", () => {
  assert.equal(readZaicodeSlotDropTarget(zaicodeSlotDropId("SIDE2")), "SIDE2");
  assert.equal(readZaicodeSlotDropTarget("zaicode-slot:NOPE"), null);
  assert.equal(readZaicodeSlotDropTarget("tab-123"), null);
});

function session(sessionId: string, phase: SessionSummary["phase"]): SessionSummary {
  return { sessionId, phase, title: "PHASE SCOUT T-55" } as unknown as SessionSummary;
}

test("a turn the operator stopped raises no 'Task completed' in ZAICODE", () => {
  const formatMessage = ((descriptor: { id: string }) => descriptor.id) as never;
  const previousBySessionId = new Map([["s1", session("s1", "running" as SessionSummary["phase"])]]);
  const stopped = [session("s1", "completedInterrupted")];
  assert.equal(
    collectTerminalTaskNotificationPayloads({ previousBySessionId, sessions: stopped, formatMessage, skipInterrupted: true }).length,
    0,
  );
  // Upstream keeps its behaviour.
  assert.equal(collectTerminalTaskNotificationPayloads({ previousBySessionId, sessions: stopped, formatMessage }).length, 1);
  // A real completion still notifies.
  const done = [session("s1", "completedSuccess")];
  assert.equal(
    collectTerminalTaskNotificationPayloads({ previousBySessionId, sessions: done, formatMessage, skipInterrupted: true }).length,
    1,
  );
});
