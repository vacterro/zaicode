/**
 * Agent-action cues (Wave 3, part C).
 *
 * A cue names WHAT HAPPENED, never what was typed: the mapping reads the
 * tool's identity and the session's state, so a model that writes in Estonian
 * or Japanese gets the same cue as one that writes in English. Call sites emit
 * an event id and a context object; nothing here hard-codes a filename or an
 * effect.
 *
 * The gate matters as much as the mapping. An agent reading 500 small files
 * must not produce 500 clicks, but its failures, its completions and its
 * request for a human must never be swallowed: those bypass the limiter.
 */

/** The event ids this system can emit. They join the normal sound table. */
export const ZAICODE_ACTION_CUE_IDS = [
  "agent.reasoning.start",
  "agent.reasoning.end",
  "agent.read",
  "agent.search",
  "agent.edit",
  "agent.create",
  "agent.shell",
  "agent.tool",
  "agent.plan",
  "agent.response.start",
  "agent.response.end",
  "agent.attention",
  "agent.retry",
  "agent.failure",
  "agent.cancel",
] as const;

export type ZaicodeActionCueId = (typeof ZAICODE_ACTION_CUE_IDS)[number];

/** Cues that always get through: a completion or a problem is never noise. */
export const ZAICODE_ALWAYS_CUE_IDS: readonly ZaicodeActionCueId[] = [
  "agent.response.end",
  "agent.failure",
  "agent.cancel",
  "agent.attention",
];

/** Tool identity -> cue. Names come from the tool, never from the text around it. */
const TOOL_CUES: readonly { test: (tool: string, family: string) => boolean; cue: ZaicodeActionCueId }[] = [
  { test: (tool, family) => family === "file-read" || /^(Read|View|NotebookRead)$/i.test(tool), cue: "agent.read" },
  { test: (tool, family) => family === "search" || /^(Grep|Glob|WebFetch|WebSearch|LS|List)$/i.test(tool), cue: "agent.search" },
  { test: (tool, family) => family === "shell" || /^(Bash|Shell|PowerShell|Terminal)$/i.test(tool), cue: "agent.shell" },
  { test: (tool, family) => family === "plan-guidance" || /^(TodoWrite|TodoRead|UpdatePlan|ExitPlanMode)$/i.test(tool), cue: "agent.plan" },
  { test: (_tool, family) => family === "file-write", cue: "agent.edit" },
];

export interface ZaicodeToolCallIdentity {
  /** The tool's own name, e.g. `Read`, `Bash`. */
  name: string;
  /** The presentation family the renderer resolved to, e.g. `file-read`. */
  family?: string;
  /**
   * True when the write CREATED a file rather than changing an existing one.
   * It comes from the tool's structured result, never from its output text.
   */
  createdFile?: boolean;
}

export function zaicodeActionCueForToolCall(call: ZaicodeToolCallIdentity): ZaicodeActionCueId {
  const name = call.name ?? "";
  const family = call.family ?? "";
  for (const entry of TOOL_CUES) {
    if (entry.test(name, family)) {
      if (entry.cue === "agent.edit" && call.createdFile) return "agent.create";
      return entry.cue;
    }
  }
  return "agent.tool";
}

export interface ZaicodeReasoningState {
  streaming: boolean;
}

export function zaicodeActionCueForReasoning(state: ZaicodeReasoningState): ZaicodeActionCueId {
  return state.streaming ? "agent.reasoning.start" : "agent.reasoning.end";
}

/** Session phase -> the cue that matches, or null when nothing changed. */
export function zaicodeActionCueForSessionStatus(status: string, previous?: string): ZaicodeActionCueId | null {
  if (status === previous) return null;
  if (status === "permission_request" || status === "elicitation_request") return "agent.attention";
  if (status === "failed") return "agent.failure";
  if (status === "completed") return "agent.response.end";
  if (status === "feedback_update") return "agent.plan";
  return "agent.response.start";
}

export interface ZaicodeCueGateOptions {
  /** How long one event id stays quiet after it fires. */
  perEventWindowMs: number;
  /** Ceiling on noisy cues inside `burstWindowMs`, so 500 reads are not 500 sounds. */
  burstWindowMs: number;
  maxNoisyPerWindow: number;
  /** Cues that ignore every window above. */
  always?: readonly ZaicodeActionCueId[];
}

export const ZAICODE_DEFAULT_CUE_GATE: ZaicodeCueGateOptions = {
  perEventWindowMs: 1_200,
  burstWindowMs: 4_000,
  maxNoisyPerWindow: 3,
  always: ZAICODE_ALWAYS_CUE_IDS,
};

export interface ZaicodeCueGateMemory {
  lastAt: Record<string, number>;
  noisy: number[];
}

export function createZaicodeCueGateMemory(): ZaicodeCueGateMemory {
  return { lastAt: {}, noisy: [] };
}

/**
 * Whether a cue may sound now. Always-cues pass; a noisy cue needs its own
 * window free AND budget left in the burst. Pure: the caller owns the clock,
 * so a test can walk a whole agent turn in milliseconds.
 */
export function admitZaicodeActionCue(
  cue: ZaicodeActionCueId,
  now: number,
  memory: ZaicodeCueGateMemory,
  options: ZaicodeCueGateOptions = ZAICODE_DEFAULT_CUE_GATE,
): boolean {
  const always = options.always ?? ZAICODE_ALWAYS_CUE_IDS;
  const last = memory.lastAt[cue];
  memory.lastAt[cue] = now;
  if (always.includes(cue)) return true;
  if (last !== undefined && now - last < options.perEventWindowMs) return false;
  memory.noisy = memory.noisy.filter((at) => now - at < options.burstWindowMs);
  if (memory.noisy.length >= options.maxNoisyPerWindow) return false;
  memory.noisy.push(now);
  return true;
}

export interface ZaicodeActionCueDef {
  id: ZaicodeActionCueId;
  label: string;
  hint: string;
  glyph: string;
  sound: string;
  enabled: boolean;
  gainDb: number;
}

/**
 * The rows the sound table gains. Grouped with the other Agent rows so they
 * appear in the same place as the existing agent cues -- this is an extension
 * of the catalog, not a second catalog.
 */
export const ZAICODE_ACTION_CUE_DEFS: readonly ZaicodeActionCueDef[] = [
  { id: "agent.reasoning.start", label: "Thinking starts", hint: "The model began a reasoning block. The 'thought for' time is derived from this state.", glyph: "brain", sound: "default", enabled: false, gainDb: -6 },
  { id: "agent.reasoning.end", label: "Thinking ends", hint: "A reasoning block finished", glyph: "check", sound: "default", enabled: false, gainDb: -6 },
  { id: "agent.read", label: "Reads a file", hint: "The agent opened or read a file", glyph: "doc", sound: "default", enabled: false, gainDb: -8 },
  { id: "agent.search", label: "Searches", hint: "Grep, glob, a web search or a directory listing", glyph: "search", sound: "default", enabled: false, gainDb: -8 },
  { id: "agent.edit", label: "Edits a file", hint: "The agent changed a file that already existed", glyph: "pencil", sound: "default", enabled: false, gainDb: -6 },
  { id: "agent.create", label: "Creates a file", hint: "A file that did not exist before", glyph: "plus", sound: "default", enabled: true, gainDb: 0 },
  { id: "agent.shell", label: "Runs a command", hint: "Shell, terminal or PowerShell", glyph: "terminal", sound: "default", enabled: false, gainDb: -8 },
  { id: "agent.tool", label: "Any other tool", hint: "A tool with no more specific cue", glyph: "dot", sound: "default", enabled: false, gainDb: -10 },
  { id: "agent.plan", label: "Plan or todo update", hint: "The agent wrote or changed its plan", glyph: "list", sound: "default", enabled: false, gainDb: -6 },
  { id: "agent.response.start", label: "Reply starts", hint: "The first token of an answer", glyph: "arrow", sound: "default", enabled: false, gainDb: -8 },
  { id: "agent.response.end", label: "Reply ends", hint: "The answer finished", glyph: "check", sound: "default", enabled: true, gainDb: 0 },
  { id: "agent.attention", label: "Wants you", hint: "The agent asked something or needs permission", glyph: "hand", sound: "default", enabled: true, gainDb: 0 },
  { id: "agent.retry", label: "Retries", hint: "The runtime is retrying after an error", glyph: "rotate", sound: "default", enabled: false, gainDb: -6 },
  { id: "agent.failure", label: "Fails", hint: "The turn ended with an error", glyph: "cross", sound: "default", enabled: false, gainDb: 0 },
  { id: "agent.cancel", label: "Cancelled", hint: "You or the runtime stopped the turn", glyph: "stop", sound: "default", enabled: false, gainDb: -6 },
];

/** The catalog rows, in the shape the sound table already stores. */
export function zaicodeActionCueEvents(): { id: string; group: "Agent"; label: string; hint: string; glyph: string; sound: string; enabled: boolean; gainDb: number }[] {
  return ZAICODE_ACTION_CUE_DEFS.map((cue) => ({ ...cue, group: "Agent" as const }));
}
