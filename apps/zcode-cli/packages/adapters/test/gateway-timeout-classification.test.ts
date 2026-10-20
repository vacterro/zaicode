import assert from "node:assert/strict";
import test from "node:test";
import { ModelErrorCode, ModelFailureReason } from "@zcode/contracts";
import { classifyModelFailure } from "../src/model/failure-classifier.js";
import { ProviderBusinessError } from "../src/model/model-execution.js";

test("classifies gateway_timeout ProviderBusinessError as retryable timeout", () => {
  const error = new ProviderBusinessError({
    providerCode: "gateway_timeout",
    providerId: "new-provider",
    providerKind: "openai-compatible",
    providerMessage: "upstream connection...",
    providerRequestId: "f355417e-c361-4602-9c8a-0e83ec6e6ea7",
  });

  const classified = classifyModelFailure(error);
  assert.equal(classified.code, ModelErrorCode.ModelRequestTimeout);
  assert.equal(classified.reason, ModelFailureReason.Timeout);
  assert.equal(classified.retryable, true);
  assert.equal(classified.message, "upstream connection...");
});

test("classifies HTTP 504 status code as retryable timeout", () => {
  const error = new Error("Gateway Timeout");
  (error as unknown as { statusCode: number }).statusCode = 504;

  const classified = classifyModelFailure(error);
  assert.equal(classified.code, ModelErrorCode.ModelRequestTimeout);
  assert.equal(classified.reason, ModelFailureReason.Timeout);
  assert.equal(classified.retryable, true);
});

test("preserves non-retryable classification for unknown provider business errors", () => {
  const error = new ProviderBusinessError({
    providerCode: "completely_unknown_error_xyz",
    providerId: "new-provider",
    providerKind: "openai-compatible",
    providerMessage: "something random failed",
  });

  const classified = classifyModelFailure(error);
  assert.equal(classified.retryable, false);
  assert.equal(classified.reason, ModelFailureReason.Unknown);
});

test("extracts upstream request attribution from ProviderBusinessError and populates adapter error context", async () => {
  const { toAdapterError } = await import("../src/model/runner-retry.js");
  const error = new ProviderBusinessError({
    providerCode: "gateway_timeout",
    providerId: "new-provider",
    providerKind: "openai-compatible",
    providerMessage: "upstream connection...",
    providerRequestId: "f355417e-c361-4602-9c8a-0e83ec6e6ea7",
    upstreamModelId: "qwen-2.5-coder-32b",
    upstreamProviderId: "siliconflow",
    upstreamConnectionId: "conn-123",
    routerRequestId: "r-987",
    comboId: "combo-saifren",
    comboName: "SAIFREN",
    timeoutStage: "stream_header",
    candidateTried: true,
    fallbackReason: "upstream_gateway_timeout",
  });

  const failure = classifyModelFailure(error);
  const statusContext = {
    sessionId: "sess_1",
    requestId: "req_1",
    traceId: "trace_1",
    modelId: "SAIFREN",
    providerId: "new-provider",
    providerKind: "openai-compatible" as const,
    transport: "http" as const,
    maxAttempts: 3,
  };

  const adapterError = toAdapterError(error, failure, statusContext, 1);
  assert.equal(adapterError.context.upstreamModelId, "qwen-2.5-coder-32b");
  assert.equal(adapterError.context.upstreamProviderId, "siliconflow");
  assert.equal(adapterError.context.upstreamConnectionId, "conn-123");
  assert.equal(adapterError.context.routerRequestId, "r-987");
  assert.equal(adapterError.context.comboId, "combo-saifren");
  assert.equal(adapterError.context.comboName, "SAIFREN");
  assert.equal(adapterError.context.timeoutStage, "stream_header");
  assert.equal(adapterError.context.candidateTried, true);
  assert.equal(adapterError.context.fallbackReason, "upstream_gateway_timeout");
});

test("honestly leaves missing upstream model attribution undefined (never guesses)", async () => {
  const { toAdapterError } = await import("../src/model/runner-retry.js");
  const error = new ProviderBusinessError({
    providerCode: "gateway_timeout",
    providerId: "new-provider",
    providerKind: "openai-compatible",
    providerMessage: "upstream connection...",
    providerRequestId: "f355417e-c361-4602-9c8a-0e83ec6e6ea7",
  });

  const failure = classifyModelFailure(error);
  const statusContext = {
    sessionId: "sess_1",
    requestId: "req_1",
    traceId: "trace_1",
    modelId: "SAIFREN",
    providerId: "new-provider",
    providerKind: "openai-compatible" as const,
    transport: "http" as const,
    maxAttempts: 3,
  };

  const adapterError = toAdapterError(error, failure, statusContext, 1);
  assert.equal(adapterError.context.upstreamModelId, undefined);
  assert.equal(adapterError.context.upstreamProviderId, undefined);
});

