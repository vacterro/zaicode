import assert from "node:assert/strict";
import test from "node:test";
import * as starter from "../src/main/zaicodeWindowStarter.js";

test("Claude starter fixes a provider output ceiling and disables thinking without changing other probes", () => {
  const env = (starter as typeof starter & { claudeWindowStartEnv?: () => Record<string, string> }).claudeWindowStartEnv;
  assert.equal(typeof env, "function");
  assert.equal(env!().CLAUDE_CODE_MAX_OUTPUT_TOKENS, "8");
  assert.equal(env!().MAX_THINKING_TOKENS, "0");
  const args = starter.claudeWindowStartArgs();
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "0.005");
});
test("Codex starts with a strict tiny schema and minimal instructions instead of the full coding prompt", () => {
  const args = (starter.codexWindowStartArgs as (schema?: string, instructions?: string) => string[])("C:/probe/ok.json", "C:/probe/instructions.txt");
  assert.equal(args[args.indexOf("--output-schema") + 1], "C:/probe/ok.json");
  assert.ok(args.includes('model_instructions_file="C:/probe/instructions.txt"'));
  assert.ok(args.includes("model_verbosity=low"));
});
test("Antigravity enforces a fixed response schema and bounds the print turn", () => {
  const args = starter.antigravityWindowStartArgs("five_hour@gemini_models", "gemini-3.8-flash-low")!;
  const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]!);
  assert.deepEqual(schema.properties.ok.enum, [true]);
  assert.equal(schema.additionalProperties, false);
  assert.ok(args.includes("--disable-slash-commands"));
  assert.equal(args[args.indexOf("--print-timeout") + 1], "30s");
});
