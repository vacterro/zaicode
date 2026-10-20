import assert from "node:assert/strict";
import { test } from "node:test";
import { modelConfigHandlers } from "../src/zcode-protocol-v4/commands/handlers/model-config.js";
import { V4CommandNoopError } from "../src/zcode-protocol-v4/v4-gateway.js";

/**
 * T-396 (SRC-298 Wave 2): the same-model branch of `switchModelConfig` is the live
 * Effort path. A thought-only change must call the runtime's thought setter and publish
 * the resulting effective level; a same-value change must answer `config.unchanged`
 * instead of spending a revision, and a rejected level must not publish anything.
 */

const LEVELS = ["low", "medium", "high"];

function harness(options: { currentThought: string; nextThought?: string | (() => never) } = { currentThought: "low" }) {
  const calls: string[] = [];
  const emitted: any[] = [];
  const selection = { providerId: "router", modelId: "SAIFREN", options: { reasoningLevel: options.currentThought } };
  const app = {
    sessionId: "s-1",
    runtime: {
      getSessionModelSelection: () => selection,
      emitModelSelected: async (event: any) => {
        calls.push("emitModelSelected");
        emitted.push(event);
      },
    },
    getThoughtLevel: () => options.currentThought,
    listThoughtLevels: () => LEVELS,
    setModel: async () => {
      throw new Error("the same-model effort path must not call setModel");
    },
    setThoughtLevel: async (level: string) => {
      calls.push(`setThoughtLevel:${level}`);
      if (typeof options.nextThought === "function") (options.nextThought as () => never)();
      return { thoughtLevel: options.nextThought ?? level };
    },
  };
  const host = {
    getRecord: (sessionId: string) => (sessionId === "s-1" ? { app, traceContext: { traceId: "t-1" }, workspace: { workspacePath: "w" }, persistence: "immediate" as const } : undefined),
  };
  const envelope = {
    sessionId: "s-1",
    commandId: "cmd-1",
    payload: { provider: "router", model: "SAIFREN", thought: "high" },
  };
  return { host: host as any, envelope: envelope as any, calls, emitted };
}

test("T-396: the same-model thought branch sets the level and publishes it", async () => {
  const { host, envelope, calls, emitted } = harness({ currentThought: "low" });
  await modelConfigHandlers.switchModelConfig(host, envelope);
  assert.deepEqual(calls, ["setThoughtLevel:high", "emitModelSelected"]);
  assert.equal(emitted[0]!.effectiveReasoningLevel, "high");
  assert.deepEqual(emitted[0]!.modelSelection, {
    providerId: "router",
    modelId: "SAIFREN",
    options: { reasoningLevel: "high" },
  });
  assert.equal(emitted[0]!.previousModelSelection.providerId, "router");
  assert.equal(
    emitted[0]!.modelSelection.providerId,
    emitted[0]!.previousModelSelection.providerId,
    "a thought change is not a model identity change",
  );
});

test("T-396: picking the level the session already pins is a noop, not a re-write", async () => {
  const { host, envelope, calls } = harness({ currentThought: "high" });
  await assert.rejects(
    () => modelConfigHandlers.switchModelConfig(host, envelope),
    (error: unknown) => error instanceof V4CommandNoopError && error.reasonCode === "config.unchanged",
  );
  assert.deepEqual(calls, [], "no setter, no event");
});

test("T-396: a rejected level never publishes a ModelSelected", async () => {
  const { host, envelope, calls, emitted } = harness({
    currentThought: "low",
    nextThought: () => {
      throw new Error("reasoning level not supported");
    },
  });
  await assert.rejects(
    () => modelConfigHandlers.switchModelConfig(host, envelope),
    /not supported/,
  );
  assert.deepEqual(calls, ["setThoughtLevel:high"]);
  assert.equal(emitted.length, 0, "a failed setter must not claim the switch");
});
