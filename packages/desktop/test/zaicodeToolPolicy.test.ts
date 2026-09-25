import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IZCodeTaskService, ServiceCollection, type ZaicodeJobExecutor } from "@zcode/services";
import type { ZaicodeAgentDefinition, ZaicodeJob } from "@zcode/shared";
import { ZaicodeAgentRepo } from "../../services/src/zaicode/zaicodeAgentRepo.js";
import { ZaicodeAgentService } from "../../services/src/zaicode/zaicodeAgentService.js";
import { createZaicodeJobExecutor } from "../src/host/zaicodeRunDispatch.js";

// minimal mock capturing createTask/sendPrompt args
interface CapturedCall {
  createTaskArgs?: Record<string, unknown>;
  sendPromptArgs?: Record<string, unknown>;
}

function makeMockTaskService(captured: CapturedCall): IZCodeTaskService {
  const taskService = {
    createTask: async (params: Record<string, unknown>) => {
      captured.createTaskArgs = params;
      return { taskId: "task-mock", traceId: "trace-mock" };
    },
    sendPrompt: async (params: Record<string, unknown>) => {
      captured.sendPromptArgs = params;
    },
    stopGeneration: async () => {},
    onDynamicTaskTerminalOutcome: () => () => ({ dispose: () => {} }),
    onDynamicTaskEvent: () => () => ({ dispose: () => {} }),
    onDynamicWorkspaceEvent: () => () => ({ dispose: () => {} }),
    onDynamicStreamEvent: () => () => ({ dispose: () => {} }),
  } as unknown as IZCodeTaskService;
  return taskService;
}

function makeServiceCollection(taskService: IZCodeTaskService): ServiceCollection {
  const services = {
    getOptional: <T>(service: { channelName: string }): T | undefined => {
      if (service.channelName === "zcode-task") {
        return taskService as unknown as T;
      }
      return undefined;
    },
  } as unknown as ServiceCollection;
  return services;
}

function makeJob(): ZaicodeJob {
  return {
    id: "job-test",
    workspaceKey: "ws-key",
    workspacePath: "C:\\zaicode\\ws",
    agentId: "agent-test",
    title: "Test job",
    instructions: "Do test work.",
    status: "queued",
    priority: 0,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    attempt: 0,
    runId: "run-1",
  } as ZaicodeJob;
}

function makeAgent(
  overrides: Partial<ZaicodeAgentDefinition> = {},
): ZaicodeAgentDefinition {
  return {
    id: "zaicode-agent:test",
    name: "Test Agent",
    role: "implementer",
    instructions: "Run tests.",
    enabled: true,
    toolPolicy: {},
    backend: "direct",
    createdAt: 0,
    updatedAt: 0,
    modelSelection: { providerId: "glm", modelId: "glm-4.5" },
    ...overrides,
  } as ZaicodeAgentDefinition;
}

// re-create with captured service
function buildExecutor(captured: CapturedCall): ZaicodeJobExecutor {
  const taskService = makeMockTaskService(captured);
  return createZaicodeJobExecutor({
    resolveServices: () => makeServiceCollection(taskService),
    logWarn: () => {},
  });
}

test("toolPolicy.allowedTools sent as toolAllowlist to sendPrompt only (createTask has no tool contract)", async () => {
  const captured: CapturedCall = {};
  const runExecutor = buildExecutor(captured);
  const agent = makeAgent({
    toolPolicy: { allowedTools: ["Bash", "ReadFile"] },
  });
  await runExecutor({ job: makeJob(), agent });

  assert.deepEqual(captured.sendPromptArgs?.toolAllowlist, ["Bash", "ReadFile"]);
  // createTask 不建模工具面；把它塞进去只是无效透传。真正的运行时约束在首轮 sendPrompt。
  assert.equal(captured.createTaskArgs?.toolAllowlist, undefined);
});

test("toolPolicy.disallowedTools sent as toolDenylist to sendPrompt", async () => {
  const captured: CapturedCall = {};
  const runExecutor = buildExecutor(captured);
  const agent = makeAgent({
    toolPolicy: { disallowedTools: ["Bash"] },
  });
  await runExecutor({ job: makeJob(), agent });

  assert.deepEqual(captured.sendPromptArgs?.toolDenylist, ["Bash"]);
  // createTask never sends denylist per spec; only allowlist + mode
  assert.equal(captured.createTaskArgs?.toolDenylist, undefined);
});

test("empty/undefined toolPolicy omits toolAllowlist and toolDenylist", async () => {
  const captured: CapturedCall = {};
  const runExecutor = buildExecutor(captured);
  const agent = makeAgent({ toolPolicy: {} });
  await runExecutor({ job: makeJob(), agent });

  assert.equal(captured.createTaskArgs?.toolAllowlist, undefined);
  assert.equal(captured.sendPromptArgs?.toolAllowlist, undefined);
  assert.equal(captured.sendPromptArgs?.toolDenylist, undefined);
});

test("conflict: tool in both allowlist and denylist is excluded from allowlist", async () => {
  const captured: CapturedCall = {};
  const runExecutor = buildExecutor(captured);
  const agent = makeAgent({
    toolPolicy: { allowedTools: ["Bash", "ReadFile"], disallowedTools: ["Bash"] },
  });
  await runExecutor({ job: makeJob(), agent });

  // denylist wins: Bash removed from effective allowlist
  assert.equal(captured.createTaskArgs?.toolAllowlist, undefined);
  assert.deepEqual(captured.sendPromptArgs?.toolAllowlist, ["ReadFile"]);
  assert.deepEqual(captured.sendPromptArgs?.toolDenylist, ["Bash"]);
});

test("plan mode still sent as mode=plan", async () => {
  const captured: CapturedCall = {};
  const runExecutor = buildExecutor(captured);
  const agent = makeAgent({
    toolPolicy: { permissionMode: "plan" },
  });
  await runExecutor({ job: makeJob(), agent });

  assert.equal(captured.createTaskArgs?.mode, "plan");
});

test("yolo full access is sent as explicit mode=yolo", async () => {
  const captured: CapturedCall = {};
  const runExecutor = buildExecutor(captured);
  const agent = makeAgent({
    toolPolicy: { permissionMode: "yolo" },
  });
  await runExecutor({ job: makeJob(), agent });

  assert.equal(captured.createTaskArgs?.mode, "yolo");
});

test("legacy auto permissionMode keeps the upstream runtime default", async () => {
  const captured: CapturedCall = {};
  const runExecutor = buildExecutor(captured);
  const agent = makeAgent({
    toolPolicy: { permissionMode: "auto" },
  });
  await runExecutor({ job: makeJob(), agent });

  assert.equal(captured.createTaskArgs?.mode, undefined);
});

test("router backend executes through the configured pool (T-15 pool routing contract)", async () => {
  const captured: CapturedCall = {};
  const runExecutor = buildExecutor(captured);
  const agent = makeAgent({ backend: "sairoute" });

  await runExecutor({ job: makeJob(), agent });
  assert.equal(captured.createTaskArgs?.mode, undefined);
  assert.equal(captured.sendPromptArgs?.modelSelection, agent.modelSelection);
});

test("router backend without a pool selection fails closed without creating a task", async () => {
  const captured: CapturedCall = {};
  const runExecutor = buildExecutor(captured);
  const agent = makeAgent({ backend: "sairoute", modelSelection: undefined });

  await assert.rejects(() => runExecutor({ job: makeJob(), agent }));
  assert.equal(captured.createTaskArgs, undefined);
  assert.equal(captured.sendPromptArgs, undefined);
});

test("executor consumes a reloaded persisted router backend through its pool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-persisted-dispatch-"));
  const repo = new ZaicodeAgentRepo(join(dir, "tasks-index.sqlite"), 500);
  try {
    const service = new ZaicodeAgentService({ repo });
    const created = await service.create({
      name: "Persisted SAIRoute agent",
      role: "researcher",
      instructions: "This route intent must survive reload.",
      modelSelection: { providerId: "independent-provider", modelId: "independent-model" },
      backend: "sairoute",
    });
    const reloaded = await service.get(created.id);
    assert.ok(reloaded);
    assert.equal(reloaded.backend, "sairoute");

    const captured: CapturedCall = {};
    await buildExecutor(captured)({ job: makeJob(), agent: reloaded });
    assert.deepEqual(captured.createTaskArgs?.modelSelection, {
      providerId: "independent-provider",
      modelId: "independent-model",
    });
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("no runId throws before sendPrompt", async () => {
  const captured: CapturedCall = {};
  const runExecutor = buildExecutor(captured);
  const agent = makeAgent({
    toolPolicy: { allowedTools: ["Bash"] },
  });
  const job = makeJob();
  delete job.runId;
  await assert.rejects(
    () => runExecutor({ job, agent }),
    /ZAICODE executor: job.*缺少 runId/,
  );
});
