import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { PermissionService } from "../src/permission/service.js";
import {
  ZAICODE_FULL_ACCESS_RULE_ID,
  zaicodeFullAccessApplies,
  zaicodeFullAccessEnabled,
} from "../src/permission/zaicode-full-access.js";

/**
 * T-136 (SRC-100): "remove the approvals, ZAICODE is FULL ACCESS by default". A session stored as
 * build ("Ask before changes") stopped on a Permission required card for `saipen.cmd continue`.
 */

const saved = { mode: process.env.ZCODE_ZAICODE_MODE, prompts: process.env.ZAICODE_PERMISSION_PROMPTS };

beforeEach(() => {
  process.env.ZCODE_ZAICODE_MODE = "1";
  delete process.env.ZAICODE_PERMISSION_PROMPTS;
});

afterEach(() => {
  if (saved.mode === undefined) delete process.env.ZCODE_ZAICODE_MODE;
  else process.env.ZCODE_ZAICODE_MODE = saved.mode;
  if (saved.prompts === undefined) delete process.env.ZAICODE_PERMISSION_PROMPTS;
  else process.env.ZAICODE_PERMISSION_PROMPTS = saved.prompts;
});

const bash = (mode: "build" | "edit" | "yolo" | "plan" | "auto") => ({
  toolName: "Bash",
  input: { command: '"C:\\Users\\vac34\\AppData\\Local\\saipen\\scheduled-source\\bin\\saipen.cmd" continue --json' },
  riskLevel: "high" as const,
  mode,
});

test("a session stored as build or edit runs the operator's command without a card", () => {
  const service = new PermissionService();
  for (const mode of ["build", "edit", "auto"] as const) {
    const decision = service.checkPermission(bash(mode), { destructive: true, riskLevel: "high" });
    assert.equal(decision.decision, "allow", mode);
    assert.equal(decision.ruleId, ZAICODE_FULL_ACCESS_RULE_ID, mode);
  }
});

test("outside ZAICODE the same build session still asks (upstream unchanged)", () => {
  delete process.env.ZCODE_ZAICODE_MODE;
  const decision = new PermissionService().checkPermission(bash("build"), {
    destructive: true,
    riskLevel: "high",
  });
  assert.notEqual(decision.decision, "allow");
});

test("plan mode, questions to the user, the self-kill guard and disallowed tools stay", () => {
  const service = new PermissionService();
  assert.equal(zaicodeFullAccessApplies({ mode: "plan" }), false);
  assert.equal(zaicodeFullAccessApplies({ mode: "build", planEnabled: true }), false);
  const question = service.checkPermission(
    { toolName: "AskUserQuestion", input: {}, riskLevel: "low", mode: "build" },
    { requiresUserInteraction: true },
  );
  assert.equal(question.decision, "ask");
  const selfKill = service.checkPermission(
    { toolName: "Bash", input: { command: "taskkill /F /IM ZAICODE.exe /T" }, riskLevel: "high", mode: "build" },
    {},
  );
  assert.equal(selfKill.decision, "deny");
  const disallowed = new PermissionService({
    allowedTools: new Set(),
    disallowedTools: new Set(["Bash"]),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
  }).checkPermission(bash("build"), {});
  assert.equal(disallowed.decision, "deny");
});

test("ZAICODE_PERMISSION_PROMPTS=on gives upstream's prompts back", () => {
  process.env.ZAICODE_PERMISSION_PROMPTS = "on";
  assert.equal(zaicodeFullAccessEnabled(), false);
  const decision = new PermissionService().checkPermission(bash("build"), {
    destructive: true,
    riskLevel: "high",
  });
  assert.notEqual(decision.decision, "allow");
});
