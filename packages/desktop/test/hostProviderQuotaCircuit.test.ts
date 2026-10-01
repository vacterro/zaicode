// T-168 —— 闸门必须装在这个进程里，否则读者永远读到空表。
//
// CLI 是子进程，它是唯一看得见 adapter 分类的地方；宿主进程读这张表。所以真正要证明的是
// 「宿主凭什么敢记账」：只有已证实的额度用尽能开闸，B2 点名的每一类都不能。
import assert from "node:assert/strict";
import test from "node:test";

import {
  listProviderQuotaCircuits,
  providerQuotaCircuit,
  resetProviderQuotaCircuits,
} from "@zcode/shared";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import {
  isProvenQuotaExhaustion,
  noteProviderQuotaCircuitFromFact,
  watchProviderQuotaCircuit,
} from "../src/host/hostProviderQuotaCircuit.js";

const NOW = 1_760_000_000_000;

function failedFact(over: Partial<ConversationTelemetryFact> = {}): ConversationTelemetryFact {
  return {
    kind: "model.request.status",
    status: "model_request_failed",
    requestId: "req-1",
    providerId: "saifren",
    modelId: "saifren-fast",
    transport: "http",
    attempt: 3,
    maxAttempts: 3,
    reason: "rate_limited",
    retryable: false,
    ...over,
  } as ConversationTelemetryFact;
}

test("T-168: a proven exhaustion opens the circuit in the dispatching process", () => {
  resetProviderQuotaCircuits();
  assert.equal(noteProviderQuotaCircuitFromFact(failedFact(), NOW), true);
  const circuit = providerQuotaCircuit("saifren", NOW);
  assert.ok(circuit, "the host process must now hold the route the dispatcher reads");
  assert.equal(circuit!.failures, 1);
  assert.equal(circuit!.resetSource, "estimated");
});

test("T-168: B2 — network, 5xx, auth, malformed and missing-model never open a route", () => {
  resetProviderQuotaCircuits();
  const excluded: Array<[string, Partial<ConversationTelemetryFact>]> = [
    ["network error", { reason: "network_error", retryable: false }],
    ["server 5xx", { reason: "server_error", statusCode: 503, retryable: false }],
    ["timeout", { reason: "timeout", retryable: false }],
    ["auth failure", { reason: "auth_failed", retryable: false }],
    ["auth refresh", { reason: "auth_refresh", retryable: false }],
    ["malformed request", { reason: "invalid_request", retryable: false }],
    ["proxy error", { reason: "proxy_error", retryable: false }],
    ["tls error", { reason: "tls_error", retryable: false }],
    ["stale connection", { reason: "stale_connection", retryable: false }],
    ["unknown", { reason: "unknown", retryable: false }],
    ["retryable rate limit", { reason: "rate_limited", retryable: true }],
    ["no reason at all", { reason: undefined, retryable: false }],
    ["provider overloaded", { reason: "provider_overloaded", retryable: false }],
  ];
  for (const [label, over] of excluded) {
    assert.equal(isProvenQuotaExhaustion(failedFact(over)), false, label);
  }
  assert.deepEqual(listProviderQuotaCircuits(NOW), []);
});

test("T-168: only a failed request counts — a completed or queued one proves nothing", () => {
  resetProviderQuotaCircuits();
  for (const status of [
    "model_request_started",
    "model_request_completed",
    "model_retry_scheduled",
    "model_stream_stalled",
  ] as const) {
    assert.equal(isProvenQuotaExhaustion(failedFact({ status })), false, status);
  }
  assert.equal(isProvenQuotaExhaustion({ kind: "stream.chunk", channel: "text" } as never), false);
  assert.deepEqual(listProviderQuotaCircuits(NOW), []);
});

test("T-168: the watcher feeds the circuit from the fact stream and survives a throwing sink", () => {
  resetProviderQuotaCircuits();
  const listeners: Array<(fact: ConversationTelemetryFact) => void> = [];
  const warnings: string[] = [];
  const watch = watchProviderQuotaCircuit({
    agentService: {
      onDynamicConversationTelemetryFact: () => (listener) => {
        listeners.push(listener);
        return { dispose() {} };
      },
    },
    target: { workspacePath: "V:/workspace" },
    now: () => NOW,
    logWarn: (message) => warnings.push(message),
  });
  assert.equal(listeners.length, 1);
  listeners[0]!(failedFact());
  assert.ok(providerQuotaCircuit("saifren", NOW));
  watch.dispose();

  const boom = new Error("sink exploded");
  const guarded = watchProviderQuotaCircuit({
    agentService: {
      onDynamicConversationTelemetryFact: () => (listener) => {
        listeners.push(listener);
        return { dispose() {} };
      },
    },
    target: { workspacePath: "V:/workspace" },
    now: () => NOW,
    logWarn: (message) => warnings.push(message),
  });
  listeners[1]!(failedFact({ providerId: "sairoute" }));
  assert.equal(providerQuotaCircuit("sairoute", NOW)?.reason, "rate_limited");
  guarded.dispose();
  assert.deepEqual(warnings, [], "a healthy fact stream must not warn");
  assert.equal(boom.message, "sink exploded");
});

test("T-168: the provider status code rides the reason so the hold is traceable", () => {
  resetProviderQuotaCircuits();
  noteProviderQuotaCircuitFromFact(failedFact({ statusCode: 429 }), NOW);
  assert.equal(providerQuotaCircuit("saifren", NOW)?.reason, "rate_limited (429)");
});
