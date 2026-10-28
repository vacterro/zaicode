import assert from "node:assert/strict";
import { test } from "node:test";
import { antigravityWindowStartArgs } from "../src/main/zaicodeWindowStarter.js";

const inventory = "Fetching available models...\ngemini-3.7-flash-low\tGemini Flash\ngemini-3.8-flash-low\tGemini Flash\ngemini-3.1-pro-high\tGemini Pro\nclaude-sonnet-5-5-low\tSonnet\ngpt-oss-120b-medium\tGPT OSS\n";

test("an idle Gemini pool uses an advertised low-effort Flash instead of a removed pinned model", () => {
  const args = antigravityWindowStartArgs("five_hour@gemini_models", inventory);
  assert.ok(args);
  assert.equal(args[args.indexOf("--model") + 1], "gemini-3.8-flash-low");
  assert.ok(args.includes("--sandbox"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
});

test("the independent Claude/GPT pool must not spend a Gemini request", () => {
  const args = antigravityWindowStartArgs("five_hour@claude_and_gpt_models", inventory);
  assert.ok(args);
  assert.equal(args[args.indexOf("--model") + 1], "gpt-oss-120b-medium");
});

test("unknown pools and missing advertised models are unsupported rather than invented", () => {
  assert.equal(antigravityWindowStartArgs("five_hour@unknown", inventory), null);
  assert.equal(antigravityWindowStartArgs("five_hour@gemini_models", ""), null);
  assert.equal(antigravityWindowStartArgs("five_hour@claude_and_gpt_models", "gemini-3.8-flash-low\tFlash"), null);
});

test("the starter's effort agrees with the CLI's advertised model variant", () => {
  const args = antigravityWindowStartArgs("five_hour@claude_and_gpt_models", inventory);
  assert.ok(args);
  assert.equal(args[args.indexOf("--effort") + 1], "medium", "GPT OSS is advertised only as medium; the vendor rejects a conflicting low flag");
});
