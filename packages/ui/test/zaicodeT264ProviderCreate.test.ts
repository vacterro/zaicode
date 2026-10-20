import assert from "node:assert/strict";
import { test } from "node:test";
import type { ZaicodeRouterCall, ZaicodeRouterResponse } from "@zcode/shared";
import {
  createProviderSubmission,
  createZaicodeProviderWithKey,
  findMatchingProviderNode,
  type ZaicodeProviderCreateInput,
} from "../src/zaicode/zaicodeRouterProviderCreate.js";
import { useZaicodeRouter, zaicodeRouterCatalogueUrl } from "../src/zaicode/zaicodeRouter.js";

/**
 * T-264 Phase C/E/A: provider creation is a recoverable two-step transaction,
 * a failed list read never masquerades as an empty router, and the catalogue
 * always points at the effective endpoint.
 */

const input: ZaicodeProviderCreateInput = {
  type: "openai-compatible",
  name: "My provider",
  prefix: "mine",
  baseUrl: "https://api.example.com/v1",
  apiType: "chat",
  apiKey: "sk-test",
};

const ok = (data: unknown = null): ZaicodeRouterResponse => ({ ok: true, status: 200, data, message: "" });
const fail = (message: string): ZaicodeRouterResponse => ({ ok: false, status: 500, data: null, message });

function script(responses: Array<ZaicodeRouterResponse | Error>) {
  const seen: ZaicodeRouterCall[] = [];
  const call = async (c: ZaicodeRouterCall): Promise<ZaicodeRouterResponse> => {
    seen.push(c);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, "unexpected extra router call");
    return next as ZaicodeRouterResponse;
  };
  return { seen, call };
}

test("T-264 C1: success creates the node, then the key", async () => {
  const { seen, call } = script([
    ok({ node: { id: "n1" } }),
    ok({ id: "c1" }),
  ]);
  const result = await createZaicodeProviderWithKey(call, [], input);
  assert.deepEqual(result, { kind: "created", nodeId: "n1", reusedNode: false });
  assert.equal(seen[0]!.path, "/api/provider-nodes");
  assert.equal(seen[1]!.path, "/api/providers");
  assert.equal((seen[1]!.body as { provider: string }).provider, "n1");
});

test("T-264 C2: node creation failure stops before the key", async () => {
  const { seen, call } = script([fail("node rejected")]);
  const result = await createZaicodeProviderWithKey(call, [], input);
  assert.deepEqual(result, { kind: "node-failed", message: "node rejected" });
  assert.equal(seen.length, 1);
});

test("T-264 C3: key failure keeps the node id for retry", async () => {
  const { call } = script([ok({ node: { id: "n1" } }), fail("bad key")]);
  const result = await createZaicodeProviderWithKey(call, [], input);
  assert.deepEqual(result, { kind: "key-failed", nodeId: "n1", message: "bad key" });
});

test("T-264 C4: timeout after server-side success reconciles instead of duplicating", async () => {
  let calls = 0;
  const flaky = async (c: ZaicodeRouterCall): Promise<ZaicodeRouterResponse> => {
    calls += 1;
    if (c.path === "/api/provider-nodes") throw new Error("timeout");
    return ok({ id: "c1" });
  };
  const first = await createZaicodeProviderWithKey(flaky, [], input);
  assert.equal(first.kind, "node-failed");
  // The operator retries after a refresh that now lists the committed node.
  const committed = [{ id: "n1", type: "openai-compatible", name: "My provider", prefix: "mine", baseUrl: "https://api.example.com/v1", apiType: "chat" }];
  const second = await createZaicodeProviderWithKey(flaky, committed, input);
  assert.deepEqual(second, { kind: "created", nodeId: "n1", reusedNode: true });
  assert.equal(calls, 2, "one node POST attempt plus one key POST, never a second node");
});

test("T-264 C5: double submission runs a single flight", async () => {
  const submission = createProviderSubmission();
  let flights = 0;
  const flight = () => new Promise<string>((resolve) => setTimeout(() => { flights += 1; resolve("done"); }, 5));
  const [first, second] = await Promise.all([submission.run(flight), submission.run(flight)]);
  assert.equal(first, "done");
  assert.equal(second, null);
  assert.equal(flights, 1);
  assert.equal(submission.pending, false);
});

test("T-264 C6: retry after partial success posts only the key", async () => {
  const nodes = [{ id: "n9", type: "openai-compatible", name: "My provider", prefix: "mine", baseUrl: "https://api.example.com/v1", apiType: "chat" }];
  const { seen, call } = script([ok({ id: "c9" })]);
  const result = await createZaicodeProviderWithKey(call, nodes, input);
  assert.deepEqual(result, { kind: "created", nodeId: "n9", reusedNode: true });
  assert.deepEqual(seen.map((c) => c.path), ["/api/providers"]);
});

test("T-264 C7: reopening the form finds the pending node", () => {
  const nodes = [{ id: "n9", type: "openai-compatible", name: "My provider", prefix: "mine", baseUrl: "https://api.example.com/v1", apiType: "chat" }];
  assert.equal(findMatchingProviderNode(nodes, { prefix: "MINE", name: "other", baseUrl: "https://x" })?.id, "n9");
  assert.equal(
    findMatchingProviderNode(nodes, { prefix: "", name: "My provider", baseUrl: "https://api.example.com/v1/" })?.id,
    "n9",
  );
  assert.equal(findMatchingProviderNode([], { prefix: "mine", name: "My provider", baseUrl: "https://api.example.com/v1" }), null);
});

test("T-264 E: a failed provider read keeps the last trustworthy connections", async () => {
  const holder = globalThis as unknown as { window?: unknown };
  const realWindow = holder.window;
  const seedConnections = [{ id: "c1", provider: "n1" }];
  const routes = new Map<string, ZaicodeRouterResponse>([
    ["/api/version", ok({ currentVersion: "9.9.9" })],
    ["/api/providers", fail("connection reset")],
    ["/api/provider-nodes", ok({ nodes: [] })],
    ["/api/combos", ok({ combos: [] })],
    ["/api/models", ok({ models: [] })],
    ["/api/settings", ok({})],
    ["/api/usage/stats?period=today", ok({})],
  ]);
  holder.window = {
    zcode: {
      callZaicodeRouter: async (call: ZaicodeRouterCall) => routes.get(call.path) ?? fail("no route"),
      getZaicodeRouterInfo: async () => ({ url: "http://127.0.0.1:1", dataDir: "", installed: true, credential: false, extraUpdateScript: null }),
    },
  };
  try {
    useZaicodeRouter.setState({
      status: "up",
      message: "",
      connections: seedConnections as never,
      nodes: [],
    });
    await useZaicodeRouter.getState().refresh();
    const state = useZaicodeRouter.getState();
    assert.equal(state.status, "up");
    assert.deepEqual(state.connections, seedConnections, "stale read must not look like an empty router");
    assert.match(state.message, /connection reset/);
  } finally {
    holder.window = realWindow;
    useZaicodeRouter.setState({ status: "idle", message: "", connections: [], nodes: [], combos: [], models: [], settings: null, usage: null });
  }
});

test("T-264 E: a successful read replaces the lists", async () => {
  const holder = globalThis as unknown as { window?: unknown };
  const realWindow = holder.window;
  const full = (data: unknown) => ok(data);
  const routes = new Map<string, ZaicodeRouterResponse>([
    ["/api/version", full({ currentVersion: "9.9.9" })],
    ["/api/providers", full({ connections: [{ id: "c2", provider: "n2" }] })],
    ["/api/provider-nodes", full({ nodes: [] })],
    ["/api/combos", full({ combos: [] })],
    ["/api/models", full({ models: [] })],
    ["/api/settings", full({})],
    ["/api/usage/stats?period=today", full({})],
  ]);
  holder.window = {
    zcode: {
      callZaicodeRouter: async (call: ZaicodeRouterCall) => routes.get(call.path) ?? fail("no route"),
      getZaicodeRouterInfo: async () => null,
    },
  };
  try {
    useZaicodeRouter.setState({ status: "idle", message: "", connections: [], nodes: [] });
    await useZaicodeRouter.getState().refresh();
    const state = useZaicodeRouter.getState();
    assert.equal(state.status, "up");
    assert.deepEqual(state.connections.map((c) => c.id), ["c2"]);
    assert.equal(state.message, "");
  } finally {
    holder.window = realWindow;
    useZaicodeRouter.setState({ status: "idle", message: "", connections: [], nodes: [], combos: [], models: [], settings: null, usage: null });
  }
});

test("T-264 A: the catalogue URL prefers the effective endpoint", () => {
  assert.equal(
    zaicodeRouterCatalogueUrl("http://127.0.0.1:3101/", "http://127.0.0.1:9999"),
    "http://127.0.0.1:3101/dashboard/providers",
  );
  assert.equal(
    zaicodeRouterCatalogueUrl(null, "http://127.0.0.1:9999/"),
    "http://127.0.0.1:9999/dashboard/providers",
  );
  assert.equal(zaicodeRouterCatalogueUrl(null, null), null);
  assert.equal(zaicodeRouterCatalogueUrl("  ", undefined), null);
});
