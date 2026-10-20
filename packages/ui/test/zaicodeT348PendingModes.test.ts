import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_SAIPEN_MODES,
  resolveZaicodeModeAction,
} from "../src/zaicode/zaicodeMainSession.js";
import {
  hasZaicodePendingCommand,
  useZaicodePendingCommand,
} from "../src/zaicode/zaicodeSaipen.js";

test("Core and helper intents consume once at their exact session and workspace identity", () => {
  useZaicodePendingCommand.setState({ byWorkspace: {} });
  const { queue, take } = useZaicodePendingCommand.getState();
  queue("V:/project", "hh", { workspaceIdentity: "host-A/project", sessionId: "main" });
  queue("V:/project", "saihunt", { workspaceIdentity: "host-A/project" });
  assert.equal(
    take("V:/project", { workspaceIdentity: "host-B/project", sessionId: "main" }),
    null,
  );
  assert.equal(
    take("V:/project", { workspaceIdentity: "host-A/project", sessionId: "side" }),
    null,
  );
  assert.equal(take("V:/project"), null);
  assert.equal(
    take("V:/project", { workspaceIdentity: "host-A/project", sessionId: "main" })?.command,
    "hh",
  );
  assert.equal(
    take("V:/project", { workspaceIdentity: "host-A/project", sessionId: "main" }),
    null,
  );
  assert.equal(take("V:/project", { workspaceIdentity: "host-A/project" })?.command, "saihunt");
  assert.equal(take("V:/project", { workspaceIdentity: "host-A/project" }), null);
});

test("separate deliberate clicks remain FIFO; legacy draft commands preserve Windows path equivalence", () => {
  useZaicodePendingCommand.setState({ byWorkspace: {} });
  const { queue, take } = useZaicodePendingCommand.getState();
  queue("V:\\project\\", "qq");
  queue("v:/project", "tt");
  assert.equal(hasZaicodePendingCommand(useZaicodePendingCommand.getState(), "V:/PROJECT"), true);
  assert.equal(take("v:/project")?.command, "qq");
  assert.equal(take("V:\\PROJECT")?.command, "tt");
  assert.equal(hasZaicodePendingCommand(useZaicodePendingCommand.getState(), "V:/project"), false);
});

test("deferred modes retain their selected kind and ownership after Shift is released", () => {
  useZaicodePendingCommand.setState({ byWorkspace: {} });
  const hunt = ZAICODE_SAIPEN_MODES.find((mode) => mode.label === "HUNT")!;
  const selected = resolveZaicodeModeAction(hunt, true);
  const { queue, take } = useZaicodePendingCommand.getState();
  queue("project", selected.command, undefined, selected);
  assert.equal(resolveZaicodeModeAction(hunt, false).command, "hh");
  const helper = take("project")!;
  assert.equal(helper.command, "saihunt");
  assert.equal(helper.action?.kind, "subSaipen");
  assert.equal(helper.action?.ownership, "helper");
  assert.equal(helper.action?.role, "HUNT");
  const normal = resolveZaicodeModeAction(hunt, false);
  queue("project", normal.command, { sessionId: "main" }, normal);
  const core = take("project", { sessionId: "main" })!;
  assert.equal(core.command, "hh");
  assert.equal(core.action?.kind, "core");
  assert.equal(core.action?.ownership, "main");
  assert.equal(core.action?.role, undefined);
});
