import assert from "node:assert/strict";
import test from "node:test";
import { projectExecutionErrorPayload } from "../src/errors/error-payload.js";

test("projectExecutionErrorPayload projects upstream router attribution fields", () => {
  const error = {
    message: "Turn execution failed",
    context: {
      providerCode: "gateway_timeout",
      providerId: "new-provider",
      modelId: "SAIFREN",
      reason: "timeout",
      retryable: true,
      statusCode: 504,
      upstreamModelId: "qwen-2.5-coder-32b",
      upstreamProviderId: "siliconflow",
      upstreamConnectionId: "conn-123",
      routerRequestId: "r-987",
      comboId: "combo-saifren",
      comboName: "SAIFREN",
      timeoutStage: "stream_body",
      candidateTried: true,
      fallbackReason: "upstream_gateway_timeout",
      attempt: 2,
      retryAfterMs: 30000,
      providerErrorMessage: "upstream connection timeout",
    },
  };

  const payload = projectExecutionErrorPayload(error);
  assert.ok(payload.attribution);
  assert.equal(payload.attribution.providerErrorCode, "gateway_timeout");
  assert.equal(payload.attribution.providerId, "new-provider");
  assert.equal(payload.attribution.modelId, "SAIFREN");
  assert.equal(payload.attribution.reason, "timeout");
  assert.equal(payload.attribution.retryable, true);
  assert.equal(payload.attribution.statusCode, 504);
  assert.equal(payload.attribution.upstreamModelId, "qwen-2.5-coder-32b");
  assert.equal(payload.attribution.upstreamProviderId, "siliconflow");
  assert.equal(payload.attribution.upstreamConnectionId, "conn-123");
  assert.equal(payload.attribution.routerRequestId, "r-987");
  assert.equal(payload.attribution.comboId, "combo-saifren");
  assert.equal(payload.attribution.comboName, "SAIFREN");
  assert.equal(payload.attribution.timeoutStage, "stream_body");
  assert.equal(payload.attribution.candidateTried, true);
  assert.equal(payload.attribution.fallbackReason, "upstream_gateway_timeout");
  assert.equal(payload.attribution.attempt, 2);
  assert.equal(payload.attribution.retryAfterMs, 30000);
  assert.equal(payload.attribution.providerErrorMessage, "upstream connection timeout");
});

test("projectExecutionErrorPayload honestly leaves missing upstream attribution undefined", () => {
  const error = {
    message: "Turn execution failed",
    context: {
      providerCode: "gateway_timeout",
      providerId: "new-provider",
      modelId: "SAIFREN",
      reason: "timeout",
      retryable: true,
    },
  };

  const payload = projectExecutionErrorPayload(error);
  assert.ok(payload.attribution);
  assert.equal(payload.attribution.upstreamModelId, undefined);
  assert.equal(payload.attribution.upstreamProviderId, undefined);
  assert.equal(payload.attribution.comboId, undefined);
});
