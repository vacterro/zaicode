import assert from "node:assert/strict";
import test from "node:test";
import { formatConversationWorkDuration } from "../src/v4/conversationWorkDuration.js";
import {
  resolveConversationTurnWorkDurationMs,
  buildConversationTurnWorkSegments,
} from "../src/v4/conversationTurnWorkSegments.js";
import type { IntlInstance } from "../src/i18n/IntlProvider.js";

const intl = { formatMessage: ({ id }: { id: string }) => id.split(".").at(-1) } as IntlInstance;
const now = 1_800_000_000_000;

test("non-finite or negative durations remain unknown rather than becoming a fabricated second", () => {
  for (const duration of [undefined, NaN, Infinity, -Infinity, -1]) {
    assert.equal(formatConversationWorkDuration(duration, intl, "en-US"), null, String(duration));
  }
  assert.equal(formatConversationWorkDuration(0, intl, "en-US"), "1second");
  assert.equal(formatConversationWorkDuration(9_300_000, intl, "en-US"), "2hour 35minute");
});

test("unknown or invalid run starts never produce an elapsed duration or advancing clock", () => {
  for (const startedAt of [undefined, 0, -1, NaN, Infinity, -Infinity, now + 1]) {
    const header = { kind: "turnHeader", startedAt, executionKind: "agent" } as never;
    assert.equal(resolveConversationTurnWorkDurationMs(header, { nowMs: now }, true), undefined, String(startedAt));
    const segments = buildConversationTurnWorkSegments({
      key: "restored-active", header,
      orderedRows: [{ kind: "reasoning", rowId: 1, turnId: "t", entityId: "reason", text: "active", state: "complete" }] as never,
      assistantTailRows: [], isRunning: true, isLastTurn: true, isInterrupted: false,
      forceOpenHistory: false, timelineOnly: false, nowMs: now,
    });
    assert.equal(segments[0]?.workStatus?.state, "running");
    assert.equal(segments[0]?.workStatus?.durationMs, undefined);
    assert.equal(segments[0]?.workStatus?.clockStartedAt, undefined);
  }
});

test("known starts and recorded terminal durations retain authoritative facts", () => {
  const header = { startedAt: now - 9_300_000 } as never;
  assert.equal(resolveConversationTurnWorkDurationMs(header, { nowMs: now }, true), 9_300_000);
  assert.equal(resolveConversationTurnWorkDurationMs(header, { nowMs: now }, false), undefined);
  assert.equal(resolveConversationTurnWorkDurationMs({ activeMs: 0 } as never, { nowMs: now }, true), 0);
  assert.equal(resolveConversationTurnWorkDurationMs({ startedAt: now - 1000, endedAt: now } as never, {}, false), 1000);
  for (const activeMs of [NaN, Infinity, -1]) {
    assert.equal(resolveConversationTurnWorkDurationMs({ activeMs } as never, { nowMs: now }, true), undefined);
  }
});
