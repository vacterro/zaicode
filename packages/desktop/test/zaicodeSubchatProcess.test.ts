import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildZaicodeSubchatInvocation, type ZaicodeEngineAccount, type ZaicodeSubchatEvent } from "@zcode/shared";
import { startZaicodeSubchatProcess } from "../src/main/zaicodeSubchatProcess.js";

// T-51 transport: a stand-in CLI prints the vendor's real stream shapes, so the
// whole path (argv, stdin prompt, cwd, env, line split, parse, result) runs
// without spending a subscription's quota.

const FAKE_CLI = String.raw`
const argv = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  if (input.includes("CRASH")) {
    process.stderr.write("warming up\nError: not logged in\n");
    process.exit(3);
  }
  if (input.includes("HANG")) {
    out({ type: "thread.started", thread_id: "hang-1" });
    setInterval(() => undefined, 1000);
    return;
  }
  const resumed = argv.includes("resume") ? argv[argv.indexOf("-") - 1] : null;
  out({ type: "thread.started", thread_id: resumed ?? "0199-new-thread" });
  out({ type: "item.started", item: { type: "command_execution", command: "cwd" } });
  // One event split across two writes: the reader must join it.
  const answer = JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify({ input, cwd: process.cwd(), home: process.env.CODEX_HOME ?? null, resumed }) },
  });
  process.stdout.write(answer.slice(0, 20));
  setTimeout(() => {
    process.stdout.write(answer.slice(20) + "\n");
    out({ type: "turn.completed", usage: { input_tokens: 7, cached_input_tokens: 3, output_tokens: 2 } });
  }, 30);
});
`;

const codex: ZaicodeEngineAccount = {
  id: "codex:home2",
  vendor: "codex",
  short: "C2",
  label: "Codex 2",
  source: "home2",
  home: "C:/fake/.codex-2",
  isDefaultHome: false,
  cli: "codex",
  status: "ready",
  statusDetail: "",
  fixCommand: null,
};

function withFakeCli(run: (script: string, cwd: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "zaicode-subchat-"));
    const script = join(dir, "fake-cli.js");
    writeFileSync(script, FAKE_CLI);
    try {
      await run(script, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function turn(script: string, cwd: string, prompt: string, sessionId: string | null) {
  const invocation = buildZaicodeSubchatInvocation(codex, { prompt, sessionId, yolo: false });
  assert.ok(invocation);
  const events: ZaicodeSubchatEvent[] = [];
  const process_ = startZaicodeSubchatProcess({
    file: process.execPath,
    args: [script, ...invocation.args],
    cwd,
    env: { ...process.env, ...(invocation.env as Record<string, string>) },
    stdin: invocation.stdin,
    vendor: "codex",
    short: "C2",
    onEvent: (event) => events.push(event),
  });
  return { events, process: process_ };
}

test(
  "a turn streams session, tool, answer, usage and one result; the prompt arrives intact on stdin",
  withFakeCli(async (script, cwd) => {
    const prompt = 'Line one\n"quotes" & <tags> | pipes %PATH% ünicode';
    const { events, process: run } = await turn(script, cwd, prompt, null);
    await run.done;
    assert.deepEqual(
      events.map((event) => event.type),
      ["session", "tool", "text", "usage", "result"],
    );
    assert.deepEqual(events[0], { type: "session", sessionId: "0199-new-thread", model: null });
    const echoed = JSON.parse((events[2] as { text: string }).text) as { input: string; cwd: string; home: string; resumed: null };
    assert.equal(echoed.input, prompt);
    assert.equal(echoed.home, "C:/fake/.codex-2", "the account's own CODEX_HOME");
    assert.equal(echoed.resumed, null);
    assert.deepEqual(events.at(-1), { type: "result", ok: true, message: null });
  }),
);

test(
  "the next turn resumes the vendor session it was given",
  withFakeCli(async (script, cwd) => {
    const { events, process: run } = await turn(script, cwd, "again", "0199-new-thread");
    await run.done;
    const echoed = JSON.parse((events.find((event) => event.type === "text") as { text: string }).text) as { resumed: string };
    assert.equal(echoed.resumed, "0199-new-thread");
  }),
);

test(
  "a CLI that dies without a result reports its last stderr line, once",
  withFakeCli(async (script, cwd) => {
    const { events, process: run } = await turn(script, cwd, "CRASH please", null);
    await run.done;
    assert.deepEqual(events, [{ type: "result", ok: false, message: "Error: not logged in" }]);
  }),
);

test(
  "Stop ends a hanging turn as a note, not a failure",
  withFakeCli(async (script, cwd) => {
    const { events, process: run } = await turn(script, cwd, "HANG", null);
    while (!events.some((event) => event.type === "session")) await new Promise((resolve) => setTimeout(resolve, 20));
    run.stop();
    await run.done;
    assert.deepEqual(events.at(-1), { type: "result", ok: true, message: "Stopped." });
    assert.equal(events.filter((event) => event.type === "result").length, 1);
  }),
);

test("a missing executable fails the turn with a message instead of throwing", async () => {
  const events: ZaicodeSubchatEvent[] = [];
  const run = startZaicodeSubchatProcess({
    file: join(tmpdir(), "no-such-cli-zaicode.exe"),
    args: [],
    cwd: tmpdir(),
    env: process.env,
    stdin: "x",
    vendor: "claude",
    short: "A1",
    onEvent: (event) => events.push(event),
  });
  await run.done;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "result");
  assert.equal((events[0] as { ok: boolean }).ok, false);
});

// SRC-048: ZCode prints one pretty-printed JSON document when the turn ends, not a line stream.
const FAKE_ZCODE = String.raw`
const argv = process.argv.slice(2);
process.stdout.write("ZCode Built-in missing\n");
const document = {
  sessionId: argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : "sess_new-1",
  response: "prompt=" + argv[argv.indexOf("-p") + 1] + " mode=" + argv[argv.indexOf("--mode") + 1],
  usage: { inputTokens: 11, outputTokens: 4, cacheReadTokens: 2 },
};
const text = JSON.stringify(document, null, 2);
process.stdout.write(text.slice(0, 15));
setTimeout(() => process.stdout.write(text.slice(15) + "\n"), 30);
`;

test("a document vendor (ZCode) is read whole and parsed when the process ends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zaicode-subchat-zc-"));
  const script = join(dir, "fake-zcode.js");
  writeFileSync(script, FAKE_ZCODE);
  try {
    const zcode: ZaicodeEngineAccount = { ...codex, id: "zcode:plan", vendor: "zcode", short: "ZC", label: "ZCode", home: null, cli: script };
    const invocation = buildZaicodeSubchatInvocation(zcode, { prompt: "multi word prompt", sessionId: "sess_old-9", yolo: true });
    assert.ok(invocation);
    const events: ZaicodeSubchatEvent[] = [];
    const run = startZaicodeSubchatProcess({
      file: process.execPath,
      args: [script, ...invocation.args],
      cwd: dir,
      env: process.env,
      stdin: invocation.stdin,
      vendor: "zcode",
      short: "ZC",
      onEvent: (event) => events.push(event),
    });
    await run.done;
    assert.deepEqual(events, [
      { type: "session", sessionId: "sess_old-9", model: null },
      { type: "text", text: "prompt=multi word prompt mode=yolo" },
      { type: "usage", input: 11, output: 4, cached: 2 },
      { type: "result", ok: true, message: null },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
