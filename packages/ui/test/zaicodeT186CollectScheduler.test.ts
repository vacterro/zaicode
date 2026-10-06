import assert from "node:assert/strict";
import test from "node:test";
import { createZaicodeAutostartJob, type ZaicodeAutostartDecision } from "@zcode/shared";
import { ZaicodeOutboxCollectGuard, parseZaicodeOutbox } from "../src/zaicode/zaicodeSubOutbox.js";
import {
  zaicodePreparedEngines,
  zaicodeUpcomingSchedules,
} from "../src/zaicode/zaicodeScheduler.js";
import { useZaicodeStore } from "../src/zaicode/zaicodeStore.js";
import type { ZaicodeServices, ZaicodeWorkspaceContext } from "../src/zaicode/zaicodeServices.js";

const ready = (id = "HUNT-001", head = "head-a", producer = "saihunt") =>
  parseZaicodeOutbox(
    `## ${id}: ready package\n- **status:** ready\n- **producer:** ${producer}\n- **source_head:** ${head}\n- **source_tree_fingerprint:** tree-a\n- **role_revision:** role-a`,
  );

test("one ready generation is not redelivered across composer delivery attempts", () => {
  const guard = new ZaicodeOutboxCollectGuard();
  const commands: string[] = [];
  const send = (command: string) => {
    commands.push(command);
    return true;
  };
  for (let attempt = 0; attempt < 50; attempt++) guard.collect("workspace-a", ready(), send);
  assert.deepEqual(commands, ["saipen collect saihunt"]);
  guard.collect("workspace-a", ready("HUNT-002"), send);
  guard.collect("workspace-a", ready("HUNT-002", "head-b"), send);
  guard.collect("workspace-b", ready("HUNT-002", "head-b"), send);
  guard.collect("workspace-a", ready("HUNT-001"), send);
  assert.equal(commands.length, 4);
});

test("new producers do not reset earlier producer admission, and order changes do not retrigger it", () => {
  const guard = new ZaicodeOutboxCollectGuard();
  const commands: string[] = [];
  const send = (command: string) => {
    commands.push(command);
  };
  const hunt = ready();
  const wiki = ready("WIKI-001", "head-a", "saiwiki");
  guard.collect("workspace", hunt, send);
  guard.collect("workspace", [...wiki, ...hunt], send);
  guard.collect("workspace", [...hunt, ...wiki], send);
  assert.deepEqual(commands, ["saipen collect saihunt", "saipen collect saiwiki"]);
});

test("rejected or throwing local submission does not consume admission; manual retry remains possible", () => {
  const guard = new ZaicodeOutboxCollectGuard();
  assert.deepEqual(
    guard.collect("w", ready(), () => false),
    [],
  );
  assert.throws(() =>
    guard.collect("w", ready(), () => {
      throw new Error("local rejection");
    }),
  );
  const commands: string[] = [];
  const send = (command: string) => {
    commands.push(command);
    return true;
  };
  guard.collect("w", ready(), send);
  guard.collect("w", ready(), send);
  guard.collect("w", ready(), send, true);
  assert.equal(commands.length, 2);
});

test("a synchronous second composer cannot redeliver an admitted generation", () => {
  const guard = new ZaicodeOutboxCollectGuard();
  let sent = 0;
  guard.collect("w", ready(), () => {
    sent += 1;
    guard.collect("w", ready(), () => {
      sent += 1;
    });
  });
  assert.equal(sent, 1);
});

const decision: ZaicodeAutostartDecision = {
  state: "waiting-reset",
  dueAt: 12345,
  eventId: "occurrence",
  reason: "",
};
const job = createZaicodeAutostartJob({
  id: "night",
  projectPath: "P",
  engineId: "agent:a",
  watchEngineId: "claude:a",
  trigger: "everyReset",
});

test("Autopilot off changes readiness and prepared glow, without consuming a planned occurrence", () => {
  const before = JSON.stringify(job);
  const paused = zaicodeUpcomingSchedules([job], () => decision, false)[0]!;
  assert.equal(paused.autopilotRequired, true);
  assert.equal(paused.decision.eventId, "occurrence");
  assert.equal(paused.decision.dueAt, 12345);
  assert.equal(zaicodePreparedEngines([job], () => decision, false).size, 0);
  assert.equal(zaicodeUpcomingSchedules([job], () => decision, true)[0]!.autopilotRequired, false);
  assert.equal(zaicodePreparedEngines([job], () => decision, true).size, 1);
  assert.equal(JSON.stringify(job), before);
});

test("a missed or invalid schedule retains its real reason while Autopilot is off", () => {
  for (const state of ["missed", "invalid", "done", "disabled"] as const) {
    const upcoming = zaicodeUpcomingSchedules([job], () => ({ ...decision, state }), false);
    assert.equal(upcoming[0]?.autopilotRequired ?? false, false);
  }
});

test("the Autopilot projection reads host state and refuses a stale read after a confirmed toggle", async () => {
  let resolveOld!: (value: boolean) => void;
  let calls = 0;
  const services = {
    jobs: {
      getAutoRun: () =>
        ++calls === 1
          ? new Promise<boolean>((resolve) => {
              resolveOld = resolve;
            })
          : Promise.resolve(false),
      setAutoRun: async () => {},
      list: async () => ({ jobs: [], diagnostics: [] }),
      getMaxConcurrency: async () => 1,
    },
    agents: { list: async () => ({ agents: [], diagnostics: [] }), listTemplates: async () => [] },
  } as unknown as ZaicodeServices;
  const workspace = { workspaceKey: "w", workspacePath: "P" } as ZaicodeWorkspaceContext;
  const store = useZaicodeStore.getState();
  const pending = store.refreshAutoRun(services);
  await store.setAutoRun(services, workspace, false);
  resolveOld(true);
  assert.equal(await pending, false);
  assert.equal(useZaicodeStore.getState().autoRun, false);
  assert.equal(await store.refreshAutoRun(null), false);
});

test("a full queue refresh cannot overwrite a confirmed Autopilot toggle with an older read", async () => {
  let resolveOld!: (value: boolean) => void;
  let resolveTrailing!: (value: boolean) => void;
  let readStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  let calls = 0;
  const services = {
    jobs: {
      // T-249 made refresh single-flight: the second read belongs to the trailing
      // pass, so it is held too -- that is what lets the stale read be answered
      // while no newer pass has committed yet.
      getAutoRun: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<boolean>((resolve) => {
            resolveOld = resolve;
            readStarted();
          });
        }
        if (calls === 2) {
          return new Promise<boolean>((resolve) => {
            resolveTrailing = resolve;
          });
        }
        return Promise.resolve(false);
      },
      setAutoRun: async () => {},
      list: async () => ({ jobs: [], diagnostics: [] }),
      getMaxConcurrency: async () => 1,
    },
    agents: { list: async () => ({ agents: [], diagnostics: [] }), listTemplates: async () => [] },
  } as unknown as ZaicodeServices;
  const workspace = { workspaceKey: "w", workspacePath: "P" } as ZaicodeWorkspaceContext;
  useZaicodeStore.setState({ autoRun: true });
  const store = useZaicodeStore.getState();
  const pending = store.refresh(services, workspace);
  await started;
  // The toggle's own refresh is the trailing pass and only starts once this pass
  // is released, so start it, let the toggle be confirmed, and then answer the
  // held older read: the claim under test is the stale-read guard, not the
  // scheduling order.
  const toggle = store.setAutoRun(services, workspace, false);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(useZaicodeStore.getState().autoRun, false, "the toggle is confirmed first");

  resolveOld(true);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(
    useZaicodeStore.getState().autoRun,
    false,
    "an older read answering `true` after the toggle cannot resurrect Autopilot",
  );

  assert.ok(resolveTrailing, "the trailing pass asked the host for the Autopilot setting");
  resolveTrailing(false);
  await toggle;
  await pending;
  assert.equal(useZaicodeStore.getState().autoRun, false);
});
