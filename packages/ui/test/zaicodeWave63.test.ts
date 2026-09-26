import assert from "node:assert/strict";
import test from "node:test";
import {
  buildZaicodeSubchatInvocation,
  createZaicodeAutostartJob,
  evaluateZaicodeAutostartJob,
  formatZaicodeWindowReset,
  isZaicodeRealReset,
  markZaicodeWindowsStartingOnUse,
  parseZaicodeAntigravityStreamLine,
  parseZaicodeSubchatDocument,
  applyZaicodeSubchatEvent,
  ZAICODE_SUBCHAT_ARG_PROMPT_MAX,
  zaicodeSubchatPromptFilePointer,
  type ZaicodeEngineAccount,
  type ZaicodeLimitSnapshot,
  type ZaicodeLimitWindow,
  type ZaicodeSubchatConversation,
} from "@zcode/shared";
import {
  ZAICODE_HIGHLIGHT_DEFAULTS,
  ZAICODE_WORKING_COMBO_TRANSFORM,
  ZAICODE_WORKING_ICON_DEFAULTS,
  normalizeZaicodeLights,
  zaicodeHighlightAttrs,
  zaicodeWorkingIconStyle,
} from "../src/zaicode/zaicodeHighlights.js";
import { ZAICODE_MOTION_CSS } from "../src/zaicode/zaicodeMotionCss.js";
import { zaicodeWorkingLayerStyle } from "../src/zaicode/zaicodeWorkingIconStyle.js";
import {
  ZAICODE_LAYER_DEFAULTS,
  normalizeZaicodeBezier,
  zaicodeBezierAt,
  zaicodeEasingCss,
} from "../src/zaicode/zaicodeMotionTuning.js";
import {
  ZAICODE_BUILT_IN_LIGHTS_PRESETS,
  exportZaicodeLightsPresets,
  normalizeZaicodeLightsPresets,
  parseZaicodeLightsPresets,
  uniqueZaicodePresetName,
} from "../src/zaicode/zaicodeLightsPresets.js";
import { zaicodeNextUsefulReset, zaicodeResetRows } from "../src/zaicode/ZaicodeResetTimer.js";
import { ZAICODE_BEVEL_CSS } from "../src/zaicode/zaicodeBevels.js";
import { ZAICODE_PROFILE_KEYS } from "../src/zaicode/zaicodeProfileBundles.js";
import { zaicodeDevicePx } from "../src/zaicode/zaicodePixelSnap.js";
import {
  setZaicodeLiveRun,
  useZaicodeLiveRuns,
  zaicodeLiveRunFolderKey,
  zaicodeLiveRunIdsIn,
} from "../src/zaicode/zaicodeLiveRuns.js";
import { groupZaicodeSubchats } from "../src/zaicode/subchat/zaicodeSubchatGroups.js";

type Style = Record<string, unknown>;

// --- item 9: the Working icon moves symmetrically everywhere ------------------------------

test("working icon: no perspective anywhere, so a flip is a flat squash about the centre", () => {
  assert.doesNotMatch(ZAICODE_WORKING_COMBO_TRANSFORM, /perspective/);
  assert.doesNotMatch(ZAICODE_MOTION_CSS.replace(/\/\*[\s\S]*?\*\//g, ""), /perspective\(/, "only the comment still names it");
  assert.match(ZAICODE_MOTION_CSS, /@keyframes zw-flip \{ from \{ transform: rotateY\(0deg\); \} to \{ transform: rotateY\(360deg\); \} \}/);
  assert.match(ZAICODE_MOTION_CSS, /\[data-zaicode-working-icon\], \[data-zaicode-working-layer\] \{\s*transform-origin: 50% 50%;/);
});

test("working icon: wobble shakes as far left as right, bounce as far up as down", () => {
  const wobble = /@keyframes zw-wobble \{([^\n]*)\}\n/.exec(ZAICODE_MOTION_CSS)?.[1] ?? "";
  const factors = [...wobble.matchAll(/\* (-?[\d.]+)\)/g)].map((match) => Number(match[1]));
  assert.equal(factors.length, 4);
  assert.equal(factors.reduce((sum, value) => sum + value, 0), 0, "left and right cancel out");
  assert.equal(Math.max(...factors), -Math.min(...factors));
  const bounce = /@keyframes zw-bounce \{([^\n]*)\}\n/.exec(ZAICODE_MOTION_CSS)?.[1] ?? "";
  assert.match(bounce, /translateY\(calc\(var\(--zw-px\) \* 0\.5\)\)/);
  assert.match(bounce, /translateY\(calc\(var\(--zw-px\) \* -0\.5\)\)/);
});

// --- item 8: more control -- own easings, separate settings per part of a mix ----------------

test("easing: presets, own cubic-bezier (clamped), elastic / bounce as sampled linear()", () => {
  assert.equal(zaicodeEasingCss("smooth", [0, 0, 1, 1], 8), "ease-in-out");
  assert.equal(zaicodeEasingCss("back", [0, 0, 1, 1], 8), "cubic-bezier(0.34, 1.56, 0.64, 1)");
  assert.equal(zaicodeEasingCss("steps", [0, 0, 1, 1], 5), "steps(5, end)");
  assert.equal(zaicodeEasingCss("custom", [0.2, -3, 1.4, 0.9], 8), "cubic-bezier(0.2, -1, 1, 0.9)");
  assert.match(zaicodeEasingCss("elastic", [0, 0, 1, 1], 8), /^linear\(0, .*1\)$/);
  assert.match(zaicodeEasingCss("bounce", [0, 0, 1, 1], 8), /^linear\(0, .*1\)$/);
  assert.deepEqual(normalizeZaicodeBezier("junk"), [0.3, 0, 0.2, 1]);
  assert.ok(Math.abs(zaicodeBezierAt([0, 0, 1, 1], 0.5) - 0.5) < 0.01, "a straight curve is linear");
  assert.ok(zaicodeBezierAt([0.34, 1.56, 0.64, 1], 0.6) > 1, "overshoot goes past the end");
});

test("working icon mix: every motion keeps its own speed, easing, direction, reach and phase", () => {
  const style = zaicodeWorkingIconStyle({
    ...ZAICODE_WORKING_ICON_DEFAULTS,
    motions: ["spin", "pulse"],
    seconds: 2.4,
    amplitude: 50,
    tuning: { pulse: { seconds: 1, easing: "back", curve: null, direction: "alternate", amplitude: 20, phase: 50 } },
  }) as Style;
  assert.equal(
    style["--zw-anim"],
    "zwc-spin 2.4s linear infinite normal, zwc-pulse 1s cubic-bezier(0.34, 1.56, 0.64, 1) -0.5s infinite alternate",
  );
  assert.equal(style["--zw-scale"], "1.12", "pulse reads its own reach (20 %)");
  assert.equal(style["--zw-deg"], "90deg", "swing keeps the common reach (50 %)");
});

test("working icon layers: own opacity, size, blend, offset and extra motion; junk normalized away", () => {
  const layer = { ...ZAICODE_LAYER_DEFAULTS, opacity: 60, size: 80, blend: "screen" as const, motion: "swing", seconds: 3, x: 10, y: -5 };
  const style = zaicodeWorkingLayerStyle(layer, ZAICODE_WORKING_ICON_DEFAULTS) as Style;
  assert.equal(style.filter, "opacity(0.6)", "a filter: the layer's own breathe / blink animates opacity");
  assert.equal(style.opacity, undefined);
  assert.equal(style.scale, "0.8");
  assert.equal(style.mixBlendMode, "screen");
  assert.equal(style.translate, "10% -5%");
  assert.equal(style["--zw-layer-anim"], "zw-swing 3s ease-in-out infinite normal");
  assert.deepEqual(zaicodeWorkingLayerStyle(undefined, ZAICODE_WORKING_ICON_DEFAULTS), {});
  const lights = normalizeZaicodeLights({
    working: {
      tuning: { pulse: { seconds: 999, easing: "wiggle", phase: 500 }, disco: { seconds: 1 }, spin: { phase: 0 } },
      layers: { orbit: { motion: "moonwalk", opacity: 0, blend: "burn" }, nope: { opacity: 50 } },
    },
  }).working;
  assert.deepEqual(lights.tuning, { pulse: { seconds: 20, easing: null, curve: null, direction: null, amplitude: null, phase: 100 } });
  assert.deepEqual(Object.keys(lights.layers), ["orbit"]);
  assert.equal(lights.layers.orbit?.motion, "none");
  assert.equal(lights.layers.orbit?.opacity, 10);
  assert.equal(lights.layers.orbit?.blend, "normal");
});

test("highlight mix: every effect its own speed / easing / phase / depth, every shape its own colour and strength", () => {
  const lights = zaicodeHighlightAttrs("sessionWorking", {
    ...ZAICODE_HIGHLIGHT_DEFAULTS.sessionWorking,
    enabled: true,
    effects: ["pulse", "flicker"],
    shapes: ["text", "glow"],
    seconds: 2.4,
    tuning: { flicker: { seconds: 5, easing: null, curve: null, depth: 50, phase: 20 } },
    shapeTuning: { glow: { color: "#ff0000", strength: 40 } },
  });
  const style = lights!.style as Style;
  assert.equal(style["--zh-anim"], "zh-pulse 2.4s ease-in-out infinite, zh-flicker 5s ease-in-out -1s infinite");
  assert.equal(style["--zh-d-flicker"], "0.5");
  assert.equal(style["--zh-d-pulse"], undefined, "an untuned effect keeps its own depth");
  assert.equal(style["--zh-c-glow"], "#ff0000");
  assert.equal(style["--zh-s-glow"], "0.4");
  assert.equal(style["--zh-c-text"], undefined);
  assert.match(ZAICODE_MOTION_CSS, /var\(--zh-c-glow, var\(--zh-color, #f0c040\)\)/);
  assert.match(ZAICODE_MOTION_CSS, /--zh-e-pulse: calc\(1 - var\(--zh-d-pulse, 0\.75\)\)/);
  const plain = zaicodeHighlightAttrs("sessionWorking", { ...ZAICODE_HIGHLIGHT_DEFAULTS.sessionWorking, enabled: true, effects: ["pulse"], seconds: 1.5 });
  assert.equal((plain!.style as Style)["--zh-anim"], "zh-pulse 1.5s ease-in-out infinite", "no tuning, same animation as before");
});

// --- item 5: presets with export / import ----------------------------------------------------

test("presets: export -> import round trip gives new own presets with free names", () => {
  const neon = ZAICODE_BUILT_IN_LIGHTS_PRESETS.find((preset) => preset.name === "Neon")!;
  const file = exportZaicodeLightsPresets([neon]);
  assert.match(file, /"kind": "zaicode-lights-presets"/);
  const imported = parseZaicodeLightsPresets(file, ["Neon"]);
  assert.ok("presets" in imported);
  assert.equal(imported.presets[0]?.name, "Neon 2");
  assert.equal(imported.presets[0]?.builtIn, false);
  assert.deepEqual(imported.presets[0]?.lights, neon.lights);
  const bare = parseZaicodeLightsPresets(JSON.stringify({ working: { motions: ["flip"] } }), []);
  assert.ok("presets" in bare);
  assert.deepEqual(bare.presets[0]?.lights.working.motions, ["flip"]);
  assert.ok("error" in parseZaicodeLightsPresets("{nope", []));
  assert.ok("error" in parseZaicodeLightsPresets(JSON.stringify({ something: 1 }), []));
  assert.equal(uniqueZaicodePresetName("Calm", ["Calm", "Calm 2"]), "Calm 3");
});

test("presets: stored own presets are normalized; built-in ids and junk never load as own", () => {
  const own = normalizeZaicodeLightsPresets([
    { id: "builtin:neon", name: "fake", lights: {} },
    { id: "a", name: "  Night  ", lights: { working: { seconds: 99 } } },
    { id: "a", name: "dup", lights: {} },
    { id: "b", name: "no set" },
    "junk",
  ]);
  assert.deepEqual(own.map((preset) => preset.id), ["a"]);
  assert.equal(own[0]?.name, "Night");
  assert.equal(own[0]?.lights.working.seconds, 20);
  assert.ok(ZAICODE_BUILT_IN_LIGHTS_PRESETS.length >= 5);
});

// --- item 4: a 5 h window nobody used is not a reset every five minutes ----------------------

const HOUR = 3_600_000;
const READ = Date.UTC(2026, 8, 26, 1, 46);

function win(patch: Partial<ZaicodeLimitWindow> & { key: string }): ZaicodeLimitWindow {
  return {
    label: patch.key === "five_hour" ? "5h" : "weekly",
    group: "",
    groupLabel: "",
    remainingPercent: 100,
    resetsAt: null,
    durationMinutes: patch.key === "five_hour" ? 300 : 10080,
    gatedBy: null,
    assumedFull: false,
    ...patch,
  };
}

test("resets: a reset one full window after the read is 'starts on first use'", () => {
  const marked = markZaicodeWindowsStartingOnUse(
    [
      win({ key: "five_hour", resetsAt: READ + 5 * HOUR - 40_000 }),
      win({ key: "five_hour", group: "b", resetsAt: READ + 2 * HOUR }),
      win({ key: "weekly", resetsAt: READ + 7 * 24 * HOUR }),
      win({ key: "weekly", group: "c", resetsAt: READ + 3 * 24 * HOUR }),
    ],
    READ,
  );
  assert.deepEqual(marked.map((window) => window.startsOnUse), [true, false, true, false]);
  assert.equal(formatZaicodeWindowReset(marked[0]!, READ + 60_000), "starts on first use (5h window)");
  assert.equal(formatZaicodeWindowReset({ ...marked[1]!, gatedBy: "weekly" }, READ), "blocked by weekly");
  assert.equal(isZaicodeRealReset(marked[0]!, READ), false);
  assert.equal(isZaicodeRealReset(marked[1]!, READ), true);
});

test("resets: the screenshot case -- idle Codex / Antigravity 5 h never lead the title; real resets do", () => {
  const now = READ + 4 * 60_000;
  const accounts = [
    { id: "codex:1", short: "C1", label: "Codex 1", vendor: "codex" },
    { id: "ag", short: "AG", label: "Antigravity", vendor: "antigravity" },
    { id: "claude:2", short: "A2", label: "Claude 2", vendor: "claude" },
  ] as const;
  const snapshot = (id: string, windows: ZaicodeLimitWindow[]): ZaicodeLimitSnapshot => ({
    accountId: id,
    windows: markZaicodeWindowsStartingOnUse(windows, READ),
    plan: null,
    fetchedAt: READ,
    checkedAt: READ,
    error: null,
    source: "",
  });
  const limits = {
    "codex:1": snapshot("codex:1", [
      win({ key: "five_hour", remainingPercent: 100, resetsAt: READ + 5 * HOUR }),
      win({ key: "weekly", remainingPercent: 0, resetsAt: READ + 93 * HOUR }),
    ]),
    ag: snapshot("ag", [win({ key: "five_hour", remainingPercent: 100, resetsAt: READ + 5 * HOUR })]),
    "claude:2": snapshot("claude:2", [win({ key: "weekly", remainingPercent: 7, resetsAt: READ + 81 * HOUR })]),
  };
  const rows = zaicodeResetRows(accounts, limits, now);
  const next = zaicodeNextUsefulReset(rows);
  assert.equal(next?.accountShort, "A2", "the 5 h windows of C1 and AG are not the next reset");
  const codexSession = rows.find((row) => row.accountShort === "C1" && row.window === "Session");
  assert.equal(codexSession?.kind, "gated", "spent weekly blocks it");
  assert.equal(rows.find((row) => row.accountShort === "AG")?.kind, "idle");
  assert.deepEqual(
    rows.map((row) => row.kind),
    rows.map((row) => row.kind).sort((a, b) => ["reset", "gated", "idle"].indexOf(a) - ["reset", "gated", "idle"].indexOf(b)),
    "real resets first, then gated, then idle",
  );
});

test("resets: a scheduled 'after the 5 h refill' job does not chase a window that has not started", () => {
  const job = createZaicodeAutostartJob({ id: "j", projectPath: "P", engineId: "codex:1", trigger: "reset", window: "five_hour" }, READ);
  const snapshot: ZaicodeLimitSnapshot = {
    accountId: "codex:1",
    windows: markZaicodeWindowsStartingOnUse([win({ key: "five_hour", resetsAt: READ + 5 * HOUR })], READ),
    plan: null,
    fetchedAt: READ,
    checkedAt: READ,
    error: null,
    source: "",
  };
  const decision = evaluateZaicodeAutostartJob(job, snapshot, READ + 60_000);
  assert.equal(decision.state, "waiting-reset");
  assert.match(decision.reason, /starts on first use/);
});

// --- item 2: every subscription in SUBCHAT, chats grouped like projects ------------------------

function account(patch: Partial<ZaicodeEngineAccount>): ZaicodeEngineAccount {
  return {
    id: "antigravity:default",
    vendor: "antigravity",
    short: "AG",
    label: "Antigravity",
    source: "gemini:antigravity",
    home: null,
    isDefaultHome: true,
    cli: "C:/Users/me/AppData/Local/agy/bin/agy.exe",
    status: "ready",
    statusDetail: "",
    fixCommand: null,
    ...patch,
  };
}

test("Antigravity turn: agy -p <prompt> stream-json, --conversation resumes, a long prompt goes via a file", () => {
  const first = buildZaicodeSubchatInvocation(account({}), { prompt: "hi", sessionId: null, yolo: true });
  assert.deepEqual(first?.args, ["-p", "hi", "--output-format", "stream-json", "--dangerously-skip-permissions"]);
  assert.equal(first?.stdin, "");
  const next = buildZaicodeSubchatInvocation(account({}), {
    prompt: "more",
    sessionId: "fb2778b5-f2b6-45a1-986d-895c0d758b13",
    yolo: false,
    model: "claude-sonnet-4-6",
  });
  assert.deepEqual(next?.args.slice(4), [
    "--conversation",
    "fb2778b5-f2b6-45a1-986d-895c0d758b13",
    "--mode",
    "accept-edits",
    "--model",
    "claude-sonnet-4-6",
  ]);
  const long = buildZaicodeSubchatInvocation(account({}), {
    prompt: "x".repeat(ZAICODE_SUBCHAT_ARG_PROMPT_MAX + 1),
    sessionId: null,
    yolo: true,
    promptFile: "C:/tmp/prompt.md",
  });
  assert.equal(long?.args[1], zaicodeSubchatPromptFilePointer("C:/tmp/prompt.md"));
  assert.ok((long?.args[1]?.length ?? 0) < 400);
});

test("ZCode turn: zcode -p <prompt> --json, yolo / edit mode, --resume", () => {
  const zc = account({ id: "zcode:plan", vendor: "zcode", short: "ZC", label: "ZCode", cli: "C:/z/zcode.cjs" });
  assert.deepEqual(buildZaicodeSubchatInvocation(zc, { prompt: "go", sessionId: null, yolo: true })?.args, ["-p", "go", "--json", "--mode", "yolo"]);
  assert.deepEqual(buildZaicodeSubchatInvocation(zc, { prompt: "go", sessionId: "sess_595f67cf-ddd1-43a0-86d7-593292018969", yolo: false })?.args, [
    "-p",
    "go",
    "--json",
    "--mode",
    "edit",
    "--resume",
    "sess_595f67cf-ddd1-43a0-86d7-593292018969",
  ]);
});

// Lines captured from a real `agy -p ... --output-format stream-json` turn (2026-09-26), paths shortened.
const AGY_LINES = [
  '{"event":"init","conversation_id":"fb2778b5-f2b6-45a1-986d-895c0d758b13","init":{"model":"claude-sonnet-4-6","cwd":"V:\\\\probe","tools":["run_command"],"permission_mode":"request-review"}}',
  '{"event":"step_update","step_update":{"conversation_id":"fb2778b5-f2b6-45a1-986d-895c0d758b13","step_index":0,"state":"DONE","step_type":"user_input"}}',
  '{"event":"step_update","step_update":{"conversation_id":"fb2778b5-f2b6-45a1-986d-895c0d758b13","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"Get-ChildItem \\"V:\\\\probe\\""}}}}',
  '{"event":"step_update","step_update":{"conversation_id":"fb2778b5-f2b6-45a1-986d-895c0d758b13","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.49,"tool_info":{"name":"run_command","parameters":{"CommandLine":"Get-ChildItem"},"output":"..."}}}',
  '{"event":"step_update","step_update":{"conversation_id":"fb2778b5-f2b6-45a1-986d-895c0d758b13","step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}',
  '{"event":"step_update","step_update":{"conversation_id":"fb2778b5-f2b6-45a1-986d-895c0d758b13","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":1.4,"usage":{"input_tokens":1275,"output_tokens":4}}}',
  '{"event":"result","result":{"conversation_id":"fb2778b5-f2b6-45a1-986d-895c0d758b13","status":"SUCCESS","response":"OK\\n","duration_seconds":8.7,"num_turns":1,"usage":{"input_tokens":20190,"output_tokens":303,"thinking_tokens":0,"cache_read_tokens":18435,"total_tokens":20493}}}',
];

test("Antigravity stream: session, tool once, streamed text joins one answer, usage and success", () => {
  const events = AGY_LINES.flatMap((line) => parseZaicodeAntigravityStreamLine(line));
  assert.deepEqual(events[0], { type: "session", sessionId: "fb2778b5-f2b6-45a1-986d-895c0d758b13", model: "claude-sonnet-4-6" });
  assert.deepEqual(events[1], { type: "tool", name: "run_command", detail: 'Get-ChildItem "V:\\probe"' });
  assert.deepEqual(events.filter((event) => event.type === "tool").length, 1, "a DONE step does not repeat the tool");
  assert.deepEqual(events.at(-2), { type: "usage", input: 38625, output: 303, cached: 18435 });
  assert.deepEqual(events.at(-1), { type: "result", ok: true, message: null });
  let chat: ZaicodeSubchatConversation = {
    id: "c",
    accountId: "antigravity:default",
    vendor: "antigravity",
    short: "AG",
    label: "Antigravity",
    projectPath: "V:/p",
    sessionId: null,
    model: null,
    title: "t",
    createdAt: 1,
    updatedAt: 1,
    status: "running",
    usage: { input: 0, output: 0, cached: 0 },
    messages: [],
  };
  events.forEach((event, index) => {
    chat = applyZaicodeSubchatEvent(chat, event, 10 + index, `m${index}`);
  });
  assert.deepEqual(
    chat.messages.map((message) => [message.role, message.text]),
    [
      ["tool", 'run_command: Get-ChildItem "V:\\probe"'],
      ["assistant", "OK\n"],
    ],
  );
  assert.equal(chat.sessionId, "fb2778b5-f2b6-45a1-986d-895c0d758b13");
  assert.equal(chat.status, "idle");
});

test("Antigravity stream: a spent quota ends the turn as an error with the vendor's words", () => {
  const events = parseZaicodeAntigravityStreamLine(
    '{"event":"result","result":{"conversation_id":"4c88","status":"ERROR","response":"","error":"API error (attempt 6): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 100h3m51s.","usage":{"input_tokens":0,"output_tokens":0}}}',
  );
  assert.equal(events.at(-1)?.type, "result");
  assert.equal((events.at(-1) as { ok: boolean }).ok, false);
  assert.match((events.at(-1) as { message: string }).message, /Resets in 100h3m51s/);
});

test("ZCode document: the one JSON at the end becomes session, answer, usage and result", () => {
  const output = `ZCode Built-in missing\n${JSON.stringify(
    {
      sessionId: "sess_595f67cf-ddd1-43a0-86d7-593292018969",
      response: "OK",
      usage: { inputTokens: 40965, outputTokens: 250, cacheReadTokens: 1043 },
      projection: { status: "idle" },
    },
    null,
    2,
  )}\n`;
  assert.deepEqual(parseZaicodeSubchatDocument("zcode", output), [
    { type: "session", sessionId: "sess_595f67cf-ddd1-43a0-86d7-593292018969", model: null },
    { type: "text", text: "OK" },
    { type: "usage", input: 40965, output: 250, cached: 1043 },
    { type: "result", ok: true, message: null },
  ]);
  assert.deepEqual(parseZaicodeSubchatDocument("zcode", "no json here"), []);
});

test("SUBCHAT list: chats grouped per project folder (case-blind), newest group first, busy ones counted", () => {
  const chat = (id: string, projectPath: string, updatedAt: number) => ({ id, projectPath, updatedAt }) as ZaicodeSubchatConversation;
  const groups = groupZaicodeSubchats(
    [chat("a", "V:\\Proj\\One", 5), chat("b", "v:/proj/one", 9), chat("c", "V:\\Two", 7)],
    (id) => id === "b",
  );
  assert.deepEqual(groups.map((group) => [group.conversations.map((c) => c.id), group.running]), [
    [["a", "b"], 1],
    [["c"], 0],
  ]);
});

// --- item 1: the sidebar sees what the open chat sees ------------------------------------------

test("live runs: the open chat's running session counts for its project folder until it stops", () => {
  assert.equal(zaicodeLiveRunFolderKey("V:/X/_FastPrompter/"), "v:\\x\\_fastprompter");
  setZaicodeLiveRun("sess_1", "V:\\X\\_FastPrompter", true);
  setZaicodeLiveRun("sess_2", "V:\\Other", true);
  const runs = useZaicodeLiveRuns.getState().runs;
  assert.deepEqual(zaicodeLiveRunIdsIn(runs, "v:/x/_fastprompter"), ["sess_1"]);
  setZaicodeLiveRun("sess_1", "V:\\X\\_FastPrompter", false);
  assert.deepEqual(zaicodeLiveRunIdsIn(useZaicodeLiveRuns.getState().runs, "V:\\X\\_FastPrompter"), []);
  setZaicodeLiveRun("sess_2", "V:\\Other", false);
});

// --- item 6: no half-pixel pop-ups -------------------------------------------------------------

test("pixel snap: pop-up positions land on whole device pixels", () => {
  assert.equal(zaicodeDevicePx(100.5, 1), 101);
  assert.equal(zaicodeDevicePx(100.3, 1.25), 100);
  assert.equal(zaicodeDevicePx(100.5, 1.25), 100.8);
  assert.equal(zaicodeDevicePx(33.33, 1.5), 33.333333333333336);
});

// --- item 3: hard bevels -------------------------------------------------------------------------

test("hard bevels: raised controls, sunken fields and pressed states, strong enough to beat pixel mode", () => {
  assert.match(ZAICODE_BEVEL_CSS, /html\.zaicode-bevels button,/);
  assert.match(ZAICODE_BEVEL_CSS, /html\.zaicode-bevels textarea,/);
  assert.match(ZAICODE_BEVEL_CSS, /html\.zaicode-bevels button:active,/);
  assert.match(ZAICODE_BEVEL_CSS, /html\.zaicode-bevels\.zaicode-bevel-rows li\[data-testid\^="task-item-"\]\.bg-selected/);
  assert.match(ZAICODE_BEVEL_CSS, /box-shadow: inset -1px -1px 0 0 var\(--zaicode-bevel-dark, #100e08\).*!important/);
  assert.ok(ZAICODE_PROFILE_KEYS.includes("zaicode-bevels") && ZAICODE_PROFILE_KEYS.includes("zaicode-bevel-rows"));
  // The bevel replaces the upstream focus ring (a box-shadow): keyboard focus is a dotted outline instead.
  assert.match(ZAICODE_BEVEL_CSS, /html\.zaicode-bevels button:focus-visible,[\s\S]*?outline: 1px dotted/);
});
