// T-164 / SRC-116 TRACK B (B2) —— 配额熔断只对"真的用完了"开。
//
// `toAdapterError` 是每一次 provider 失败的唯一归一化出口，熔断就挂在这里。SRC-116 的
// B2 点名了五类不能被当成配额耗尽的情况：网络错误、模型不存在、鉴权失败、请求格式错、
// 服务端 5xx。这条测试就是把那五类钉死。
import assert from "node:assert/strict";
import test from "node:test";

import { ModelErrorCode } from "@zcode/contracts";
import {
  listProviderQuotaCircuits,
  providerQuotaCircuit,
  resetProviderQuotaCircuits,
} from "@zcode/shared";
import { toAdapterError } from "../src/model/runner-retry.js";
import type { ClassifiedModelFailure } from "../src/model/failure-classifier.js";
import type { ModelStatusContext } from "../src/model/runner-status.js";

const STATUS_CONTEXT = {
  traceId: "trace-1",
  requestId: "req-1",
  providerId: "glm",
  modelId: "glm-4.6",
  modelRequestSessionType: "chat",
  transport: "http",
  maxAttempts: 3,
  modelCall: { providerId: "glm", modelId: "glm-4.6" },
} as unknown as ModelStatusContext;

function failure(over: Partial<ClassifiedModelFailure>): ClassifiedModelFailure {
  return {
    code: ModelErrorCode.ModelRateLimited,
    message: "quota exhausted",
    reason: "rate_limited",
    retryReason: "none",
    retryable: false,
    ...over,
  } as ClassifiedModelFailure;
}

function run(f: ClassifiedModelFailure, providerId = "glm"): void {
  toAdapterError(new Error(f.message), f, { ...STATUS_CONTEXT, providerId } as ModelStatusContext, 1);
}

test("a non-retryable rate limit opens the provider's circuit", () => {
  resetProviderQuotaCircuits();
  run(failure({}));
  const circuit = providerQuotaCircuit("glm", Date.now());
  assert.ok(circuit !== null);
  assert.equal(circuit?.providerId, "glm");
  assert.equal(circuit?.failures, 1);
});

test("B2: a network error is not quota exhaustion", () => {
  resetProviderQuotaCircuits();
  run(failure({ code: ModelErrorCode.ModelRequestFailed, message: "socket hang up", reason: "network" }));
  assert.equal(providerQuotaCircuit("glm", Date.now()), null);
});

test("B2: a 5xx is not quota exhaustion", () => {
  resetProviderQuotaCircuits();
  run(failure({ code: ModelErrorCode.ModelRequestFailed, message: "502 bad gateway", statusCode: 502 }));
  assert.equal(providerQuotaCircuit("glm", Date.now()), null);
});

test("B2: model-not-found is not quota exhaustion", () => {
  resetProviderQuotaCircuits();
  run(failure({ code: ModelErrorCode.ModelNotFound, message: "model does not exist" }));
  assert.equal(providerQuotaCircuit("glm", Date.now()), null);
});

test("B2: an auth failure is not quota exhaustion", () => {
  resetProviderQuotaCircuits();
  run(failure({ code: ModelErrorCode.ModelRequestAuthMissing, message: "invalid api key" }));
  assert.equal(providerQuotaCircuit("glm", Date.now()), null);
});

test("B2: a malformed request is not quota exhaustion", () => {
  resetProviderQuotaCircuits();
  run(failure({ code: ModelErrorCode.InvalidModelRequest, message: "malformed body" }));
  assert.equal(providerQuotaCircuit("glm", Date.now()), null);
});

test("a retryable rate limit does not open the circuit: the route is still working", () => {
  resetProviderQuotaCircuits();
  run(failure({ retryable: true, retryReason: "transient" }));
  assert.equal(providerQuotaCircuit("glm", Date.now()), null);
});

test("a failure with no resolved provider id cannot be attributed to a route", () => {
  resetProviderQuotaCircuits();
  // null, not undefined: a default parameter would swallow undefined and pass "glm".
  run(failure({}), null as unknown as string);
  assert.deepEqual(listProviderQuotaCircuits(Date.now()), []);
});

test("a vendor reset time wins over the default cooldown", () => {
  resetProviderQuotaCircuits();
  run(failure({ retryAfterMs: 5 * 60_000 }));
  const circuit = providerQuotaCircuit("glm", Date.now());
  assert.equal(circuit?.resetSource, "retry-after");
  assert.ok((circuit?.until ?? 0) - Date.now() > 4 * 60_000);
});
