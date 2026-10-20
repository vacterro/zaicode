import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { callZaicodeRouter, setZaicodeRouterTarget } from "../src/main/zaicodeRouterTransport.js";

type Pool = { id: string; name: string; models: string[]; kind?: string };

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "zaicode-recovery-"));
  const state = {
    combos: [{ id: "free", name: "SAIFREN", models: ["p/A", "p/B"] }] as Pool[],
    malformed: false,
    refuse: "",
  };
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const path = request.url ?? "";
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path === "/api/combos") {
      response.end(
        JSON.stringify(state.malformed ? { combos: "broken" } : { combos: state.combos }),
      );
      return;
    }
    writes.push({ method: request.method ?? "", path, body });
    if (state.refuse && path.endsWith(state.refuse)) {
      response.writeHead(503).end(JSON.stringify({ error: "fixture write refused" }));
      return;
    }
    if (request.method === "POST" && path === "/api/combos") {
      const pool = { ...body, id: `new-${state.combos.length}` } as Pool;
      state.combos.push(pool);
      response.end(JSON.stringify(pool));
      return;
    }
    const pool = state.combos.find((item) => path === `/api/combos/${item.id}`);
    if (!pool) {
      response.writeHead(404).end('{"error":"Combo not found"}');
      return;
    }
    if (request.method === "PUT") Object.assign(pool, body);
    if (request.method === "DELETE") state.combos = state.combos.filter((item) => item !== pool);
    response.end(JSON.stringify(pool));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const target = { url, dataDir };
  setZaicodeRouterTarget(target);
  t.after(async () => {
    setZaicodeRouterTarget(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { state, writes, target };
}

const edit = (models: string[], baselineModels = ["p/A", "p/B"]) =>
  callZaicodeRouter({ method: "PUT", path: "/api/combos/free", body: { models }, baselineModels });

async function history() {
  const response = await callZaicodeRouter({ method: "GET", path: "/zaicode/recovery" });
  assert.equal(response.ok, true, response.message);
  return response.data as {
    snapshots: { id: string; label: string; kind: string; models: number }[];
    unreadable: number;
  };
}

test("a drag preserves an external addition and an external removal is not revived", async (t) => {
  const { state } = await fixture(t);
  await callZaicodeRouter({ method: "GET", path: "/api/combos" });
  state.combos[0]!.models.push("p/EXTERNAL");
  assert.equal((await edit(["p/B", "p/A"])).ok, true);
  assert.deepEqual(state.combos[0]!.models, ["p/B", "p/A", "p/EXTERNAL"]);
  state.combos[0]!.models = ["p/A", "p/EXTERNAL"];
  assert.equal((await edit(["p/B", "p/A"])).ok, true);
  assert.deepEqual(state.combos[0]!.models, ["p/A", "p/EXTERNAL"]);
});

test("add/remove intents preserve an external reorder; incompatible reorders refuse without PUT", async (t) => {
  const { state, writes } = await fixture(t);
  state.combos[0]!.models = ["p/B", "p/A"];
  assert.equal((await edit(["p/A", "p/B", "p/LOCAL"])).ok, true);
  assert.deepEqual(state.combos[0]!.models, ["p/B", "p/A", "p/LOCAL"]);
  state.combos[0]!.models = ["p/B", "p/A", "p/C"];
  const before = writes.length;
  const conflict = await edit(["p/C", "p/A", "p/B"], ["p/A", "p/B", "p/C"]);
  assert.equal(conflict.status, 409);
  assert.equal(writes.length, before);
});

test("two renderer windows retain both additions through one desktop admission queue", async (t) => {
  const { state } = await fixture(t);
  const answers = await Promise.all([edit(["p/A", "p/B", "p/ONE"]), edit(["p/A", "p/B", "p/TWO"])]);
  assert.ok(answers.every((answer) => answer.ok));
  assert.deepEqual(new Set(state.combos[0]!.models), new Set(["p/A", "p/B", "p/ONE", "p/TWO"]));
});

test("a stale edit cannot recreate a pool deleted in the other dashboard", async (t) => {
  const { state, writes } = await fixture(t);
  state.combos = [];
  assert.equal((await edit(["p/B", "p/A"])).status, 409);
  assert.equal(writes.length, 0);
});

test("durable history and named presets restore deleted and damaged lists without touching other configuration", async (t) => {
  const { state, writes, target } = await fixture(t);
  await callZaicodeRouter({ method: "GET", path: "/api/combos" });
  assert.equal(
    (
      await callZaicodeRouter({
        method: "POST",
        path: "/zaicode/recovery/snapshot",
        body: { label: "My working list" },
      })
    ).ok,
    true,
  );
  const saved = (await history()).snapshots.find((item) => item.label === "My working list");
  assert.equal(saved?.kind, "preset");
  assert.ok(saved);
  state.combos[0]!.models = ["p/DAMAGED"];
  state.combos.push({ id: "other", name: "OTHER", models: ["keep/me"] });
  const restored = await callZaicodeRouter({
    method: "POST",
    path: "/zaicode/recovery/restore",
    body: { id: saved.id },
  });
  assert.equal(restored.ok, true, restored.message);
  assert.deepEqual(state.combos[0]!.models, ["p/A", "p/B"]);
  assert.deepEqual(state.combos[1]!.models, ["keep/me"]);
  state.combos = [];
  setZaicodeRouterTarget(null);
  setZaicodeRouterTarget(target);
  assert.ok(
    (await history()).snapshots.some((item) => item.id === saved.id),
    "history survives target/owner recreation",
  );
  assert.equal(
    (
      await callZaicodeRouter({
        method: "POST",
        path: "/zaicode/recovery/restore",
        body: { id: saved.id },
      })
    ).ok,
    true,
  );
  assert.deepEqual(state.combos.find((item) => item.name === "SAIFREN")?.models, ["p/A", "p/B"]);
  assert.ok(
    writes.every((write) => write.path.startsWith("/api/combos")),
    "provider credentials/settings never written",
  );
  const files = await readdir(target.dataDir, { recursive: true });
  const json = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map((file) => readFile(join(target.dataDir, file), "utf8")),
  );
  assert.ok(json.length > 0);
  assert.ok(json.every((text) => !/apiKey|cli-secret|password|accessToken/.test(text)));
});

test("corrupt snapshots cannot be restored and report their unreadable count", async (t) => {
  const { target } = await fixture(t);
  await callZaicodeRouter({ method: "GET", path: "/api/combos" });
  const saved = (await history()).snapshots[0]!;
  assert.ok(saved);
  const file = (await readdir(target.dataDir, { recursive: true })).find((path) =>
    path.endsWith(`${saved.id}.json`),
  );
  assert.ok(file);
  const path = join(target.dataDir, file);
  const raw = JSON.parse(await readFile(path, "utf8"));
  raw.combos[0].models = ["tampered/model"];
  await writeFile(path, JSON.stringify(raw));
  assert.equal((await history()).unreadable, 1);
  const response = await callZaicodeRouter({
    method: "POST",
    path: "/zaicode/recovery/restore",
    body: { id: saved.id },
  });
  assert.equal(response.ok, false);
});

test("unwritable recovery prevents destructive model replacement; invalid list reads are not empty lists", async (t) => {
  const { state, writes, target } = await fixture(t);
  await writeFile(join(target.dataDir, "zaicode-recovery"), "fixture blocks directory creation");
  const response = await edit(["p/A"]);
  assert.equal(response.ok, false);
  assert.equal(writes.length, 0);
  state.malformed = true;
  const read = await callZaicodeRouter({ method: "GET", path: "/api/combos" });
  assert.equal(read.ok, false);
});

test("queued writes stay bound to their admitted target during a mode switch", async (t) => {
  const first = await fixture(t);
  const pending = edit(["p/A", "p/B", "p/FIRST"]);
  const second = await fixture(t);
  await pending;
  assert.deepEqual(first.state.combos[0]!.models, ["p/A", "p/B", "p/FIRST"]);
  assert.deepEqual(second.state.combos[0]!.models, ["p/A", "p/B"]);
  assert.equal(
    (await history()).snapshots.length,
    0,
    "one target's history never appears in another",
  );
});

test("restore reports partial completion when a later pool write is refused", async (t) => {
  const { state } = await fixture(t);
  state.combos.push({ id: "second", name: "SECOND", models: ["p/C"] });
  await callZaicodeRouter({ method: "GET", path: "/api/combos" });
  const saved = (await history()).snapshots[0]!;
  state.combos.forEach((pool) => {
    pool.models = ["damaged/model"];
  });
  state.refuse = "second";
  const response = await callZaicodeRouter({
    method: "POST",
    path: "/zaicode/recovery/restore",
    body: { id: saved.id },
  });
  assert.equal(response.ok, false);
  assert.match(response.message, /1.*pool/i);
  assert.deepEqual(state.combos[0]!.models, ["p/A", "p/B"]);
  assert.deepEqual(state.combos[1]!.models, ["damaged/model"]);
});

test("automatic retention is bounded and does not prune a named preset", async (t) => {
  const { state } = await fixture(t);
  await callZaicodeRouter({
    method: "POST",
    path: "/zaicode/recovery/snapshot",
    body: { label: "Keep this preset" },
  });
  for (let index = 0; index < 54; index++) {
    state.combos[0]!.models = [`p/model-${index}`];
    await callZaicodeRouter({ method: "GET", path: "/api/combos" });
  }
  const saved = await history();
  assert.equal(saved.snapshots.filter((item) => item.kind === "automatic").length, 50);
  assert.equal(saved.snapshots.filter((item) => item.label === "Keep this preset").length, 1);
});

test("ambiguous duplicate model orders are rejected without rewriting the user's list", async (t) => {
  const { state, writes } = await fixture(t);
  state.combos[0]!.models = ["p/A", "p/A", "p/B"];
  const answer = await edit(["p/B", "p/A"]);
  assert.equal(answer.status, 409);
  assert.equal(writes.length, 0);
  assert.deepEqual(state.combos[0]!.models, ["p/A", "p/A", "p/B"]);
});
