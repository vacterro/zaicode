import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import { createAgentConversationTransport } from "../src/v4/agentConversationTransport.js";
import { ReplaceableConversationTransport } from "../src/v4/replaceableConversationTransport.js";
import { SessionDataLayer } from "../src/v4/sessionDataLayer.js";
import { ConversationMessageTime } from "../src/v4/ConversationMessageTime.js";
import * as handshake from "../src/v4/agentV4ConnectionHandshake.js";

const sent = Date.UTC(2026, 9, 14, 10, 0);
const intl = { formatMessage: (_: { id: string }, values?: Record<string, string | number>) => `Yesterday ${values?.time}` };
type ClockService = Parameters<typeof createAgentConversationTransport>[0];

function fixture(clientMode: "desktop-continuous" | "web-remote-replayable" = "desktop-continuous") {
  const callbacks: { lifecycle?: (event: { workspaceKey: string; state: "available" | "unavailable" }) => void; restart?: (event: { workspaceKey: string }) => void } = {};
  const state = { epoch: sent + 120000, helloCalls: 0, initializes: 0, delay: null as Promise<void> | null };
  const service = {
    helloConversationV4: async () => {
      state.helloCalls++;
      await state.delay;
      return { kind: "hello", protocolVersion: V4_WIRE_PROTOCOL_VERSION, connectionId: "host-attachment", clientMode,
        deliveryProfile: clientMode === "desktop-continuous" ? "continuous" : "replayable", serverTime: state.epoch,
        capabilities: { nativeDialogs: false, localTerminal: false, binaryFrames: false, compression: "none" }, auth: {} };
    },
    initializeConversationV4: async () => { state.initializes++; },
    conversationRowsRangeV4: async () => ({ rows: [], hasOlder: false }),
    onAgentRuntimeLifecycle: (callback: NonNullable<typeof callbacks.lifecycle>) => { callbacks.lifecycle = callback; return { dispose() {} }; },
    onAgentRuntimeRestarted: (callback: NonNullable<typeof callbacks.restart>) => { callbacks.restart = callback; return { dispose() {} }; },
    onDynamicConversationFrame: () => () => ({ dispose() {} }),
    onDynamicLocalTtftFacts: () => () => ({ dispose() {} }),
  } as unknown as ClockService;
  return { service, state, callbacks, transport: createAgentConversationTransport(service, { workspacePath: "/same/path", workspaceIdentity: "host/project" }) };
}

test("T-338: each delivery profile gets Host time from the real handshake and retains its receipt point", async () => {
  for (const mode of ["desktop-continuous", "web-remote-replayable"] as const) {
    const h = fixture(mode);
    assert.equal(h.transport.readHostNow?.(), null);
    await h.transport.rowsRange({ sessionId: "session", limit: 1 });
    const first = h.transport.readHostNow!();
    assert.ok(first !== null && first >= h.state.epoch && first < h.state.epoch + 1000);
    h.state.epoch += 86400000;
    await h.transport.rowsRange({ sessionId: "session", limit: 1 });
    const next = h.transport.readHostNow!();
    assert.ok(next !== null && next >= first && next < first + 1000, "cached Hello cannot be resampled as a new receipt");
    assert.equal(h.state.helloCalls, 1);
    assert.equal(h.state.initializes, 1);
  }
});

test("T-338: separate Host proxies keep separate clocks on the same workspace path", async () => {
  const a = fixture(), b = fixture();
  b.state.epoch += 7 * 86400000;
  await a.transport.rowsRange({ sessionId: "s", limit: 1 });
  await b.transport.rowsRange({ sessionId: "s", limit: 1 });
  const difference = b.transport.readHostNow!()! - a.transport.readHostNow!()!;
  assert.ok(difference > 7 * 86400000 - 1000 && difference < 7 * 86400000 + 1000);
});

test("T-338: runtime loss hides age and a late recovery cannot resurrect the unavailable clock", async () => {
  const h = fixture();
  const off = h.transport.onRuntimeLifecycle!(() => {});
  try {
    await h.transport.rowsRange({ sessionId: "s", limit: 1 });
    h.callbacks.lifecycle!({ workspaceKey: "host/project", state: "unavailable" });
    assert.equal(h.transport.readHostNow!(), null);
    let release!: () => void;
    h.state.delay = new Promise<void>((resolve) => { release = resolve; });
    h.callbacks.lifecycle!({ workspaceKey: "host/project", state: "available" });
    h.callbacks.lifecycle!({ workspaceKey: "host/project", state: "unavailable" });
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.transport.readHostNow!(), null);
    h.state.delay = null;
    h.state.epoch += 60000;
    h.callbacks.lifecycle!({ workspaceKey: "host/project", state: "available" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(h.transport.readHostNow!()! >= h.state.epoch);
    assert.equal(h.state.initializes, 1, "clock recovery does not duplicate attachment initialization");
  } finally { off(); }
});

test("T-338: replacement and layer disposal expose only the current clock owner", async () => {
  const a = fixture(), b = fixture();
  await a.transport.rowsRange({ sessionId: "s", limit: 1 });
  const replacement = new ReplaceableConversationTransport(a.transport);
  const layer = new SessionDataLayer({ transport: replacement });
  assert.ok(layer.readHostNow()! >= a.state.epoch);
  replacement.replace(b.transport);
  assert.equal(layer.readHostNow(), null);
  b.state.epoch += 3600000;
  await b.transport.rowsRange({ sessionId: "s", limit: 1 });
  assert.ok(layer.readHostNow()! >= b.state.epoch);
  layer.dispose();
  assert.equal(layer.readHostNow(), null);
});

test("T-338: metadata retains exact local/ISO sent time and omits age without a Host clock", () => {
  const html = renderToStaticMarkup(createElement(ConversationMessageTime, { createdAt: sent, locale: "en-US", intl, readHostNow: () => null }));
  assert.match(html, /datetime="2026-10-14T10:00:00.000Z"/i);
  assert.match(html, /data-conversation-age-clock="unavailable"/);
  assert.doesNotMatch(html, /min\. ago|sec\. ago|days ago|>now</);
});

test("T-338: both role leaves use supplied Host time regardless of renderer wall time", () => {
  const oldNow = Date.now;
  try {
    Date.now = () => sent + 14 * 86400000;
    for (const className of ["self-end", undefined]) {
      const html = renderToStaticMarkup(createElement(ConversationMessageTime, { createdAt: sent, locale: "en-US", intl, className, readHostNow: () => sent + 120000 }));
      assert.match(html, /2 min\. ago/);
      assert.match(html, /datetime="2026-10-14T10:00:00.000Z"/i);
    }
  } finally { Date.now = oldNow; }
});

test("T-338: backwards monotonic movement makes the sampled clock unavailable", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "performance");
  let monotonic = 1000;
  Object.defineProperty(globalThis, "performance", { configurable: true, value: { now: () => monotonic } });
  try {
    const h = fixture();
    await handshake.ensureAgentV4ConnectionHandshake(h.service);
    monotonic = 500;
    assert.equal(handshake.readAgentV4HostNow(h.service), null);
  } finally { if (descriptor) Object.defineProperty(globalThis, "performance", descriptor); }
});

test("T-338: invalid calendar epochs never hide a valid sent time behind a fabricated age", () => {
  for (const serverTime of [NaN, Infinity, 1e20])
    assert.equal(handshake.readV4HostClock({ serverTime, receivedAt: 1000 }, 1000), null);
});
