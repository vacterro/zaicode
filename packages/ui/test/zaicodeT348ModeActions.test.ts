import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_SAIPEN_MODES,
  formatZaicodeModeTooltip,
  resolveZaicodeModeAction,
  useZaicodeMainSessions,
} from "../src/zaicode/zaicodeMainSession.js";
import { dispatchZaicodeModeAction } from "../src/zaicode/zaicodeModeDispatch.js";
import {
  submitWithZaicodeRole,
  useZaicodeSessionRoles,
  zaicodeRoleForCommand,
  zaicodeRoleFromTitle,
} from "../src/zaicode/zaicodeSessionRoles.js";

const expected = [
  ["WIKI", "qq", "saiwiki"],
  ["TRANSL", "saipen translate", "saitranslate"],
  ["TEST", "tt", "saitest"],
  ["HUNT", "hh", "saihunt"],
  ["AUDIT", "aa", null],
  ["CLEAN", "saipen clean", null],
  ["CREW", "sc", null],
] as const;

function harness(patch: Partial<Parameters<typeof dispatchZaicodeModeAction>[1]> = {}) {
  const calls: unknown[][] = [];
  const input = {
    sessionId: "side",
    mainId: "main",
    mainWorking: false,
    disabled: false,
    ...patch,
  };
  const ports = {
    send: (command: string) => {
      calls.push(["send", command]);
    },
    claimMain: () => {
      calls.push(["claimMain"]);
    },
    queueMain: (sessionId: string, command: string) =>
      calls.push(["queueMain", sessionId, command]),
    openMain: (sessionId: string) => calls.push(["openMain", sessionId]),
    openHelper: (command: string) => calls.push(["openHelper", command]),
    openMainDraft: (command: string) => calls.push(["openMainDraft", command]),
  };
  return { calls, input, ports };
}

test("SRC-257 exact normal/Shift table, typed ownership and action-specific concurrency", () => {
  assert.deepEqual(
    ZAICODE_SAIPEN_MODES.map((mode) => mode.label),
    expected.map(([label]) => label),
  );
  for (const [label, normal, shifted] of expected) {
    const mode = ZAICODE_SAIPEN_MODES.find((item) => item.label === label)!;
    const core = resolveZaicodeModeAction(mode, false);
    assert.equal(core.command, normal);
    assert.equal(core.kind, "core");
    assert.equal(core.ownership, "main");
    assert.equal(
      core.parallel,
      false,
      "Core actions serialize at MAIN even when their name is a helper name",
    );
    assert.equal(core.role, undefined);
    const alternate = resolveZaicodeModeAction(mode, true);
    assert.equal(alternate.command, shifted ?? normal);
    assert.equal(alternate.kind, shifted ? "subSaipen" : "core");
    assert.equal(alternate.ownership, shifted ? "helper" : "main");
    assert.equal(
      alternate.parallel,
      Boolean(shifted),
      "installed helpers are read-only toward the project",
    );
    assert.equal(alternate.role, shifted ? label : undefined);
    const tooltip = formatZaicodeModeTooltip(mode);
    assert.match(tooltip, /Click: Core/);
    assert.equal(tooltip.includes("Shift+Click:"), Boolean(shifted));
  }
});

test("MAIN routes Core HUNT in place once, and busy MAIN retains it for admission", () => {
  const hunt = ZAICODE_SAIPEN_MODES.find((mode) => mode.label === "HUNT")!.defaultAction;
  const idle = harness({ sessionId: "main" });
  dispatchZaicodeModeAction(hunt, idle.input, idle.ports);
  assert.deepEqual(idle.calls, [["send", "hh"]]);
  const busy = harness({ sessionId: "main", mainWorking: true, disabled: true });
  dispatchZaicodeModeAction(hunt, busy.input, busy.ports);
  assert.deepEqual(busy.calls, [["queueMain", "main", "hh"]]);
});

test("side sessions and drafts target the existing MAIN even while it runs", () => {
  const core = ZAICODE_SAIPEN_MODES.find((mode) => mode.label === "HUNT")!.defaultAction;
  for (const sessionId of ["side", null])
    for (const mainWorking of [false, true]) {
      const h = harness({ sessionId, mainWorking });
      dispatchZaicodeModeAction(core, h.input, h.ports);
      assert.deepEqual(h.calls, [
        ["queueMain", "main", "hh"],
        ["openMain", "main"],
      ]);
    }
});

test("Core without MAIN claims the current session/draft without a helper role", () => {
  for (const sessionId of ["side", null]) {
    const h = harness({ mainId: null, sessionId });
    dispatchZaicodeModeAction(ZAICODE_SAIPEN_MODES[0]!.defaultAction, h.input, h.ports);
    assert.deepEqual(h.calls, [["claimMain"], ["send", "qq"]]);
  }
});

test("persistent HUNT opens exactly one helper in every MAIN/side/draft context", () => {
  const hunt = ZAICODE_SAIPEN_MODES.find((mode) => mode.label === "HUNT")!.shiftAction!;
  for (const sessionId of ["main", "side", null])
    for (const mainId of ["main", null]) {
      const h = harness({ sessionId, mainId, mainWorking: true, disabled: true });
      dispatchZaicodeModeAction(hunt, h.input, h.ports);
      assert.deepEqual(h.calls, [["openHelper", "saihunt"]]);
    }
});

test("Core command names and unsupported names never infer persistent roles", () => {
  for (const [, command] of expected) {
    assert.equal(zaicodeRoleForCommand(command), null, command);
    assert.equal(zaicodeRoleFromTitle(command), null, command);
  }
  for (const command of [
    "saiaudit",
    "saiclean",
    "saicrew",
    "markhunt",
    "saipen crew",
    "saipen hunt",
  ]) {
    assert.equal(zaicodeRoleForCommand(command), null, command);
  }
  for (const [label, , command] of expected)
    if (command) {
      assert.equal(zaicodeRoleForCommand(command), label);
      assert.equal(zaicodeRoleFromTitle(command + " project scan"), label);
    }
});

test("Shift preview cannot latch the selection after the next unmodified activation", () => {
  const hunt = ZAICODE_SAIPEN_MODES.find((mode) => mode.label === "HUNT")!;
  assert.equal(resolveZaicodeModeAction(hunt, true).command, "saihunt");
  assert.equal(resolveZaicodeModeAction(hunt, false).command, "hh");
});

test("rejected or throwing helper submissions cannot label the next Core session", () => {
  for (const throws of [false, true]) {
    useZaicodeSessionRoles.setState({ bySession: { legacy: "AUDIT" }, armed: {} });
    const submit = () => {
      assert.equal(useZaicodeSessionRoles.getState().armed.project, "HUNT");
      if (throws) throw new Error("submission rejected");
      return false;
    };
    if (throws)
      assert.throws(() => submitWithZaicodeRole("project", "HUNT", submit), /submission rejected/);
    else assert.equal(submitWithZaicodeRole("project", "HUNT", submit), false);
    useZaicodeSessionRoles.getState().claimIfArmed("project", "core-main");
    assert.equal(useZaicodeSessionRoles.getState().bySession["core-main"], undefined);
    assert.equal(useZaicodeSessionRoles.getState().bySession.legacy, "AUDIT");
  }
});

test("accepted helpers retain their durable identity and unrelated provisional roles", () => {
  useZaicodeSessionRoles.setState({ bySession: { legacy: "CLEAN" }, armed: {} });
  useZaicodeSessionRoles.getState().arm("other-project", "WIKI");
  submitWithZaicodeRole("project", "HUNT", () => true);
  useZaicodeSessionRoles.getState().claimIfArmed("project", "accepted-helper");
  assert.equal(useZaicodeSessionRoles.getState().bySession["accepted-helper"], "HUNT");
  assert.equal(useZaicodeSessionRoles.getState().armed["other-project"], "WIKI");
  assert.equal(useZaicodeSessionRoles.getState().bySession.legacy, "CLEAN");
  submitWithZaicodeRole("project", "TEST", () => {
    useZaicodeSessionRoles.getState().arm("project", "TRANSL");
    return false;
  });
  assert.equal(useZaicodeSessionRoles.getState().armed.project, "TRANSL");
});

test("rejected Core modes undo only their own MAIN claim, including throwing submissions", () => {
  const core = ZAICODE_SAIPEN_MODES.find((mode) => mode.label === "HUNT")!.defaultAction;
  for (const sessionId of [null, "existing-side"])
    for (const throws of [false, true]) {
      useZaicodeMainSessions.setState({ byWorkspace: { other: "other-main" }, armed: {} });
      const h = harness({ mainId: null, sessionId });
      const ports = {
        ...h.ports,
        claimMain: () => useZaicodeMainSessions.getState().provision("project", sessionId),
        send: () => {
          if (throws) throw new Error("Core rejected");
          return false;
        },
      };
      if (throws)
        assert.throws(() => dispatchZaicodeModeAction(core, h.input, ports), /Core rejected/);
      else dispatchZaicodeModeAction(core, h.input, ports);
      assert.equal(useZaicodeMainSessions.getState().claimIfArmed("project", "next-helper"), false);
      assert.deepEqual(useZaicodeMainSessions.getState().byWorkspace, { other: "other-main" });
    }
});

test("MAIN rollback preserves a prior reservation and a different owner chosen during submission", () => {
  useZaicodeMainSessions.setState({ byWorkspace: {}, armed: {} });
  useZaicodeMainSessions.getState().arm("project");
  useZaicodeMainSessions.getState().provision("project", null)();
  assert.equal(useZaicodeMainSessions.getState().claimIfArmed("project", "original-core"), true);
  const undo = useZaicodeMainSessions.getState().provision("new-project", "candidate");
  useZaicodeMainSessions.getState().setMain("new-project", "operator-choice");
  undo();
  assert.deepEqual(useZaicodeMainSessions.getState().byWorkspace, {
    project: "original-core",
    "new-project": "operator-choice",
  });
});

test("Core from a durable helper opens a distinct MAIN while an existing MAIN always keeps ownership", () => {
  const core = ZAICODE_SAIPEN_MODES.find((mode) => mode.label === "HUNT")!.defaultAction;
  const unbound = harness({
    sessionId: "helper",
    mainId: null,
    helperSession: true,
    disabled: true,
  });
  dispatchZaicodeModeAction(core, unbound.input, unbound.ports);
  assert.deepEqual(unbound.calls, [["openMainDraft", "hh"]]);
  const bound = harness({
    sessionId: "helper",
    mainId: "main",
    helperSession: true,
    mainWorking: true,
  });
  dispatchZaicodeModeAction(core, bound.input, bound.ports);
  assert.deepEqual(bound.calls, [
    ["queueMain", "main", "hh"],
    ["openMain", "main"],
  ]);
});
