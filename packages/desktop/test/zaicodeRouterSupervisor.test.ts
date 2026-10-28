import assert from "node:assert/strict";
import { test } from "node:test";
import { ZaicodeRouterSupervisor, type RouterSupervisorState } from "../src/main/zaicodeRouterSupervisor.js";

function harness(recoverAt = Infinity, fallback = true, saved?: RouterSupervisorState) {
  let now = Math.max(100_000, saved?.lastProbeAt ?? 0);
  let healthy = false;
  let attempts = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  let persisted: RouterSupervisorState | undefined = saved;
  const supervisor = new ZaicodeRouterSupervisor({
    probe: async () => healthy ? "healthy" : "process-unavailable",
    recover: async () => { concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); attempts++; healthy = attempts === recoverAt; concurrent--; },
    fallback: async () => fallback,
    persist: async (state) => { persisted = structuredClone(state); },
    now: () => now,
    wait: async (ms) => { now += ms; },
  }, saved);
  return { supervisor, healthy: (value: boolean) => { healthy = value; }, advance: (ms: number) => { now += ms; }, attempts: () => attempts, concurrent: () => maxConcurrent, persisted: () => persisted! };
}

test("disappeared process: intermediate restart succeeds, every attempt is health checked", async () => {
  const h = harness(4);
  assert.equal(await h.supervisor.boundary(), "preferred");
  assert.equal(h.attempts(), 4);
  assert.equal(h.persisted().attempts, 4);
  assert.equal(h.supervisor.state.status, "restored");
});

test("ten failures fail open once; concurrent requests share recovery", async () => {
  const h = harness();
  assert.deepEqual(await Promise.all([h.supervisor.boundary(), h.supervisor.boundary(), h.supervisor.boundary()]), ["fallback", "fallback", "fallback"]);
  assert.equal(h.attempts(), 10);
  assert.equal(h.concurrent(), 1);
  assert.equal(h.supervisor.state.status, "fallback-active");
  await h.supervisor.boundary();
  assert.equal(h.attempts(), 10);
});

test("restart during fallback preserves failure budget; recovery waits for a boundary", async () => {
  const first = harness();
  await first.supervisor.boundary();
  const h = harness(Infinity, true, first.persisted());
  assert.equal(h.supervisor.state.status, "unavailable", "saved fallback activation must be verified after restart");
  assert.equal(await h.supervisor.boundary(), "fallback");
  assert.equal(h.attempts(), 0);
  h.healthy(true);
  h.advance(60_000);
  await h.supervisor.tick();
  h.advance(30_000);
  await h.supervisor.tick();
  assert.equal(h.supervisor.state.route, "fallback", "a probe cannot switch an in-flight route");
  assert.equal(await h.supervisor.boundary(), "preferred");
  assert.equal(h.supervisor.state.status, "restored");
});

test("flapping cannot replenish the budget or immediately return to preferred", async () => {
  const h = harness();
  await h.supervisor.boundary();
  for (let i = 0; i < 6; i++) {
    h.healthy(i % 2 === 0);
    h.advance(30_000);
    assert.equal(await h.supervisor.boundary(), "fallback");
  }
  assert.equal(h.attempts(), 10);
});

test("fallback unavailable reports unavailable and never working", async () => {
  const h = harness(Infinity, false);
  assert.equal(await h.supervisor.boundary(), null);
  assert.equal(h.supervisor.state.status, "unavailable");
  assert.equal(h.attempts(), 10);
});

test("API unhealthy recovers; temporary connection failure does not spend a restart", async () => {
  let probe = 0;
  let restarts = 0;
  const s = new ZaicodeRouterSupervisor({ probe: async () => ++probe === 1 ? "connection-failure" : "healthy", recover: async () => { restarts++; }, fallback: async () => true, persist: async () => {}, wait: async () => {}, now: Date.now });
  assert.equal(await s.boundary(), "preferred");
  assert.equal(restarts, 0);
  const a = new ZaicodeRouterSupervisor({ probe: async () => restarts > 0 ? "healthy" : "api-unhealthy", recover: async () => { restarts++; }, fallback: async () => true, persist: async () => {}, wait: async () => {}, now: Date.now });
  assert.equal(await a.boundary(), "preferred");
  assert.equal(restarts, 1);
});

test("quota and model failure behind a healthy API leave preferred ownership intact", async () => {
  const h = harness();
  h.healthy(true);
  assert.equal(await h.supervisor.boundary(), "preferred");
  h.supervisor.inferenceFailure("quota");
  h.supervisor.inferenceFailure("provider-model");
  assert.equal(await h.supervisor.boundary(), "preferred");
  assert.equal(h.attempts(), 0);
  assert.equal(h.supervisor.state.failure, null);
});

test("SRC-163: on the fallback the operator's own router is still restarted every few minutes, silently", async () => {
  const { ZAICODE_ROUTER_FALLBACK_RECOVER_MS } = await import("../src/main/zaicodeRouterSupervisor.js");
  const h = harness();
  assert.equal(await h.supervisor.boundary(), "fallback");
  assert.equal(h.attempts(), 10);
  h.advance(30_000);
  await h.supervisor.tick();
  assert.equal(h.attempts(), 10, "the first fallback probe only arms the slow restart clock");
  h.advance(ZAICODE_ROUTER_FALLBACK_RECOVER_MS);
  await h.supervisor.tick();
  assert.equal(h.attempts(), 11, "one silent restart after the interval");
  h.advance(30_000);
  await h.supervisor.tick();
  assert.equal(h.attempts(), 11, "never more often than the interval");
  assert.equal(h.supervisor.state.route, "fallback", "a restart never switches the route by itself");
});
