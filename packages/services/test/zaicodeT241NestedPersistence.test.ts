/* T-241 / CORE-001 — 嵌套持久化必须失败关闭：一个非空的损坏 JSON 列（tool_policy_json、
   model_selection、delegation_json、actual_model_selection）要么给出 invalid-definition /
   invalid-job 诊断，要么被逐字保留，绝不能悄悄退化成默认值。最高影响面是 tool_policy_json：
   退化成 {} 之后 zaicodeRunDispatch 读不到 permissionMode，就沿用上游 yolo 全权限默认。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ZaicodeJobCreateInput } from "@zcode/shared";
import { ZaicodeAgentRepo } from "../src/zaicode/zaicodeAgentRepo.js";
import { ZaicodeAgentService } from "../src/zaicode/zaicodeAgentService.js";
import { ZaicodeJobRepo } from "../src/zaicode/zaicodeJobRepo.js";
import { ZaicodeJobService } from "../src/zaicode/zaicodeJobService.js";
import type { ZaicodeJobExecutor } from "../src/zaicode/zaicodeJobs.js";

interface Harness {
  dbPath: string;
  agentRepo: ZaicodeAgentRepo;
  agentService: ZaicodeAgentService;
  jobRepo: ZaicodeJobRepo;
  jobService: ZaicodeJobService;
  executorCalls: string[];
  dispose: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-t241-nested-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const agentRepo = new ZaicodeAgentRepo(dbPath, 500);
  const agentService = new ZaicodeAgentService({ repo: agentRepo });
  const jobRepo = new ZaicodeJobRepo(dbPath, 500);
  const executorCalls: string[] = [];
  const executor: ZaicodeJobExecutor = async ({ job }) => {
    executorCalls.push(job.id);
    return { sessionId: `session-${job.id}` };
  };
  const jobService = new ZaicodeJobService({
    repo: jobRepo,
    getAgent: (agentId) => agentService.get(agentId),
    getExecutor: () => executor,
  });
  await jobService.ensureReady();
  await jobService.setAutoRun(false);
  return {
    dbPath,
    agentRepo,
    agentService,
    jobRepo,
    jobService,
    executorCalls,
    dispose: async () => {
      jobService.dispose();
      agentRepo.close();
      jobRepo.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function corrupt(dbPath: string, sql: string, value: string | null, id: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(sql).run(value, id);
  } finally {
    db.close();
  }
}

const WORKSPACE = { workspaceKey: "ws-key-1", workspacePath: "C:\\zaicode\\workspace" };

test("T-241: an agent row whose tool_policy_json is malformed is a diagnostic, not an empty policy", async () => {
  const harness = await createHarness();
  try {
    const agent = await harness.agentService.create({
      name: "Restricted",
      role: "implementer",
      instructions: "Stay inside the plan.",
    });
    corrupt(
      harness.dbPath,
      "UPDATE zaicode_agents SET tool_policy_json = ? WHERE agent_id = ?",
      '{"permissionMode":',
      agent.id,
    );

    const listed = await harness.agentService.list();
    assert.equal(
      listed.agents.some((row) => row.id === agent.id),
      false,
      "a corrupt policy must not come back as a usable definition",
    );
    assert.equal(listed.diagnostics.length, 1);
    assert.equal(listed.diagnostics[0]?.code, "invalid-definition");
    assert.match(listed.diagnostics[0]?.message ?? "", /tool_policy_json/);
    assert.equal(await harness.agentService.get(agent.id), null);
  } finally {
    await harness.dispose();
  }
});

test("T-241: JSON that parses but breaks the tool-policy contract is also a diagnostic", async () => {
  const harness = await createHarness();
  try {
    const agent = await harness.agentService.create({
      name: "Off-contract",
      role: "implementer",
      instructions: "Only legal policies reach the runtime.",
    });
    corrupt(
      harness.dbPath,
      "UPDATE zaicode_agents SET tool_policy_json = ? WHERE agent_id = ?",
      '{"permissionMode":"semi"}',
      agent.id,
    );

    const listed = await harness.agentService.list();
    assert.equal(listed.agents.length, 0);
    assert.equal(listed.diagnostics[0]?.code, "invalid-definition");
    assert.match(listed.diagnostics[0]?.message ?? "", /tool_policy_json/);
  } finally {
    await harness.dispose();
  }
});

test("T-241: a queue job for an agent with a corrupt policy is blocked, never executed with defaults", async () => {
  const harness = await createHarness();
  try {
    const agent = await harness.agentService.create({
      name: "Restricted",
      role: "implementer",
      instructions: "Stay inside the plan.",
    });
    const job = await harness.jobService.create({
      ...WORKSPACE,
      agentId: agent.id,
      title: "Must not run full access",
      instructions: "Do the work.",
    });
    corrupt(
      harness.dbPath,
      "UPDATE zaicode_agents SET tool_policy_json = ? WHERE agent_id = ?",
      '{"permissionMode":"plan"',
      agent.id,
    );

    const dispatched = await harness.jobService.dispatch(job.id);
    assert.deepEqual(harness.executorCalls, [], "the executor sees no run at all");
    assert.equal(dispatched?.status, "blocked");
    assert.match(dispatched?.error ?? "", /agent_missing/);
  } finally {
    await harness.dispose();
  }
});

test("T-241: a valid empty policy and an unconfigured policy keep their meaning", async () => {
  const harness = await createHarness();
  try {
    const explicit = await harness.agentService.create({
      name: "Explicit empty",
      role: "custom",
      instructions: "Stored {} is a deliberate unrestricted policy.",
    });
    const unconfigured = await harness.agentService.create({
      name: "Unconfigured",
      role: "custom",
      instructions: "Empty storage stays unconfigured.",
    });
    corrupt(
      harness.dbPath,
      "UPDATE zaicode_agents SET tool_policy_json = ? WHERE agent_id = ?",
      "{}",
      explicit.id,
    );
    corrupt(
      harness.dbPath,
      "UPDATE zaicode_agents SET tool_policy_json = ? WHERE agent_id = ?",
      "",
      unconfigured.id,
    );

    const listed = await harness.agentService.list();
    assert.deepEqual(listed.diagnostics, []);
    const byId = new Map(listed.agents.map((row) => [row.id, row]));
    assert.deepEqual(byId.get(explicit.id)?.toolPolicy, {});
    assert.deepEqual(byId.get(unconfigured.id)?.toolPolicy, {});
  } finally {
    await harness.dispose();
  }
});

test("T-241: a corrupt model_selection is a diagnostic, a NULL one stays absent", async () => {
  const harness = await createHarness();
  try {
    const corruptRow = await harness.agentService.create({
      name: "Corrupt route",
      role: "implementer",
      instructions: "Route intent must not vanish.",
    });
    const absentRoute = await harness.agentService.create({
      name: "No route",
      role: "implementer",
      instructions: "NULL route is a valid absence.",
    });
    corrupt(
      harness.dbPath,
      "UPDATE zaicode_agents SET model_selection = ? WHERE agent_id = ?",
      '{"providerId":',
      corruptRow.id,
    );
    const syntaxDiagnostic = (await harness.agentService.list()).diagnostics[0];
    assert.equal(syntaxDiagnostic?.code, "invalid-definition");
    assert.match(syntaxDiagnostic?.message ?? "", /model_selection.*not valid JSON/);
    corrupt(
      harness.dbPath,
      "UPDATE zaicode_agents SET model_selection = ? WHERE agent_id = ?",
      '{"providerId":42,"modelId":"glm"}',
      corruptRow.id,
    );

    const listed = await harness.agentService.list();
    assert.equal(listed.diagnostics[0]?.code, "invalid-definition");
    assert.match(listed.diagnostics[0]?.message ?? "", /model_selection/);
    const absent = await harness.agentService.get(absentRoute.id);
    assert.equal(absent?.modelSelection, undefined);
    assert.equal(await harness.agentService.get(corruptRow.id), null);
  } finally {
    await harness.dispose();
  }
});

// 每列独立验证语法、契约与非空白字节；损坏行必须留在数据库，不能用默认值修复。
for (const { column, table, idColumn, kind, wrongShape } of [
  {
    column: "tool_policy_json",
    table: "zaicode_agents",
    idColumn: "agent_id",
    kind: "agent",
    wrongShape: '{"permissionMode":"semi"}',
  },
  {
    column: "model_selection",
    table: "zaicode_agents",
    idColumn: "agent_id",
    kind: "agent",
    wrongShape: '{"providerId":42,"modelId":"test"}',
  },
  {
    column: "delegation_json",
    table: "zaicode_jobs",
    idColumn: "job_id",
    kind: "job",
    wrongShape: '{"targetAgentId":42,"instructions":"test"}',
  },
  {
    column: "actual_model_selection",
    table: "zaicode_jobs",
    idColumn: "job_id",
    kind: "job",
    wrongShape: '{"providerId":42,"modelId":"test"}',
  },
]) {
  for (const [label, value] of [
    ["syntax", '{"broken":'],
    ["shape", wrongShape],
    ["JSON null", "null"],
    ["array", "[]"],
    ["whitespace", " \n\t "],
  ] as const) {
    test(`T-241: ${column} rejects ${label}, preserves the stored bytes and cannot run`, async () => {
      const harness = await createHarness();
      try {
        const agent = await harness.agentService.create({
          name: "Restricted",
          role: "implementer",
          instructions: "Keep the stored policy.",
          toolPolicy: { permissionMode: "plan", disallowedTools: ["Bash"] },
        });
        const job = await harness.jobService.create({
          ...WORKSPACE,
          agentId: agent.id,
          title: "Persisted validation",
          instructions: "No run from damaged bytes.",
        });
        const id = kind === "agent" ? agent.id : job.id;
        corrupt(
          harness.dbPath,
          `UPDATE ${table} SET ${column} = ? WHERE ${idColumn} = ?`,
          value,
          id,
        );
        const listed =
          kind === "agent" ? await harness.agentService.list() : await harness.jobService.list();
        assert.equal(listed.diagnostics.length, 1);
        assert.equal(
          listed.diagnostics[0]?.code,
          kind === "agent" ? "invalid-definition" : "invalid-job",
        );
        assert.ok(listed.diagnostics[0]?.message.includes(column));
        if (kind === "agent") {
          assert.equal(await harness.agentService.get(agent.id), null);
          assert.equal((await harness.jobService.dispatch(job.id))?.status, "blocked");
        } else {
          assert.equal(await harness.jobService.get(job.id), null);
          await assert.rejects(() => harness.jobService.dispatch(job.id), /任务不存在/);
        }
        assert.deepEqual(harness.executorCalls, []);
        const db = new DatabaseSync(harness.dbPath);
        try {
          assert.equal(
            (
              db
                .prepare(`SELECT ${column} AS value FROM ${table} WHERE ${idColumn} = ?`)
                .get(id) as { value: string }
            ).value,
            value,
          );
        } finally {
          db.close();
        }
      } finally {
        await harness.dispose();
      }
    });
  }
}

test("T-241: valid nested fields round-trip without losing restrictive policy or model options", async () => {
  const harness = await createHarness();
  try {
    const selection = {
      providerId: "provider-test",
      modelId: "model-test",
      options: { reasoningLevel: "high" },
    };
    const policy = {
      permissionMode: "plan" as const,
      allowedTools: ["ReadFile"],
      disallowedTools: ["Bash"],
    };
    const agent = await harness.agentService.create({
      name: "Valid",
      role: "implementer",
      instructions: "Keep restrictions.",
      modelSelection: selection,
      toolPolicy: policy,
    });
    const delegation = { targetAgentId: agent.id, instructions: "nested" };
    const job = await harness.jobService.create({
      ...WORKSPACE,
      agentId: agent.id,
      title: "Valid fields",
      instructions: "Work.",
      delegation,
    });
    corrupt(
      harness.dbPath,
      "UPDATE zaicode_jobs SET actual_model_selection = ? WHERE job_id = ?",
      ` ${JSON.stringify(selection)} `,
      job.id,
    );
    assert.deepEqual((await harness.agentService.get(agent.id))?.toolPolicy, policy);
    assert.deepEqual((await harness.agentService.get(agent.id))?.modelSelection, selection);
    assert.deepEqual((await harness.jobService.get(job.id))?.delegation, delegation);
    assert.deepEqual((await harness.jobService.get(job.id))?.actualModelSelection, selection);
    assert.deepEqual((await harness.agentService.list()).diagnostics, []);
    assert.deepEqual((await harness.jobService.list()).diagnostics, []);
    for (const absence of [null, ""]) {
      corrupt(
        harness.dbPath,
        "UPDATE zaicode_agents SET model_selection = ? WHERE agent_id = ?",
        absence,
        agent.id,
      );
      corrupt(
        harness.dbPath,
        "UPDATE zaicode_jobs SET delegation_json = ? WHERE job_id = ?",
        absence,
        job.id,
      );
      corrupt(
        harness.dbPath,
        "UPDATE zaicode_jobs SET actual_model_selection = ? WHERE job_id = ?",
        absence,
        job.id,
      );
      assert.equal((await harness.agentService.get(agent.id))?.modelSelection, undefined);
      assert.deepEqual((await harness.agentService.get(agent.id))?.toolPolicy, policy);
      const storedJob = await harness.jobService.get(job.id);
      assert.ok(storedJob);
      assert.equal(storedJob.delegation, undefined);
      assert.equal(storedJob.actualModelSelection, undefined);
      assert.deepEqual((await harness.agentService.list()).diagnostics, []);
      assert.deepEqual((await harness.jobService.list()).diagnostics, []);
    }
  } finally {
    await harness.dispose();
  }
});

test("T-241: corrupt job delegation and actual-model columns are diagnostics, not dropped fields", async () => {
  const harness = await createHarness();
  try {
    const agent = await harness.agentService.create({
      name: "Worker",
      role: "implementer",
      instructions: "Do the work.",
    });
    const seed = async (title: string, overrides: Partial<ZaicodeJobCreateInput> = {}) =>
      harness.jobService.create({
        ...WORKSPACE,
        agentId: agent.id,
        title,
        instructions: "Do the work.",
        ...overrides,
      });
    const corruptDelegation = await seed("corrupt delegation");
    const corruptModel = await seed("corrupt model");
    const nulls = await seed("nulls");

    corrupt(
      harness.dbPath,
      "UPDATE zaicode_jobs SET delegation_json = ? WHERE job_id = ?",
      '{"targetAgentId":',
      corruptDelegation.id,
    );
    corrupt(
      harness.dbPath,
      "UPDATE zaicode_jobs SET actual_model_selection = ? WHERE job_id = ?",
      '{"providerId":"saifren","modelId":',
      corruptModel.id,
    );

    const listed = await harness.jobService.list({ workspaceKey: WORKSPACE.workspaceKey });
    assert.equal(
      listed.jobs.some((job) => job.id === corruptDelegation.id),
      false,
    );
    assert.equal(
      listed.jobs.some((job) => job.id === corruptModel.id),
      false,
    );
    const diagnostics = new Map(listed.diagnostics.map((row) => [row.jobId, row]));
    assert.equal(diagnostics.size, 2);
    assert.match(diagnostics.get(corruptDelegation.id)?.message ?? "", /delegation_json/);
    assert.match(diagnostics.get(corruptModel.id)?.message ?? "", /actual_model_selection/);
    assert.equal(await harness.jobService.get(corruptDelegation.id), null);
    // 派发损坏行：找不到合法任务，明确报错而不是揣测语义。
    await assert.rejects(() => harness.jobService.dispatch(corruptModel.id), /任务不存在/);

    // 合法 delegation 逐字保留；SQL NULL 仍是合法缺失。
    const withDelegation = await harness.jobService.create({
      ...WORKSPACE,
      agentId: agent.id,
      title: "valid delegation",
      instructions: "Do the work.",
      delegation: { targetAgentId: agent.id, instructions: "nested" },
    });
    const stored = await harness.jobService.get(withDelegation.id);
    assert.deepEqual(stored?.delegation, { targetAgentId: agent.id, instructions: "nested" });
    const nullRow = await harness.jobService.get(nulls.id);
    assert.equal(nullRow?.delegation, undefined);
    assert.equal(nullRow?.actualModelSelection, undefined);
  } finally {
    await harness.dispose();
  }
});
