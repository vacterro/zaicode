import assert from "node:assert/strict";
import test from "node:test";
import {
  useZaicodeActionIntents,
  formatIntentFeedback,
} from "../src/zaicode/zaicodeActionIntent.js";
import {
  useZaicodeFreshSession,
  useZaicodePendingCommand,
} from "../src/zaicode/zaicodeSaipen.js";
import {
  useZaicodeMainSessions,
  resolveZaicodeModeAction,
  ZAICODE_SAIPEN_MODES,
} from "../src/zaicode/zaicodeMainSession.js";
import {
  useZaicodeSessionRoles,
  submitWithZaicodeRole,
} from "../src/zaicode/zaicodeSessionRoles.js";
import { dispatchZaicodeModeAction } from "../src/zaicode/zaicodeModeDispatch.js";

test("FIX 7.01-7.05: 3 Core clicks while MAIN is running route to Host queue in FIFO order with immediate feedback", () => {
  useZaicodeActionIntents.getState().reset();
  useZaicodePendingCommand.setState({ byWorkspace: {} });
  useZaicodeMainSessions.setState({ byWorkspace: { "V:/project": "main-1" } });

  const testMode = ZAICODE_SAIPEN_MODES.find((m) => m.label === "TEST")!;
  const huntMode = ZAICODE_SAIPEN_MODES.find((m) => m.label === "HUNT")!;
  const cleanMode = ZAICODE_SAIPEN_MODES.find((m) => m.label === "CLEAN")!;

  const testAction = resolveZaicodeModeAction(testMode, false);
  const huntAction = resolveZaicodeModeAction(huntMode, false);
  const cleanAction = resolveZaicodeModeAction(cleanMode, false);

  const directDispatches: string[] = [];
  const hostQueue: string[] = [];

  const handleQueueMain = (action: typeof testAction, targetId: string, command: string) => {
    // Mimics useZaicodeModeCommands queueMain for active MAIN (sessionId === targetId)
    const intent = useZaicodeActionIntents.getState().createIntent({
      workspacePath: "V:/project",
      targetSessionId: targetId,
      destination: "main",
      action,
      command,
    });
    useZaicodeActionIntents.getState().transitionState(intent.id, "ADMISSION_PENDING");
    directDispatches.push(command);
    hostQueue.push(command);
    const updated = useZaicodeActionIntents.getState().transitionState(intent.id, "QUEUED", {
      queuePosition: hostQueue.length,
    });
    return updated;
  };

  // Dispatch 3 core clicks while MAIN is running
  const int1 = handleQueueMain(testAction, "main-1", "tt");
  const int2 = handleQueueMain(huntAction, "main-1", "hh");
  const int3 = handleQueueMain(cleanAction, "main-1", "saipen clean");

  assert.equal(int1?.state, "QUEUED");
  assert.equal(int1?.queuePosition, 1);
  assert.equal(formatIntentFeedback(int1!), "TT queued on MAIN (#1)");

  assert.equal(int2?.state, "QUEUED");
  assert.equal(int2?.queuePosition, 2);
  assert.equal(formatIntentFeedback(int2!), "HH queued on MAIN (#2)");

  assert.equal(int3?.state, "QUEUED");
  assert.equal(int3?.queuePosition, 3);
  assert.equal(formatIntentFeedback(int3!), "SAIPEN CLEAN queued on MAIN (#3)");

  assert.deepEqual(directDispatches, ["tt", "hh", "saipen clean"]);
  assert.deepEqual(hostQueue, ["tt", "hh", "saipen clean"]);
});

test("FIX 7.06-7.10: Rapid Shift clicks sequence distinct helper sessions in FIFO order without role inheritance", () => {
  useZaicodeActionIntents.getState().reset();
  useZaicodeFreshSession.getState().reset();
  useZaicodePendingCommand.setState({ byWorkspace: {} });
  useZaicodeSessionRoles.setState({ bySession: {}, armed: {} });

  const wikiMode = ZAICODE_SAIPEN_MODES.find((m) => m.label === "WIKI")!;
  const huntMode = ZAICODE_SAIPEN_MODES.find((m) => m.label === "HUNT")!;
  const testMode = ZAICODE_SAIPEN_MODES.find((m) => m.label === "TEST")!;

  const wikiShift = resolveZaicodeModeAction(wikiMode, true);
  const huntShift = resolveZaicodeModeAction(huntMode, true);
  const testShift = resolveZaicodeModeAction(testMode, true);

  // Rapid Shift clicks from main-1
  const openHelper = (action: typeof wikiShift) => {
    const intent = useZaicodeActionIntents.getState().createIntent({
      workspacePath: "V:/project",
      destination: "helper",
      action,
      command: action.command,
    });
    useZaicodeActionIntents.getState().transitionState(intent.id, "ADMISSION_PENDING");
    useZaicodeFreshSession
      .getState()
      .open("V:/project", undefined, action.command, action, "main-1");
  };

  openHelper(wikiShift);
  openHelper(huntShift);
  openHelper(testShift);

  const fresh = useZaicodeFreshSession.getState();
  assert.equal(fresh.queue.length, 3);
  assert.equal(fresh.currentId, 1);
  assert.equal(fresh.request?.command, "saiwiki");
  assert.equal(fresh.request?.action?.role, "WIKI");

  // Shell consumes first request and creates draft
  useZaicodeFreshSession.getState().consume(1);
  assert.equal(useZaicodeFreshSession.getState().request, null);

  // Draft 1 submits with role WIKI
  const pendingCmd1 = useZaicodePendingCommand.getState().take("V:/project")!;
  assert.equal(pendingCmd1.command, "saiwiki");
  submitWithZaicodeRole("V:/project", pendingCmd1.action?.role ?? "WIKI", () => true);
  useZaicodeSessionRoles.getState().claimIfArmed("V:/project", "helper-sess-1");
  useZaicodeFreshSession.getState().confirmSession("helper-sess-1");

  // Now currentId is 2, request is huntShift
  const fresh2 = useZaicodeFreshSession.getState();
  assert.equal(fresh2.currentId, 2);
  assert.equal(fresh2.request?.command, "saihunt");
  assert.equal(fresh2.request?.action?.role, "HUNT");

  // Shell consumes second request and creates draft 2
  useZaicodeFreshSession.getState().consume(2);
  const pendingCmd2 = useZaicodePendingCommand.getState().take("V:/project")!;
  assert.equal(pendingCmd2.command, "saihunt");
  submitWithZaicodeRole("V:/project", pendingCmd2.action?.role ?? "HUNT", () => true);
  useZaicodeSessionRoles.getState().claimIfArmed("V:/project", "helper-sess-2");
  useZaicodeFreshSession.getState().confirmSession("helper-sess-2");

  // Now currentId is 3, request is testShift
  const fresh3 = useZaicodeFreshSession.getState();
  assert.equal(fresh3.currentId, 3);
  assert.equal(fresh3.request?.command, "saitest");
  assert.equal(fresh3.request?.action?.role, "TEST");

  // Shell consumes third request
  useZaicodeFreshSession.getState().consume(3);
  const pendingCmd3 = useZaicodePendingCommand.getState().take("V:/project")!;
  assert.equal(pendingCmd3.command, "saitest");
  submitWithZaicodeRole("V:/project", pendingCmd3.action?.role ?? "TEST", () => true);
  useZaicodeSessionRoles.getState().claimIfArmed("V:/project", "helper-sess-3");
  useZaicodeFreshSession.getState().confirmSession("helper-sess-3");

  // Verify all 3 sessions have distinct durable roles
  const roles = useZaicodeSessionRoles.getState().bySession;
  assert.equal(roles["helper-sess-1"], "WIKI");
  assert.equal(roles["helper-sess-2"], "HUNT");
  assert.equal(roles["helper-sess-3"], "TEST");
});

test("FIX 7.11-7.14: Origin session cannot confirm its own helper request", () => {
  useZaicodeFreshSession.getState().reset();
  useZaicodePendingCommand.setState({ byWorkspace: {} });

  const wikiMode = ZAICODE_SAIPEN_MODES.find((m) => m.label === "WIKI")!;
  const wikiShift = resolveZaicodeModeAction(wikiMode, true);

  useZaicodeFreshSession
    .getState()
    .open("V:/project", undefined, wikiShift.command, wikiShift, "origin-main-session");

  assert.equal(useZaicodeFreshSession.getState().currentId, 1);

  // Calling confirmSession with the origin session ID should be ignored!
  useZaicodeFreshSession.getState().confirmSession("origin-main-session");
  assert.equal(useZaicodeFreshSession.getState().currentId, 1);

  // Calling with the newly created helper session confirms it
  useZaicodeFreshSession.getState().confirmSession("new-helper-session");
  assert.equal(useZaicodeFreshSession.getState().currentId, null);
});

test("FIX 7.15-7.18: Acknowledgement safety and restore guard on failure", () => {
  useZaicodePendingCommand.setState({ byWorkspace: {} });
  useZaicodeActionIntents.getState().reset();

  const huntMode = ZAICODE_SAIPEN_MODES.find((m) => m.label === "HUNT")!;
  const huntAction = resolveZaicodeModeAction(huntMode, false);

  useZaicodePendingCommand.getState().queue("V:/project", "hh", { sessionId: "main-1" }, huntAction);

  // Peek should not remove the item
  const peeked = useZaicodePendingCommand.getState().peek("V:/project", { sessionId: "main-1" });
  assert.equal(peeked?.command, "hh");

  // Take removes item
  const taken = useZaicodePendingCommand.getState().take("V:/project", { sessionId: "main-1" })!;
  assert.equal(taken.command, "hh");
  assert.equal(useZaicodePendingCommand.getState().peek("V:/project", { sessionId: "main-1" }), null);

  // If dispatch fails, restore puts it back at head
  useZaicodePendingCommand.getState().restore("V:/project", taken, { sessionId: "main-1" });
  assert.equal(useZaicodePendingCommand.getState().peek("V:/project", { sessionId: "main-1" })?.command, "hh");

  // Verify rejection feedback formatting
  const intent = useZaicodeActionIntents.getState().createIntent({
    workspacePath: "V:/project",
    targetSessionId: "main-1",
    destination: "main",
    action: huntAction,
    command: "hh",
  });
  const rejected = useZaicodeActionIntents.getState().transitionState(intent.id, "REJECTED", {
    rejectionReason: "Session rate limit exceeded",
  });
  assert.equal(formatIntentFeedback(rejected!), "HH rejected: Session rate limit exceeded");
});

test("FIX 7.19-7.22: Core action clicked from side/helper session switches to MAIN and delivers", () => {
  useZaicodePendingCommand.setState({ byWorkspace: {} });
  useZaicodeMainSessions.setState({ byWorkspace: { "V:/project": "main-iron" } });

  const huntMode = ZAICODE_SAIPEN_MODES.find((m) => m.label === "HUNT")!;
  const huntAction = resolveZaicodeModeAction(huntMode, false);

  const openedSessions: string[] = [];
  const ports = {
    send: () => {},
    claimMain: () => {},
    queueMain: (_id: string, command: string) => {
      useZaicodePendingCommand.getState().queue("V:/project", command, { sessionId: "main-iron" }, huntAction);
    },
    openMain: (id: string) => {
      openedSessions.push(id);
    },
    openHelper: () => {},
    openMainDraft: () => {},
  };

  // User is in side session helper-1, MAIN is busy
  dispatchZaicodeModeAction(
    huntAction,
    {
      sessionId: "helper-1",
      mainId: "main-iron",
      mainWorking: true,
      disabled: false,
    },
    ports,
  );

  // Must have queued to MAIN and requested openMain("main-iron")
  assert.deepEqual(openedSessions, ["main-iron"]);
  const queued = useZaicodePendingCommand.getState().take("V:/project", { sessionId: "main-iron" });
  assert.equal(queued?.command, "hh");
  assert.equal(queued?.action?.kind, "core");
});
