import assert from "node:assert/strict";
import { test } from "node:test";
import { PermissionService } from "../src/permission/service.js";
import {
  ZAICODE_SELF_KILL_RULE_ID,
  isZaicodeSelfKillCommand,
  resolveZaicodeSelfProtection,
} from "../src/permission/zaicode-self-protection.js";

test("the 2026-09-25 command that killed ZAICODE and all eight sessions is refused", () => {
  const incident =
    'cd "V:\\___VAC\\__K\\__CODE\\_AI_STUFF_AGENTIC\\_ZAICODE" && taskkill //F //IM ZAICODE.exe //T 2>&1 | tail -5; sleep 3; powershell -NoProfile -Command "(Get-Process ZAICODE -ErrorAction SilentlyContinue | Measure-Object).Count" 2>&1 | tail -1';
  assert.equal(isZaicodeSelfKillCommand(incident), true);
});

test("every way of stopping ZAICODE by name, image or filter is refused", () => {
  for (const command of [
    "taskkill /F /IM ZAICODE.exe /T",
    'taskkill /F /IM "ZAICODE.exe"',
    "taskkill /IM zaicode*",
    'taskkill /F /FI "IMAGENAME eq ZAICODE.exe"',
    "Stop-Process -Name ZAICODE -Force",
    "Stop-Process -Name 'ZAICODE*'",
    "spps -ProcessName ZAICODE",
    "Get-Process ZAICODE | Stop-Process -Force",
    "Get-Process -Name ZAICODE -ErrorAction SilentlyContinue | ForEach-Object { $_.Kill() }",
    "Get-Process | Where-Object { $_.Path -like '*\\win-unpacked\\ZAICODE.exe' } | Stop-Process",
    "Get-CimInstance Win32_Process -Filter \"Name='ZAICODE.exe'\" | Invoke-CimMethod -MethodName Terminate",
    "wmic process where \"name='ZAICODE.exe'\" delete",
    "pkill -f ZAICODE",
    "killall ZAICODE.exe",
  ]) {
    assert.equal(isZaicodeSelfKillCommand(command), true, command);
  }
});

test("ordinary work that only mentions ZAICODE paths is not refused", () => {
  for (const command of [
    "Stop-Process -Id 4242 -Force",
    "taskkill /PID 4242 /T /F",
    'cd "V:\\___VAC\\_ZAICODE\\zcode" && pnpm typecheck',
    "grep -rn \"kill\" packages/ui/src/zaicode/",
    "Get-Process | Where-Object { $_.Path -like '*\\_ZAICODE\\.zaicode\\smoke*' } | Stop-Process",
    "Get-Content ZAICODE.ps1",
    "Get-Process ZAICODE | Select-Object Id, StartTime",
    "node scripts/bundle-zaicode.mjs",
  ]) {
    assert.equal(isZaicodeSelfKillCommand(command), false, command);
  }
});

test("only shell tools are inspected", () => {
  assert.equal(resolveZaicodeSelfProtection({ toolName: "Read", input: { command: "taskkill /IM ZAICODE.exe" } }), undefined);
  assert.equal(
    resolveZaicodeSelfProtection({ toolName: "Bash", input: { command: "taskkill /IM ZAICODE.exe" } })?.ruleId,
    ZAICODE_SELF_KILL_RULE_ID,
  );
});

test("yolo mode does not let the self-kill through", () => {
  const decision = new PermissionService().checkPermission({
    toolName: "Bash",
    input: { command: "taskkill //F //IM ZAICODE.exe //T" },
    riskLevel: "high",
    mode: "yolo",
  });
  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, ZAICODE_SELF_KILL_RULE_ID);
  const ordinary = new PermissionService().checkPermission({
    toolName: "Bash",
    input: { command: "Stop-Process -Id 4242" },
    riskLevel: "high",
    mode: "yolo",
  });
  assert.equal(ordinary.decision, "allow");
});
