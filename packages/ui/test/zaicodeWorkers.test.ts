import assert from "node:assert/strict";
import test from "node:test";
import type { ZaicodeEngineAccount } from "@zcode/shared";
import { buildZaicodeWorkerCommand, projectNameOf, psQuote } from "../src/zaicode/zaicodeEngines.js";

const account = (patch: Partial<ZaicodeEngineAccount>): ZaicodeEngineAccount => ({
  id: "x",
  vendor: "claude",
  short: "A1",
  label: "Claude 1",
  source: "~/.claude",
  home: "C:\\Users\\me\\.claude",
  isDefaultHome: true,
  cli: "C:\\Users\\me\\.local\\bin\\claude.exe",
  status: "ready",
  statusDetail: "",
  fixCommand: null,
  ...patch,
});

test("claude default account clears CLAUDE_CONFIG_DIR, a second account sets it", () => {
  const first = buildZaicodeWorkerCommand(account({}), "V:\\Proj", { prompt: "saipen continue", yolo: true })!;
  assert.ok(first.startsWith("Set-Location -LiteralPath 'V:\\Proj'; Remove-Item Env:CLAUDE_CONFIG_DIR"), first);
  assert.ok(
    first.endsWith("& 'C:\\Users\\me\\.local\\bin\\claude.exe' --dangerously-skip-permissions 'saipen continue'; exit $LASTEXITCODE"),
    first,
  );
  const second = buildZaicodeWorkerCommand(
    account({ short: "A2", home: "C:\\Users\\me\\.claude-account2", isDefaultHome: false }),
    "V:\\Proj",
    { prompt: "", yolo: false },
  )!;
  assert.ok(second.includes("$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\me\\.claude-account2'"), second);
  assert.ok(!second.includes("dangerously"), second);
});

test("codex secondary homes drop inherited API keys; agy takes -i; zcode opens the TUI", () => {
  const codex = buildZaicodeWorkerCommand(
    account({
      vendor: "codex",
      short: "C2",
      home: "C:\\Users\\me\\.codex-account2",
      isDefaultHome: false,
      cli: "C:\\nodejs\\codex.cmd",
    }),
    "V:\\P",
    { prompt: "cc", yolo: true },
  )!;
  assert.ok(codex.includes("$env:CODEX_HOME = 'C:\\Users\\me\\.codex-account2'"), codex);
  assert.ok(codex.includes("Remove-Item Env:OPENAI_API_KEY"), codex);
  assert.ok(codex.includes("--dangerously-bypass-approvals-and-sandbox 'cc'"), codex);
  const agy = buildZaicodeWorkerCommand(account({ vendor: "antigravity", cli: "C:\\agy.exe", home: null }), "V:\\P", {
    prompt: "go",
    yolo: true,
  })!;
  assert.ok(agy.includes("& 'C:\\agy.exe' --dangerously-skip-permissions -i 'go'"), agy);
  const zc = buildZaicodeWorkerCommand(account({ vendor: "zcode", cli: "V:\\z\\zcode.cjs", home: null }), "V:\\P", {
    prompt: "ignored",
    yolo: true,
  })!;
  assert.ok(zc.includes("& node 'V:\\z\\zcode.cjs' tui --cwd 'V:\\P' --mode yolo"), zc);
});

test("quotes survive apostrophes; a missing CLI launches nothing", () => {
  assert.equal(psQuote("it's"), "'it''s'");
  assert.equal(buildZaicodeWorkerCommand(account({ cli: null }), "V:\\P", { prompt: "", yolo: true }), null);
  assert.equal(projectNameOf("V:\\a\\_FastPrompter\\"), "_FastPrompter");
  const multiline = buildZaicodeWorkerCommand(account({}), "V:\\P", { prompt: "first line\r\n  second line\n", yolo: false });
  assert.ok(multiline && !/[\r\n]/.test(multiline), "a typed command never carries a line break");
  assert.ok(multiline?.includes("'first line second line'"), multiline ?? "");
});
