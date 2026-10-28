import assert from "node:assert/strict";
import test from "node:test";
import { ZAICODE_AGENT_ROLES } from "@zcode/shared";
import { getZaicodeBuiltInAgentTemplate } from "../../services/src/zaicode/zaicodeTemplates.js";

test("ZAICODE_AGENT_ROLES contains subsaipen roles", () => {
  const roles = new Set(ZAICODE_AGENT_ROLES);
  assert.ok(roles.has("hunter"), "missing hunter role");
  assert.ok(roles.has("tester"), "missing tester role");
  assert.ok(roles.has("cleaner"), "missing cleaner role");
  assert.ok(roles.has("wikier"), "missing wikier role");
  assert.ok(roles.has("translator"), "missing translator role");
});

test("built-in templates exist for subsaipen modes", () => {
  const hunter = getZaicodeBuiltInAgentTemplate("zaicode-template:hunter");
  assert.ok(hunter, "hunter template missing");
  assert.equal(hunter.role, "hunter");
  assert.equal(hunter.toolPolicy.permissionMode, "yolo");

  const tester = getZaicodeBuiltInAgentTemplate("zaicode-template:tester");
  assert.ok(tester, "tester template missing");
  assert.equal(tester.role, "tester");

  const cleaner = getZaicodeBuiltInAgentTemplate("zaicode-template:cleaner");
  assert.ok(cleaner, "cleaner template missing");
  assert.equal(cleaner.role, "cleaner");

  const wikier = getZaicodeBuiltInAgentTemplate("zaicode-template:wikier");
  assert.ok(wikier, "wikier template missing");
  assert.equal(wikier.role, "wikier");

  const translator = getZaicodeBuiltInAgentTemplate("zaicode-template:translator");
  assert.ok(translator, "translator template missing");
  assert.equal(translator.role, "translator");
});
