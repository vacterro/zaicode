import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  projectZaicodeConnectionState,
  zaicodePresenceIndicator,
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

// T-298: the project-row presence must stay a compact indicator so the project
// name keeps the row's space.

test("T-298: a global retry halt is a halt, never a model or transport failure", () => {
  const halted = projectZaicodeConnectionState({ running: true, halted: true });
  assert.equal(halted.kind, "halted");
  assert.equal(halted.label, "Retries stopped");
  assert.equal(zaicodePresenceOverridesWorking(halted), true);
  // The detail must never read as the connection, router or model being down.
  assert.match(halted.detail!, /Automatic retries were stopped/);
  assert.doesNotMatch(halted.detail!, /connection|router|model|API/i);
  // A halt without a supervisor failure is not the offline state either.
  assert.notEqual(halted.kind, "offline");
});

test("T-298: every exceptional presence maps to a compact glyph and at most a very short readout", () => {
  assert.deepEqual(zaicodePresenceIndicator(projectZaicodeConnectionState({ running: true })), {
    glyph: "none",
    short: "",
  });
  assert.deepEqual(zaicodePresenceIndicator(projectZaicodeConnectionState({ running: false })), {
    glyph: "none",
    short: "",
  });
  assert.deepEqual(
    zaicodePresenceIndicator(
      projectZaicodeConnectionState({ running: true, supervisorStatus: "recovering", supervisorAttempts: 3 }),
    ),
    { glyph: "refresh", short: "3/10" },
  );
  for (const input of [
    { running: true, pendingRetry: true },
    { running: true, quotaWall: true },
  ]) {
    assert.equal(zaicodePresenceIndicator(projectZaicodeConnectionState(input)).glyph, "clock");
    assert.equal(zaicodePresenceIndicator(projectZaicodeConnectionState(input)).short, "");
  }
  assert.deepEqual(
    zaicodePresenceIndicator(
      projectZaicodeConnectionState({ running: true, supervisorRoute: "fallback", supervisorStatus: "fallback-active" }),
    ),
    { glyph: "cloud", short: "" },
  );
  assert.deepEqual(zaicodePresenceIndicator(projectZaicodeConnectionState({ running: true, halted: true })), {
    glyph: "halt",
    short: "",
  });
  assert.deepEqual(zaicodePresenceIndicator(projectZaicodeConnectionState({ running: true, supervisorStatus: "unavailable" })), {
    glyph: "alert",
    short: "",
  });
  // No compact indicator may ever carry a full label: the zone is name-width.
  for (const input of [
    { running: true, halted: true },
    { running: true, pendingRetry: true },
    { running: true, quotaWall: true },
    { running: true, supervisorStatus: "unavailable" },
    { running: true, supervisorStatus: "recovering", supervisorAttempts: 3 },
  ]) {
    const presence = projectZaicodeConnectionState(input);
    const indicator = zaicodePresenceIndicator(presence);
    assert.ok(!indicator.short.includes(presence.label!), "short readout must not repeat the label");
    assert.ok(indicator.short.length <= 5, `short readout stays tiny (saw "${indicator.short}")`);
  }
});

test("T-298: the sidebar row draws the compact indicator, never the raw label", () => {
  const sidebar = readFileSync(new URL("../src/WorkspaceSidebarItem.tsx", import.meta.url), "utf8");
  assert.match(sidebar, /zaicodePresenceIndicator\(presence\)/);
  assert.match(sidebar, /<ZaicodeRowPresenceIndicator presence=\{zaicodePresence\} \/>/);
  // The full label stays available for hover and accessible names.
  assert.match(sidebar, /aria-label=\{presence\.label \?\? "Connection state"\}/);
  assert.match(sidebar, /data-zaicode-presence-indicator=\{presence\.kind\}/);
  // Negative control: the row status zone must not render the label as text.
  assert.doesNotMatch(sidebar, /\? zaicodePresence\.label :/);
});
