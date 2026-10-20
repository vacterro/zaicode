import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ZaicodeStatsRepo } from "../src/zaicode/zaicodeStatsRepo.js";
import { ZaicodeStatsService } from "../src/zaicode/zaicodeStatsService.js";

/** REQ-012: global / project / session totals come from recorded attribution, never from splitting totals. */
function createAgentDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
      agent TEXT, status TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER, duration_ms INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0, cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      computed_total_tokens INTEGER NOT NULL DEFAULT 0, error_type TEXT
    );
    CREATE TABLE turn_usage (
      session_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL,
      completed_at INTEGER, duration_ms INTEGER
    );
  `);
  db.prepare("INSERT INTO session VALUES (?, ?)").run("s1", "V:\\work\\_ZAICODE");
  db.prepare("INSERT INTO session VALUES (?, ?)").run("s2", "V:\\work\\OTHER");
  return db;
}

function addRequest(db: DatabaseSync, session: string, id: string, at: number, tokens: number): void {
  db.prepare(
    `INSERT INTO model_usage (id, session_id, turn_id, provider_id, model_id, status, started_at, completed_at, duration_ms,
       input_tokens, output_tokens, cache_read_input_tokens, computed_total_tokens)
     VALUES (?, ?, ?, 'new-provider', 'SAIFREN', 'completed', ?, ?, 1000, ?, ?, ?, ?)`,
  ).run(id, session, `t-${id}`, at, at + 1000, Math.round(tokens * 0.6), Math.round(tokens * 0.3), Math.round(tokens * 0.1), tokens);
  db.prepare("INSERT INTO turn_usage VALUES (?, ?, 'completed', ?, ?, 1000)").run(session, `t-${id}`, at, at + 1000);
}

test("stats scope: project and session slices sum from recorded events; empty slices are zero rows", async () => {
  const now = Date.UTC(2026, 8, 24, 11, 0);
  const dir = await mkdtemp(join(tmpdir(), "zaicode-stats-scope-"));
  const tasksPath = join(dir, "tasks-index.sqlite");
  const agentPath = join(dir, "db.sqlite");
  const agentDb = createAgentDb(agentPath);
  try {
    addRequest(agentDb, "s1", "a", now - 60_000, 1000);
    addRequest(agentDb, "s1", "b", now - 50_000, 500);
    addRequest(agentDb, "s2", "c", now - 40_000, 300);
    const service = new ZaicodeStatsService({ repo: new ZaicodeStatsRepo(tasksPath), agentDbPath: () => agentPath, now: () => now });
    try {
      await service.getHomeStats({ timeZone: "Europe/Tallinn", now }); // ingest
      const global = await service.getScopeTotals(null, null);
      assert.equal(global.tokens, 1800);
      assert.equal(global.requests, 3);
      const projA = await service.getScopeTotals("V:\\work\\_ZAICODE", null);
      assert.equal(projA.tokens, 1500);
      assert.equal(projA.requests, 2);
      const projB = await service.getScopeTotals("V:\\work\\OTHER", null);
      assert.equal(projB.tokens, 300);
      assert.equal(projB.requests, 1);
      // Scoped slices add up to the global row: nothing is divided or guessed.
      assert.equal(projA.tokens + projB.tokens, global.tokens);
      assert.equal(projA.requests + projB.requests, global.requests);
      const sess = await service.getScopeTotals(null, "s2");
      assert.equal(sess.tokens, 300);
      assert.equal(sess.requests, 1);
      const combo = await service.getScopeTotals("V:\\work\\_ZAICODE", "s1");
      assert.deepEqual([combo.tokens, combo.requests], [1500, 2]);
      // A session outside the project filter matches nothing: zero row, never null.
      const mismatch = await service.getScopeTotals("V:\\work\\OTHER", "s1");
      assert.deepEqual([mismatch.tokens, mismatch.requests, mismatch.turns], [0, 0, 0]);
      const empty = await service.getScopeTotals("V:\\work\\NOWHERE", null);
      assert.deepEqual([empty.tokens, empty.requests, empty.turns, empty.jobsDone], [0, 0, 0, 0]);
      const projects = await service.getScopeProjects();
      assert.deepEqual(
        projects.map((row) => row.project),
        ["V:\\work\\OTHER", "V:\\work\\_ZAICODE"],
      ); // newest first
      const sessions = await service.getScopeSessions(null);
      assert.deepEqual(
        sessions.map((row) => row.sessionId).sort(),
        ["s1", "s2"],
      );
      const filtered = await service.getScopeSessions("V:\\work\\_ZAICODE");
      assert.deepEqual(
        filtered.map((row) => row.sessionId),
        ["s1"],
      );
    } finally {
      service.dispose();
    }
  } finally {
    agentDb.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("router usage scopes combine endpoint, project, session and period; unrelated providers stay out", async () => {
  const now = Date.UTC(2026, 9, 9, 11, 0);
  const dir = await mkdtemp(join(tmpdir(), "zaicode-router-scope-"));
  const agentPath = join(dir, "agent.sqlite");
  const agentDb = createAgentDb(agentPath);
  const service = new ZaicodeStatsService({ repo: new ZaicodeStatsRepo(join(dir, "tasks.sqlite")), agentDbPath: () => agentPath, now: () => now });
  try {
    addRequest(agentDb, "s1", "old", now - 2 * 86_400_000, 1000);
    addRequest(agentDb, "s1", "recent", now - 5000, 500);
    addRequest(agentDb, "s1", "direct", now - 4000, 9000);
    agentDb.prepare("UPDATE model_usage SET provider_id = 'direct-provider' WHERE id = 'direct'").run();
    addRequest(agentDb, "s2", "other-project", now - 3000, 300);
    const request = { providerIds: ["new-provider"], project: "V:\\work\\_ZAICODE", sessionId: "s1", since: now - 86_400_000 };
    const scoped = await service.getRouterUsage(request);
    assert.equal(scoped.stats.totalRequests, 1);
    assert.deepEqual([scoped.stats.totalPromptTokens, scoped.stats.totalCompletionTokens, scoped.stats.totalCachedTokens], [300, 150, 50]);
    assert.equal(scoped.stats.recentRequests.length, 1);
    assert.equal(scoped.stats.recentRequests[0]?.provider, "new-provider");
    assert.equal(scoped.chart.reduce((total, row) => total + row.tokens, 0), 500);
    assert.equal(scoped.costMeasured, false);
    assert.equal((await service.getRouterUsage({ ...request, since: 0 })).stats.totalRequests, 2);
    assert.equal((await service.getRouterUsage({ ...request, project: "V:\\work\\OTHER" })).stats.totalRequests, 0);
    assert.equal((await service.getRouterUsage({ ...request, providerIds: [] })).stats.totalRequests, 0);
    assert.equal((await service.getRouterUsage({ ...request, providerIds: ["x') OR 1=1 --"] })).stats.totalRequests, 0);
    assert.equal((await service.getRouterUsage({ ...request, project: "V:\\work\\OTHER", sessionId: null })).stats.totalRequests, 1);
  } finally { service.dispose(); agentDb.close(); await rm(dir, { recursive: true, force: true }); }
});
