import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  projectZaicodeConnectionState,
  zaicodePresenceOverridesWorking,
} from "../src/zaicode/zaicodeConnectionPresence.js";

// Fresh REQ-005: the UI must not show ordinary "Working" while recovery runs.

test("fresh REQ-005: healthy work and idle keep the ordinary rendering", () => {
  assert.deepEqual(projectZaicodeConnectionState({ running: true }), {
    kind: "working",
    label: null,
    detail: null,
  });
  assert.deepEqual(projectZaicodeConnectionState({ running: false }), {
    kind: "idle",
    label: null,
    detail: null,
  });
  assert.equal(zaicodePresenceOverridesWorking(projectZaicodeConnectionState({ running: true })), false);
});

test("fresh REQ-005: first connection failure reads Reconnecting with bounded attempt detail", () => {
  const first = projectZaicodeConnectionState({
    running: true,
    supervisorRoute: "preferred",
    supervisorFailure: "connection-failure",
  });
  assert.equal(first.kind, "reconnecting");
  assert.match(first.label!, /^Reconnecting · attempt \d+\/10$/);

  const third = projectZaicodeConnectionState({
    running: true,
    supervisorStatus: "recovering",
    supervisorAttempts: 3,
  });
  assert.equal(third.kind, "reconnecting");
  assert.equal(third.label, "Reconnecting · attempt 3/10");
});

test("fresh REQ-005: active fallback never claims a second preferred worker", () => {
  const presence = projectZaicodeConnectionState({
    running: true,
    supervisorRoute: "fallback",
    supervisorStatus: "fallback-active",
  });
  assert.equal(presence.kind, "fallback-active");
  assert.equal(presence.label, "Fallback active");
});

test("fresh REQ-005: recovery and fallback both failed reads Interrupted, never Working", () => {
  for (const status of ["unavailable", "preferred-unavailable"]) {
    const presence = projectZaicodeConnectionState({ running: true, supervisorStatus: status });
    assert.equal(presence.kind, "offline");
    assert.equal(presence.label, "Interrupted");
    assert.equal(zaicodePresenceOverridesWorking(presence), true);
  }
});

test("fresh REQ-005: quota exhaustion waits for the reset instead of retrying", () => {
  const presence = projectZaicodeConnectionState({ running: true, quotaWall: true, pendingRetry: true });
  assert.equal(presence.kind, "waiting-quota");
  assert.equal(presence.label, "Waiting for reset");
});

test("fresh REQ-005: a scheduled attempt reads Waiting for retry; healthy resume returns Working", () => {
  const waiting = projectZaicodeConnectionState({ running: true, pendingRetry: true });
  assert.equal(waiting.kind, "waiting-retry");
  const resumed = projectZaicodeConnectionState({ running: true });
  assert.equal(resumed.kind, "working");
});

test("fresh REQ-005: quota outranks fallback, fallback outranks reconnecting", () => {
  const quotaFirst = projectZaicodeConnectionState({
    running: true,
    quotaWall: true,
    supervisorRoute: "fallback",
    supervisorStatus: "fallback-active",
  });
  assert.equal(quotaFirst.kind, "waiting-quota");

  const fallbackFirst = projectZaicodeConnectionState({
    running: true,
    supervisorRoute: "fallback",
    supervisorStatus: "fallback-active",
    supervisorFailure: "connection-failure",
    pendingRetry: true,
  });
  assert.equal(fallbackFirst.kind, "fallback-active");
});

test("fresh REQ-005: restart reconciliation falls out of the inputs", () => {
  // Fresh boot: memory-only ledger and quota wall are empty, supervisor not
  // yet re-polled. A running session must not read as falsely offline.
  const boot = projectZaicodeConnectionState({ running: true });
  assert.equal(boot.kind, "working");
  // Once the existing 15s poll reports recovery, every surface flips together.
  const polled = projectZaicodeConnectionState({
    running: true,
    supervisorStatus: "recovering",
    supervisorAttempts: 1,
  });
  assert.equal(polled.kind, "reconnecting");
});

test("fresh REQ-005: composer mini and sidebar row read the same projector", () => {
  const composer = readFileSync(new URL("../src/zaicode/ZaicodeComposerWorkingFor.tsx", import.meta.url), "utf8");
  assert.match(composer, /useZaicodePresenceSession\(sessionId, running\)/);
  assert.match(composer, /zaicodePresenceOverridesWorking\(presence\)/);
  assert.match(composer, /data-zaicode-presence=\{presence\.kind\}/);

  const sidebar = readFileSync(new URL("../src/WorkspaceSidebarItem.tsx", import.meta.url), "utf8");
  assert.match(sidebar, /useZaicodePresenceProject\(zaicodeRunningCount > 0\)/);
  assert.match(sidebar, /zaicodePresenceOverridesWorking\(zaicodePresence\)/);
  assert.match(sidebar, /data-zaicode-presence=\{zaicodePresence\.kind\}/);
});
