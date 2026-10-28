import assert from "node:assert/strict";
import test from "node:test";
import { orderProviderVisibleToolContracts } from "../src/tool/provider-visible-order.js";

const tools = [
  { name: "mcp__fixture__zulu", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "mcp__fixture__alpha", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "Bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
];

test("rediscovered extension tools preserve the exact provider prefix bytes", () => {
  const first = JSON.stringify(orderProviderVisibleToolContracts(tools));
  const second = JSON.stringify(orderProviderVisibleToolContracts([...tools].reverse()));
  assert.equal(second, first);
  assert.deepEqual(orderProviderVisibleToolContracts(tools).map((tool) => tool.name), ["Bash", "Read", "mcp__fixture__alpha", "mcp__fixture__zulu"]);
});

test("sorting does not mutate tool discovery or discard a schema change", () => {
  const before = JSON.stringify(tools);
  orderProviderVisibleToolContracts(tools);
  assert.equal(JSON.stringify(tools), before);
  const changed = tools.map((tool) => tool.name === "Read" ? { ...tool, description: "Changed authority must invalidate the cache" } : tool);
  assert.notEqual(JSON.stringify(orderProviderVisibleToolContracts(changed)), JSON.stringify(orderProviderVisibleToolContracts(tools)));
});
