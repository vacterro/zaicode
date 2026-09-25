import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ZaicodeAgentCreateInput } from "@zcode/shared";
import { ZaicodeAgentRepo } from "../src/zaicode/zaicodeAgentRepo.js";
import { ZaicodeAgentService } from "../src/zaicode/zaicodeAgentService.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { ZAICODE_SCHEMA } from "../src/session/tasksDatabase/zaicode-v4.js";

async function withAgentService<T>(run: (service: ZaicodeAgentService, dbPath: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-agent-persistence-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const repo = new ZaicodeAgentRepo(dbPath, 500);
  const service = new ZaicodeAgentService({ repo });
  try {
    return await run(service, dbPath);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("routing-backend migration defaults existing agents to direct without rewriting other fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-agent-migration-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(ZAICODE_SCHEMA);
    db.prepare(
      `INSERT INTO zaicode_agents (
        agent_id, name, role, instructions, enabled, model_selection, provider_ref,
        model_ref, reasoning_effort, tool_policy_json, template_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-agent",
      "Legacy agent",
      "implementer",
      "Keep this configuration.",
      1,
      JSON.stringify({ providerId: "legacy-provider", modelId: "legacy-model" }),
      "legacy-provider",
      "legacy-model",
      "high",
      JSON.stringify({ allowedTools: ["ReadFile"], disallowedTools: ["Bash"] }),
      null,
      10,
      11,
    );

    runTasksDatabaseMigrations(db);

    const columns = db.prepare("PRAGMA table_info(zaicode_agents)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "backend"));
    const row = db
      .prepare(
        `SELECT backend, model_selection, provider_ref, model_ref, reasoning_effort, tool_policy_json
         FROM zaicode_agents WHERE agent_id = ?`,
      )
      .get("legacy-agent") as Record<string, unknown>;
    assert.equal(row.backend, "direct");
    assert.equal(row.model_selection, JSON.stringify({ providerId: "legacy-provider", modelId: "legacy-model" }));
    assert.equal(row.provider_ref, "legacy-provider");
    assert.equal(row.model_ref, "legacy-model");
    assert.equal(row.reasoning_effort, "high");
    assert.equal(row.tool_policy_json, JSON.stringify({ allowedTools: ["ReadFile"], disallowedTools: ["Bash"] }));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent backends default and round-trip through create, read, update, list, and duplicate", async () => {
  await withAgentService(async (service) => {
    const direct = await service.create({
      name: "Direct agent",
      role: "implementer",
      instructions: "Run directly.",
    });
    const external = await service.create({
      name: "SAIRoute agent",
      role: "researcher",
      instructions: "Keep configured route intent.",
      backend: "sairoute",
    });

    assert.equal(direct.backend, "direct");
    assert.equal(external.backend, "sairoute");
    assert.equal((await service.get(external.id))?.backend, "sairoute");
    assert.deepEqual(
      (await service.list()).agents.map((agent) => [agent.name, agent.backend]),
      [
        ["Direct agent", "direct"],
        ["SAIRoute agent", "sairoute"],
      ],
    );

    const updated = await service.update(direct.id, { backend: "saifren" });
    assert.equal(updated?.backend, "saifren");

    const copy = await service.duplicate(external.id);
    assert.equal(copy?.backend, "sairoute");
  });
});

test("invalid backend values are rejected at create and reported for malformed persisted rows", async () => {
  await withAgentService(async (service, dbPath) => {
    await assert.rejects(
      () =>
        service.create({
          name: "Invalid backend",
          role: "custom",
          instructions: "Must be rejected.",
          backend: "not-a-backend",
        } as unknown as ZaicodeAgentCreateInput),
    );

    const agent = await service.create({
      name: "Persisted row",
      role: "custom",
      instructions: "Corrupt only the backend column.",
    });
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE zaicode_agents SET backend = ? WHERE agent_id = ?").run(
        "not-a-backend",
        agent.id,
      );
    } finally {
      db.close();
    }

    const listed = await service.list();
    assert.equal(listed.agents.some((row) => row.id === agent.id), false);
    assert.equal(listed.diagnostics.length, 1);
    assert.equal(listed.diagnostics[0]?.agentId, agent.id);
    assert.equal(listed.diagnostics[0]?.code, "invalid-definition");
    assert.ok(listed.diagnostics[0]?.message);
  });
});
