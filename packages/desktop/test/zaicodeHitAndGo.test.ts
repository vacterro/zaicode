import assert from "node:assert/strict";
import test from "node:test";
import { IModelSelectionService, IZCodeTaskService, type ServiceCollection } from "@zcode/services";
import type { ZaicodeAgentDefinition, ZaicodeJob } from "@zcode/shared";
import { buildZaicodeJobPrompt, createZaicodeJobExecutor } from "../src/host/zaicodeRunDispatch.js";

const persona = "You are ZAICODE Autopilot.";

test("a slash command or bare shortcut reaches the agent alone and first (SRC-038)", () => {
  assert.equal(
    buildZaicodeJobPrompt({ jobId: "j", jobTitle: "t", jobInstructions: "/goal cc all", agentInstructions: persona }),
    "/goal cc all",
  );
  assert.equal(buildZaicodeJobPrompt({ jobId: "j", jobTitle: "t", jobInstructions: "cc", agentInstructions: persona }), "cc");
  assert.equal(
    buildZaicodeJobPrompt({ jobId: "j", jobTitle: "t", jobInstructions: "   ", agentInstructions: persona }),
    "/goal cc all",
    "an empty task is hit and go",
  );
  const task = buildZaicodeJobPrompt({ jobId: "j", jobTitle: "Fix", jobInstructions: "fix the login", agentInstructions: persona });
  assert.equal(task, `${persona}\n\n---\n\nZAICODE task j: Fix\n\nfix the login`);
});

interface Captured {
  createTaskArgs?: Record<string, unknown>;
  sendPromptArgs?: Record<string, unknown>;
}

function services(captured: Captured, providers: unknown[]): ServiceCollection {
  const taskService = {
    createTask: async (params: Record<string, unknown>) => {
      captured.createTaskArgs = params;
      return { taskId: "task", traceId: "trace" };
    },
    sendPrompt: async (params: Record<string, unknown>) => {
      captured.sendPromptArgs = params;
    },
    stopGeneration: async () => {},
    onDynamicTaskTerminalOutcome: () => () => ({ dispose: () => {} }),
  } as unknown as IZCodeTaskService;
  const selection = { getView: async () => ({ revision: 1, providers }) };
  return {
    getOptional: <T>(service: { channelName: string }): T | undefined => {
      if (service.channelName === (IZCodeTaskService as unknown as { channelName: string }).channelName) return taskService as unknown as T;
      if (service.channelName === (IModelSelectionService as unknown as { channelName: string }).channelName) return selection as unknown as T;
      return undefined;
    },
  } as unknown as ServiceCollection;
}

const job = {
  id: "job",
  workspaceKey: "ws",
  workspacePath: "C:\\ws",
  agentId: "a",
  title: "/goal cc all",
  instructions: "/goal cc all",
  status: "queued",
  priority: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  attempt: 0,
  runId: "run",
} as ZaicodeJob;

const agentWithoutPool = {
  id: "zaicode-agent:auto",
  name: "Autopilot",
  role: "implementer",
  instructions: persona,
  enabled: true,
  toolPolicy: {},
  backend: "direct",
  createdAt: 0,
  updatedAt: 0,
} as unknown as ZaicodeAgentDefinition;

test("an agent without a pool runs on SAIFREN instead of failing with route-unresolved", async () => {
  const captured: Captured = {};
  const run = createZaicodeJobExecutor({
    resolveServices: () =>
      services(captured, [
        { providerId: "sr", providerName: "SAIRoute", config: {}, models: [{ modelId: "SAIFREN", config: { optionSpecs: { reasoningLevel: { values: [] } } } }] },
      ]),
    logWarn: () => {},
  });
  await run({ job, agent: agentWithoutPool });
  assert.deepEqual(captured.createTaskArgs?.modelSelection, { providerId: "sr", modelId: "SAIFREN" });
  assert.equal(captured.sendPromptArgs?.content, "/goal cc all");
});

test("with no pool anywhere the old explanation still stops the run", async () => {
  const run = createZaicodeJobExecutor({ resolveServices: () => services({}, []), logWarn: () => {} });
  await assert.rejects(run({ job, agent: agentWithoutPool }), /route-unresolved/);
});
