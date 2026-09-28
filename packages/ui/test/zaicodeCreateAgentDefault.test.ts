import assert from "node:assert/strict";
import test from "node:test";

// T-102: zaicodeStore.createAgent seeded a new agent's pool straight from the
// localStorage default (readZaicodeDefaultModel) with no check that the model is
// available on this machine. On a machine with no router/provider that wrote an
// unresolvable pool (e.g. sairoute/SAIFREN) onto the agent while the UI said no
// SAIFREN pool is configured. The fix resolves the default against the live
// ModelSelectionView first, and leaves the selection unresolved when it cannot.

/** Minimal browser globals so zaicodeDefaultModel's localStorage read works. */
class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}
const storage = new MemoryStorage();
const fakeWindow = Object.assign(new EventTarget(), { localStorage: storage });
Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

const { useZaicodeStore } = await import("../src/zaicode/zaicodeStore.js");
const { setZaicodeDefaultModel } = await import("../src/zaicode/zaicodeDefaultModel.js");

interface CreatedInput {
  modelSelection?: { providerId: string; modelId: string; options?: { reasoningLevel?: string } };
}

function makeServices(view: unknown) {
  const created: CreatedInput[] = [];
  const services = {
    modelSelection: {
      onDidChange: () => () => {},
      getView: async () => view,
    },
    agents: {
      list: async () => ({ agents: [], diagnostics: [] }),
      listTemplates: async () => [],
      create: async (input: CreatedInput) => {
        created.push(input);
        return { id: "agent-1", ...input };
      },
    },
    jobs: {
      list: async () => ({ jobs: [], diagnostics: [] }),
      getMaxConcurrency: async () => 1,
      getAutoRun: async () => true,
    },
    audits: null,
  } as never;
  return { services, created };
}

const workspace = { workspaceKey: "k", workspacePath: "V:/proj" } as never;
const newAgentInput = { name: "A", role: "worker", instructions: "" } as never;

const availableView = {
  revision: 1,
  providers: [
    {
      providerId: "new-provider",
      config: {},
      models: [
        {
          modelId: "SAIFREN",
          config: { optionSpecs: { reasoningLevel: { values: ["low", "medium", "high"] } } },
        },
      ],
    },
  ],
};

const emptyView = { revision: 1, providers: [] };

test("createAgent seeds the default only when it resolves against the available view", async () => {
  setZaicodeDefaultModel({ providerId: "new-provider", modelId: "SAIFREN" });
  const { services, created } = makeServices(availableView);
  await useZaicodeStore.getState().createAgent(services, workspace, newAgentInput);
  assert.equal(created.length, 1);
  assert.deepEqual(created[0]!.modelSelection, {
    providerId: "new-provider",
    modelId: "SAIFREN",
    options: { reasoningLevel: "medium" },
  });
});

test("createAgent leaves the pool unresolved when the default is not available on this machine", async () => {
  // The stale default names a SAIFREN pool this machine never configured.
  setZaicodeDefaultModel({ providerId: "sairoute", modelId: "SAIFREN" });
  const { services, created } = makeServices(emptyView);
  await useZaicodeStore.getState().createAgent(services, workspace, newAgentInput);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.modelSelection, undefined, "no fabricated pool when nothing resolves");
});

test("an explicit selection is never overridden by the default resolver", async () => {
  setZaicodeDefaultModel({ providerId: "new-provider", modelId: "SAIFREN" });
  let viewRead = false;
  const services = {
    modelSelection: {
      onDidChange: () => () => {},
      getView: async () => {
        viewRead = true;
        return availableView;
      },
    },
    agents: {
      list: async () => ({ agents: [], diagnostics: [] }),
      listTemplates: async () => [],
      create: async (input: CreatedInput) => ({ id: "agent-2", ...input }),
    },
    jobs: {
      list: async () => ({ jobs: [], diagnostics: [] }),
      getMaxConcurrency: async () => 1,
      getAutoRun: async () => true,
    },
    audits: null,
  } as never;
  const explicit = {
    name: "B",
    role: "worker",
    instructions: "",
    modelSelection: { providerId: "explicit", modelId: "M" },
  } as never;
  await useZaicodeStore.getState().createAgent(services, workspace, explicit);
  assert.equal(viewRead, false, "no view read when the caller already chose a model");
});
