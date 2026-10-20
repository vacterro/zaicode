# 9router Upstream Attribution and Candidate Control Specification

## Context and Operational Boundary

ZAICODE delegates model execution to 9router via standard OpenAI-compatible completions endpoints.
From the perspective of ZAICODE's UI and Client:
- `providerId` represents the router provider instance (e.g., `grouter` or `new-provider`).
- `modelId` represents the requested router combo name or model alias (e.g., `SAIFREN`, `GLM`, `AUTO`).

The internal list of candidate upstream models (e.g., `anthropic/claude-3-7-sonnet`, `openai/gpt-4o`) is configured and owned exclusively by 9router.
ZAICODE must NOT mistake sibling combo IDs (such as `GLM` or `AUTO`) for candidate models inside `SAIFREN`.
ZAICODE must NOT simulate client-side failover between sibling combos when the external router owns internal upstream failover.

## Upstream Attribution Interface Requirements

To enable precise circuit breaker isolation and forensic debugging without penalizing entire combos for single upstream provider timeouts, 9router should supply the following response headers and error payload fields:

### 1. HTTP Response Headers (on both success and error responses)
- `x-router-upstream-model`: Qualified ID of the model that served the response or produced the final failure (e.g., `anthropic/claude-3-7-sonnet`).
- `x-router-upstream-provider`: Provider identity or connection ID of the upstream endpoint.
- `x-router-attempt-count`: Total count of internal upstream attempts executed by 9router during this request.
- `x-router-candidates-exhausted`: Boolean string (`"true"` / `"false"`) indicating whether all candidate models within the combo were exhausted.
- `x-router-request-id`: 9router internal correlation ID for forensic cross-referencing.

### 2. Structured Error JSON Body
When 9router encounters upstream failures (such as `504 Gateway Timeout` or `429 Rate Limited`), the JSON error response should include:
```json
{
  "error": {
    "message": "Gateway timeout connecting to upstream provider",
    "type": "gateway_timeout",
    "code": "upstream_timeout",
    "upstream_model_id": "anthropic/claude-3-7-sonnet",
    "upstream_provider_id": "anthropic-connection-1",
    "router_request_id": "req-9r-7f9a2b",
    "candidate_tried": true,
    "fallback_reason": "timeout"
  }
}
```

## Client Enforcement in ZAICODE

1. **Native 9router Fallback**: When `model: "SAIFREN"` is requested, 9router performs internal failover across its configured candidates natively during request processing.
2. **Honest Attribution**: If 9router returns `upstream_model_id` / `x-router-upstream-model`, ZAICODE attributes the failure to that specific upstream route. If 9router omits upstream identity, ZAICODE records the failure under `diagnosticLimitation: "UPSTREAM_IDENTITY_UNAVAILABLE"` without penalizing sibling combo IDs or guessing.
3. **Absence of Candidate Control**: Because current 9router APIs do not accept request-level candidate exclusion headers, ZAICODE does not simulate client-side re-dispatching of combo models. If the entire combo fails, ZAICODE initiates provider-level fallback through `pickZaicodeFallbackModel()` or waits out the cooldown period.
