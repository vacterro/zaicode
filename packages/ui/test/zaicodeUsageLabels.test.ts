import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildZaicodeUsageLabels,
  displayZaicodeUsageBreakdown,
  zaicodeUsageDisplayName,
  zaicodeUsageStatus,
} from "../src/zaicode/zaicodeUsageLabels.js";

const id = "openai-compatible-chat-39321ca3-0516-4ad0-a4c0-f28d572a8852";
const accountId = "fee91cab-839b-486e-897e-a79fe766f3ac";
const emptyLabels = buildZaicodeUsageLabels([], []);

test("Usage resolves opaque provider and account IDs to the router's display names", () => {
  const labels = buildZaicodeUsageLabels(
    [{ id, name: "SAIFREN", prefix: "stealth" }],
    [{ id: accountId, provider: id, name: "Primary", email: null }],
  );
  assert.equal(zaicodeUsageDisplayName(id, "providers", labels), "SAIFREN");
  assert.equal(zaicodeUsageDisplayName(accountId, "accounts", labels), "SAIFREN · Primary");
  assert.equal(
    zaicodeUsageDisplayName("stealth/space-bunny-alpha", "models", labels),
    "stealth/space-bunny-alpha",
  );
});

test("Usage preserves all metrics when the catalog cannot identify old routes", () => {
  const first = { name: id, requests: 2, input: 100, output: 10, cached: 80, cost: 0.1 };
  const second = { name: accountId, requests: 3, input: 200, output: 20, cached: 160, cost: 0.2 };
  const result = displayZaicodeUsageBreakdown([first, second], "providers", emptyLabels);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.name, "Other providers");
  assert.deepEqual(
    [result[0]!.requests, result[0]!.input, result[0]!.output, result[0]!.cached],
    [5, 300, 30, 240],
  );
  assert.ok(Math.abs(result[0]!.cost - 0.3) < 1e-10);
  assert.equal(first.requests, 2, "display grouping must not mutate the live metrics");
  assert.equal(zaicodeUsageDisplayName(accountId, "accounts", emptyLabels), "Other accounts");
});

test("Usage refuses ID-shaped display names, bounds metadata and keeps useful names", () => {
  const labels = buildZaicodeUsageLabels(
    Array.from({ length: 1000 }, (_, index) => ({
      id: `node-${index}`,
      name: id,
      prefix: "SAIFREN",
    })),
    [{ id: accountId, provider: id, name: accountId, email: null }],
  );
  assert.equal(labels.providers.size, 200);
  assert.equal(labels.accounts.size, 0);
  assert.equal(labels.providers.get("node-0"), "SAIFREN");
  assert.equal(zaicodeUsageDisplayName("a".repeat(32), "providers", labels), "Other providers");
  assert.equal(zaicodeUsageDisplayName("Antigravity", "providers", labels), "Antigravity");
});

test("Usage checks complete identities before truncation so long names cannot conceal an opaque suffix", () => {
  const hiddenId = `${"route ".repeat(60)}${accountId}`;
  assert.equal(zaicodeUsageDisplayName(hiddenId, "providers", emptyLabels), "Other providers");
  assert.equal(zaicodeUsageDisplayName(hiddenId, "models", emptyLabels), "Unknown model");
  const labels = buildZaicodeUsageLabels(
    [{ id, name: hiddenId, prefix: "SAIFREN" }],
    [{ id: accountId, provider: id, name: "Primary", email: null }],
  );
  assert.equal(labels.providers.get(id), "SAIFREN");
  assert.equal(labels.accounts.get(accountId), "SAIFREN · Primary");
  assert.equal(zaicodeUsageDisplayName("Useful name ".repeat(50), "models", emptyLabels).length, 256);
});

test("Usage grouping sums every metric while keeping distinct readable identities", () => {
  const rows = [
    { name: id, requests: 1, input: 2, output: 3, cached: 4, cost: 0.5 },
    { name: accountId, requests: 2, input: 3, output: 4, cached: 5, cost: 0.6 },
    { name: "Antigravity", requests: 10, input: 20, output: 30, cached: 40, cost: 1 },
  ];
  const before = structuredClone(rows);
  const result = displayZaicodeUsageBreakdown(rows, "providers", emptyLabels);
  assert.deepEqual(result.map((row) => row.name), ["Antigravity", "Other providers"]);
  for (const metric of ["requests", "input", "output", "cached", "cost"] as const) {
    assert.ok(
      Math.abs(
        rows.reduce((sum, row) => sum + row[metric], 0) -
          result.reduce((sum, row) => sum + row[metric], 0),
      ) < 1e-10,
    );
  }
  assert.deepEqual(rows, before);
});

test("Usage turns router statuses into readable outcomes without raw error codes", () => {
  assert.equal(zaicodeUsageStatus("ok"), "Done");
  assert.equal(zaicodeUsageStatus("FAILED"), "Failed");
  assert.equal(zaicodeUsageStatus("streaming"), "Running");
  assert.equal(zaicodeUsageStatus("request-39321ca3-0516-4ad0-a4c0-f28d572a8852"), "Unknown");
});
