// ../../packages/local/dist/ledger.js
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
function optimaizrDir() {
  return process.env.OPTIMAIZR_DIR ?? path.join(os.homedir(), ".optimaizr");
}
function ledgerPath() {
  return path.join(optimaizrDir(), "events.jsonl");
}
var queue = [];
var flushing = false;
var flushTimer = null;
function flushSync() {
  if (queue.length === 0)
    return;
  const batch = queue.join("");
  queue = [];
  try {
    fs.mkdirSync(optimaizrDir(), { recursive: true });
    fs.appendFileSync(ledgerPath(), batch);
  } catch {
  }
}
async function flush() {
  if (flushing || queue.length === 0)
    return;
  flushing = true;
  const batch = queue.join("");
  queue = [];
  try {
    await fs.promises.mkdir(optimaizrDir(), { recursive: true });
    await fs.promises.appendFile(ledgerPath(), batch);
  } catch {
  } finally {
    flushing = false;
    if (queue.length > 0)
      void flush();
  }
}
var exitHooked = false;
function hookExit() {
  if (exitHooked)
    return;
  exitHooked = true;
  process.once("exit", flushSync);
  process.once("beforeExit", flushSync);
}
function append(event) {
  try {
    queue.push(`${JSON.stringify(event)}
`);
    hookExit();
    if (queue.length >= 32) {
      void flush();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flush();
      }, 1e3);
      if (typeof flushTimer.unref === "function")
        flushTimer.unref();
    }
  } catch {
  }
}
async function drain() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flush();
}
async function readLedger(opts = {}) {
  const file = ledgerPath();
  const warnings = [];
  if (!fs.existsSync(file)) {
    return {
      events: [],
      window: { from: "", to: "", days: 0 },
      sources: [],
      warnings: []
    };
  }
  const cutoff = opts.days ? Date.now() - opts.days * 864e5 : null;
  const events = [];
  let bad = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  for await (const line2 of rl) {
    if (!line2.trim())
      continue;
    try {
      const e = JSON.parse(line2);
      if (cutoff && new Date(e.ts).getTime() < cutoff)
        continue;
      if (opts.project && !e.project?.includes(opts.project))
        continue;
      if (opts.route && e.route !== opts.route)
        continue;
      events.push(e);
    } catch {
      bad++;
    }
  }
  if (bad)
    warnings.push(`ledger: skipped ${bad} unparseable line(s)`);
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  const from = events[0]?.ts ?? "";
  const to = events[events.length - 1]?.ts ?? "";
  const days = from && to ? Math.max(1, (new Date(to).getTime() - new Date(from).getTime()) / 864e5) : 0;
  return { events, window: { from, to, days }, sources: [file], warnings };
}

// ../../packages/local/dist/samples.js
import fs2 from "node:fs";
import path2 from "node:path";
import crypto2 from "node:crypto";
import readline2 from "node:readline";

// ../../packages/local/dist/providers/shapes.js
import crypto from "node:crypto";
function hash(input) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 12);
}
function fingerprint(systemText, toolSig, toolCount) {
  return {
    systemChars: systemText.length,
    toolDefCount: toolCount,
    prefixHash: hash(`${toolSig} ${systemText}`)
  };
}
function textOf(value) {
  if (typeof value === "string")
    return value;
  if (!Array.isArray(value))
    return "";
  return value.map((b) => typeof b?.text === "string" ? b.text : "").join("");
}
var anthropicMessages = {
  name: "anthropic.messages",
  idOf: (r) => r?.id,
  modelOf: (p, r) => r?.model ?? p?.model ?? "",
  usageOf: (r) => r?.usage,
  stopOf: (r) => r?.stop_reason ?? null,
  toolsOf(result) {
    const content = result?.content;
    if (!Array.isArray(content))
      return [];
    const out = [];
    for (const b of content) {
      if (b?.type !== "tool_use")
        continue;
      out.push({
        id: b.id ?? `${out.length}`,
        name: b.name ?? "unknown",
        signature: `${b.name ?? "unknown"}:${JSON.stringify(b.input ?? {}).slice(0, 200)}`
      });
    }
    return out;
  },
  requestOf(params) {
    const systemText = textOf(params?.system);
    const tools = Array.isArray(params?.tools) ? params.tools : [];
    const toolSig = tools.map((t) => `${t?.name ?? t?.type ?? ""}:${JSON.stringify(t?.input_schema ?? "")}`).join("|");
    return fingerprint(systemText, toolSig, tools.length);
  },
  answerOf: (r) => r?.content,
  captureFieldsOf: (p) => ({
    model: p?.model,
    system: p?.system,
    messages: p?.messages,
    tools: p?.tools,
    max_tokens: p?.max_tokens,
    temperature: p?.temperature,
    output_config: p?.output_config
  }),
  effortOf: (p) => p?.output_config?.effort ?? null,
  speedOf: (p, r) => p?.speed ?? r?.usage?.speed ?? null,
  tierOf: (_p, r) => r?.usage?.service_tier ?? null,
  accumulator() {
    const message = { usage: {}, content: [] };
    return {
      message,
      observe(chunk) {
        try {
          if (chunk?.type === "message_start" && chunk.message) {
            message.id = chunk.message.id;
            message.model = chunk.message.model;
            Object.assign(message.usage, chunk.message.usage ?? {});
          } else if (chunk?.type === "message_delta") {
            Object.assign(message.usage, chunk.usage ?? {});
            if (chunk.delta?.stop_reason)
              message.stop_reason = chunk.delta.stop_reason;
          } else if (chunk?.type === "content_block_start" && chunk.content_block) {
            message.content.push(chunk.content_block);
          }
        } catch {
        }
      }
    };
  }
};
var PREFIX_ROLES = /* @__PURE__ */ new Set(["system", "developer"]);
var openaiChat = {
  name: "openai.chat.completions",
  idOf: (r) => r?.id,
  modelOf: (p, r) => r?.model ?? p?.model ?? "",
  usageOf: (r) => r?.usage,
  stopOf: (r) => r?.choices?.[0]?.finish_reason ?? null,
  toolsOf(result) {
    const calls = result?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(calls))
      return [];
    return calls.map((c2, i) => {
      const name = c2?.function?.name ?? c2?.name ?? "unknown";
      const args = c2?.function?.arguments ?? "";
      return {
        id: c2?.id ?? `${i}`,
        name,
        signature: `${name}:${(typeof args === "string" ? args : JSON.stringify(args)).slice(0, 200)}`
      };
    });
  },
  requestOf(params) {
    const messages = Array.isArray(params?.messages) ? params.messages : [];
    const systemText = messages.filter((m) => PREFIX_ROLES.has(m?.role)).map((m) => textOf(m?.content)).join("");
    const tools = Array.isArray(params?.tools) ? params.tools : [];
    const toolSig = tools.map((t) => `${t?.function?.name ?? t?.name ?? t?.type ?? ""}:${JSON.stringify(t?.function?.parameters ?? t?.parameters ?? "")}`).join("|");
    return fingerprint(systemText, toolSig, tools.length);
  },
  answerOf: (r) => r?.choices,
  captureFieldsOf: (p) => ({
    model: p?.model,
    messages: p?.messages,
    tools: p?.tools,
    tool_choice: p?.tool_choice,
    max_completion_tokens: p?.max_completion_tokens,
    max_tokens: p?.max_tokens,
    temperature: p?.temperature,
    reasoning_effort: p?.reasoning_effort,
    response_format: p?.response_format
  }),
  effortOf: (p) => p?.reasoning_effort ?? null,
  speedOf: () => null,
  tierOf: (p, r) => r?.service_tier ?? p?.service_tier ?? null,
  accumulator() {
    const message = { usage: {}, choices: [{ message: { tool_calls: [] } }] };
    return {
      message,
      observe(chunk) {
        try {
          if (chunk?.id)
            message.id = chunk.id;
          if (chunk?.model)
            message.model = chunk.model;
          if (chunk?.usage)
            Object.assign(message.usage, chunk.usage);
          const choice = chunk?.choices?.[0];
          if (choice?.finish_reason)
            message.choices[0].finish_reason = choice.finish_reason;
          for (const call of choice?.delta?.tool_calls ?? []) {
            const i = call?.index ?? 0;
            const slot = message.choices[0].message.tool_calls[i] ??= {
              id: call?.id,
              function: { name: "", arguments: "" }
            };
            if (call?.id)
              slot.id = call.id;
            if (call?.function?.name)
              slot.function.name += call.function.name;
            if (call?.function?.arguments)
              slot.function.arguments += call.function.arguments;
          }
        } catch {
        }
      }
    };
  }
};
var openaiResponses = {
  name: "openai.responses",
  idOf: (r) => r?.id,
  modelOf: (p, r) => r?.model ?? p?.model ?? "",
  usageOf: (r) => r?.usage,
  stopOf: (r) => r?.incomplete_details?.reason ?? r?.status ?? null,
  toolsOf(result) {
    const output = result?.output;
    if (!Array.isArray(output))
      return [];
    const out = [];
    for (const item of output) {
      if (item?.type !== "function_call")
        continue;
      const name = item.name ?? "unknown";
      out.push({
        id: item.call_id ?? item.id ?? `${out.length}`,
        name,
        signature: `${name}:${String(item.arguments ?? "").slice(0, 200)}`
      });
    }
    return out;
  },
  requestOf(params) {
    const systemText = textOf(params?.instructions);
    const tools = Array.isArray(params?.tools) ? params.tools : [];
    const toolSig = tools.map((t) => `${t?.name ?? t?.type ?? ""}:${JSON.stringify(t?.parameters ?? "")}`).join("|");
    return fingerprint(systemText, toolSig, tools.length);
  },
  answerOf: (r) => r?.output,
  captureFieldsOf: (p) => ({
    model: p?.model,
    instructions: p?.instructions,
    input: p?.input,
    tools: p?.tools,
    tool_choice: p?.tool_choice,
    max_output_tokens: p?.max_output_tokens,
    temperature: p?.temperature,
    reasoning: p?.reasoning,
    text: p?.text
  }),
  effortOf: (p) => p?.reasoning?.effort ?? null,
  speedOf: () => null,
  tierOf: (p, r) => r?.service_tier ?? p?.service_tier ?? null,
  accumulator() {
    const message = { usage: {}, output: [] };
    return {
      message,
      observe(chunk) {
        try {
          const done = chunk?.response;
          if (done && (chunk.type === "response.completed" || chunk.type === "response.incomplete")) {
            message.id = done.id ?? message.id;
            message.model = done.model ?? message.model;
            message.status = done.status ?? message.status;
            message.incomplete_details = done.incomplete_details;
            message.output = Array.isArray(done.output) ? done.output : message.output;
            Object.assign(message.usage, done.usage ?? {});
          } else if (chunk?.type === "response.created" && chunk.response) {
            message.id = chunk.response.id;
            message.model = chunk.response.model;
          }
        } catch {
        }
      }
    };
  }
};
var googleGenerateContent = {
  name: "google.generateContent",
  idOf: (r) => r?.responseId,
  modelOf: (p, r) => p?.model ?? r?.modelVersion ?? "",
  usageOf: (r) => r?.usageMetadata,
  stopOf: (r) => r?.candidates?.[0]?.finishReason ?? null,
  toolsOf(result) {
    const parts = result?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts))
      return [];
    const out = [];
    for (const part of parts) {
      const call = part?.functionCall;
      if (!call)
        continue;
      const name = call.name ?? "unknown";
      out.push({
        id: call.id ?? `${out.length}`,
        name,
        signature: `${name}:${JSON.stringify(call.args ?? {}).slice(0, 200)}`
      });
    }
    return out;
  },
  requestOf(params) {
    const cfg = params?.config ?? {};
    const systemText = textOf(cfg.systemInstruction ?? params?.systemInstruction);
    const groups = Array.isArray(cfg.tools) ? cfg.tools : [];
    const declared = groups.flatMap((g) => Array.isArray(g?.functionDeclarations) ? g.functionDeclarations : []);
    const toolSig = declared.map((t) => `${t?.name ?? ""}:${JSON.stringify(t?.parameters ?? "")}`).join("|");
    return fingerprint(systemText, toolSig, declared.length);
  },
  answerOf: (r) => r?.candidates?.[0]?.content,
  captureFieldsOf: (p) => ({
    model: p?.model,
    contents: p?.contents,
    systemInstruction: p?.config?.systemInstruction,
    tools: p?.config?.tools,
    maxOutputTokens: p?.config?.maxOutputTokens,
    temperature: p?.config?.temperature,
    thinkingConfig: p?.config?.thinkingConfig
  }),
  effortOf: (p) => {
    const budget = p?.config?.thinkingConfig?.thinkingBudget;
    return budget === void 0 || budget === null ? null : String(budget);
  },
  speedOf: () => null,
  tierOf: () => null,
  accumulator() {
    const message = { usageMetadata: {}, candidates: [{ content: { parts: [] } }] };
    return {
      message,
      observe(chunk) {
        try {
          if (chunk?.responseId)
            message.responseId = chunk.responseId;
          if (chunk?.modelVersion)
            message.modelVersion = chunk.modelVersion;
          if (chunk?.usageMetadata)
            Object.assign(message.usageMetadata, chunk.usageMetadata);
          const candidate = chunk?.candidates?.[0];
          if (candidate?.finishReason)
            message.candidates[0].finishReason = candidate.finishReason;
          const parts = candidate?.content?.parts;
          if (Array.isArray(parts))
            message.candidates[0].content.parts.push(...parts);
        } catch {
        }
      }
    };
  }
};

// ../../packages/local/dist/samples.js
var DEFAULT_PATTERNS = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]"],
  [/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[api-key]"],
  [/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer [token]"],
  [/\b\d{12,}\b/g, "[number]"],
  [/\b(?:\d[ -]*?){13,19}\b/g, "[card]"]
];
function defaultRedact(text) {
  let out = text;
  for (const [re, replacement] of DEFAULT_PATTERNS)
    out = out.replace(re, replacement);
  return out;
}
function deepRedact(value, redact) {
  if (typeof value === "string")
    return redact(value);
  if (Array.isArray(value))
    return value.map((v) => deepRedact(v, redact));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value))
      out[k] = deepRedact(v, redact);
    return out;
  }
  return value;
}
function samplesPath() {
  return path2.join(optimaizrDir(), "samples.jsonl");
}
var counts = /* @__PURE__ */ new Map();
function maybeCapture(params, response, opts, route, shape = anthropicMessages) {
  try {
    const rate = opts.rate ?? 0;
    if (rate <= 0 || Math.random() >= rate)
      return;
    const key = route ?? "default";
    const max = opts.maxPerRoute ?? 200;
    const n = counts.get(key) ?? 0;
    if (n >= max)
      return;
    counts.set(key, n + 1);
    const redact = opts.redact ?? defaultRedact;
    const sample = {
      id: response?.id ?? crypto2.randomUUID(),
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      route,
      model: response?.model ?? params?.model ?? "",
      request: deepRedact(shape.captureFieldsOf(params), redact),
      response: {
        content: deepRedact(shape.answerOf(response), redact),
        stop_reason: shape.stopOf(response),
        usage: shape.usageOf(response)
      }
    };
    fs2.mkdirSync(optimaizrDir(), { recursive: true });
    fs2.appendFileSync(samplesPath(), `${JSON.stringify(sample)}
`);
  } catch {
  }
}
async function readSamples(filter) {
  const file = samplesPath();
  if (!fs2.existsSync(file))
    return [];
  const out = [];
  const rl = readline2.createInterface({
    input: fs2.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  for await (const line2 of rl) {
    if (!line2.trim())
      continue;
    try {
      const s = JSON.parse(line2);
      if (filter?.route && s.route !== filter.route)
        continue;
      out.push(s);
    } catch {
    }
  }
  return filter?.limit ? out.slice(-filter.limit) : out;
}

// ../../packages/local/dist/wrap.js
import crypto4 from "node:crypto";
import fs7 from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

// ../../packages/core/dist/domain/types.js
var TIER_RANK = { fix: 0, try: 1, test: 2 };

// ../../packages/core/dist/pricing.js
var SERVER_TOOLS = {
  anthropic: { webSearchPer1k: 10 }
};
var PROVIDERS = {
  anthropic: { read: 0.1, write5m: 1.25, write1h: 2, batch: 0.5 },
  // OpenAI caches automatically and bills nothing to write, so a write is just
  // input. Older models discount reads by less than 10x and set `cachedInputPerM`.
  openai: { read: 0.1, write5m: 1, write1h: 1, batch: 0.5, inputIncludesCacheReads: true },
  // Google's `promptTokenCount` includes cached tokens, like OpenAI's. Explicit
  // caching also bills storage per token-hour, which isn't tied to a request
  // and isn't counted; implicit caching (what agents hit) is modelled exactly.
  google: { read: 0.25, write5m: 1, write1h: 1, batch: 0.5, inputIncludesCacheReads: true }
};
var CACHE_MULTIPLIER = PROVIDERS.anthropic;
var BATCH_MULTIPLIER = PROVIDERS.anthropic.batch;
var anthropicCaps = ["tools", "vision", "batch", "caching", "structured-output"];
var openaiCaps = ["tools", "vision", "batch", "caching", "structured-output"];
var googleCaps = ["tools", "vision", "batch", "caching", "structured-output"];
function tiered(inputPerM, outputPerM, aboveTokens, longInputPerM, longOutputPerM, from = "2026-01-01") {
  return [
    {
      from,
      inputPerM,
      outputPerM,
      longContext: { aboveTokens, inputPerM: longInputPerM, outputPerM: longOutputPerM }
    }
  ];
}
function flat(inputPerM, outputPerM, from = "2026-01-01") {
  return [{ from, inputPerM, outputPerM }];
}
function withCache(inputPerM, outputPerM, cachedInputPerM, from) {
  return [{ from, inputPerM, outputPerM, cachedInputPerM }];
}
function gpt(inputPerM, cachedInputPerM, outputPerM, from, opts = {}) {
  const cacheWritePerM = opts.writes ? inputPerM * 1.25 : void 0;
  const card = { from, inputPerM, outputPerM, cachedInputPerM, cacheWritePerM };
  if (opts.long) {
    card.longContext = {
      aboveTokens: 272e3,
      inputPerM: inputPerM * 2,
      outputPerM: outputPerM * 1.5,
      cachedInputPerM: cachedInputPerM === void 0 ? void 0 : cachedInputPerM * 2,
      cacheWritePerM: cacheWritePerM === void 0 ? void 0 : cacheWritePerM * 2
    };
  }
  return [card];
}
var BUILTIN_MODELS = [
  {
    id: "claude-fable-5-1",
    label: "Fable 5.1",
    provider: "anthropic",
    tier: "frontier",
    // Cache reads are $0.25/M, not a tenth of input. Agent traffic is mostly
    // cache reads, so the default would overbill Fable 5.1 by up to 4x.
    rates: withCache(10, 50, 0.25, "2026-09-22"),
    contextTokens: 1e6,
    maxOutputTokens: 128e3,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Hardest reasoning and long-horizon agentic runs. Thinking is always on."
  },
  {
    id: "claude-mythos-5-1",
    label: "Mythos 5.1",
    provider: "anthropic",
    tier: "frontier",
    // Mythos 5.1's cache-read rate wasn't published at launch; Fable 5.1's is
    // assumed. If it's the default $1.00 instead, this understates.
    rates: withCache(10, 50, 0.25, "2026-09-22"),
    contextTokens: 1e6,
    maxOutputTokens: 128e3,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Same capability as Fable 5.1, for approved organisations."
  },
  {
    id: "claude-fable-5",
    label: "Fable 5",
    provider: "anthropic",
    tier: "frontier",
    rates: flat(10, 50, "2026-06-24"),
    contextTokens: 1e6,
    maxOutputTokens: 128e3,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Previous Fable generation, at the same price as Fable 5.1."
  },
  {
    id: "claude-mythos-5",
    label: "Mythos 5",
    provider: "anthropic",
    tier: "frontier",
    rates: flat(10, 50, "2026-06-24"),
    contextTokens: 1e6,
    maxOutputTokens: 128e3,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Same capability as Fable 5, for approved organisations."
  },
  {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    provider: "anthropic",
    tier: "frontier",
    // Cache reads are $0.20/M: a twentieth of input, not a tenth.
    rates: withCache(4, 20, 0.2, "2026-09-22"),
    contextTokens: 1e6,
    maxOutputTokens: 128e3,
    capabilities: [...anthropicCaps, "reasoning"],
    fast: { inputPerM: 8, outputPerM: 40 },
    bestFor: "Complex multi-step work, refactors, architecture, judging other models. Thinking is always on."
  },
  {
    id: "claude-opus-5",
    label: "Opus 5",
    provider: "anthropic",
    tier: "frontier",
    rates: flat(5, 25, "2026-06-24"),
    contextTokens: 1e6,
    maxOutputTokens: 128e3,
    capabilities: [...anthropicCaps, "reasoning"],
    fast: { inputPerM: 10, outputPerM: 50 },
    bestFor: "Previous Opus generation; Opus 5.5 does the same work for 20% less."
  },
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    provider: "anthropic",
    tier: "frontier",
    rates: flat(5, 25),
    contextTokens: 1e6,
    maxOutputTokens: 128e3,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Previous frontier generation; still strong on agentic coding."
  },
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    provider: "anthropic",
    tier: "frontier",
    rates: flat(5, 25),
    contextTokens: 1e6,
    maxOutputTokens: 128e3,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Older frontier generation."
  },
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    provider: "anthropic",
    tier: "frontier",
    rates: flat(5, 25),
    contextTokens: 1e6,
    maxOutputTokens: 128e3,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Older frontier generation."
  },
  {
    id: "claude-sonnet-5-5",
    label: "Sonnet 5.5",
    provider: "anthropic",
    tier: "balanced",
    rates: flat(2, 10, "2026-09-25"),
    contextTokens: 1e6,
    maxOutputTokens: 128e3,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "The default workhorse: most coding, editing and tool-driven turns."
  },
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    provider: "anthropic",
    tier: "balanced",
    // $2/$10 was announced as introductory with a rise to $3/$15 on 2026-09-01,
    // which Anthropic cancelled. One card, not two (see pricing.test.mjs).
    rates: flat(2, 10, "2026-02-05"),
    contextTokens: 1e6,
    maxOutputTokens: 128e3,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Previous Sonnet generation, at the same price as Sonnet 5.5."
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    provider: "anthropic",
    tier: "balanced",
    rates: flat(3, 15),
    contextTokens: 1e6,
    maxOutputTokens: 64e3,
    capabilities: [...anthropicCaps, "reasoning"],
    bestFor: "Previous balanced generation."
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    provider: "anthropic",
    tier: "fast",
    rates: flat(1, 5, "2025-10-01"),
    contextTokens: 2e5,
    maxOutputTokens: 64e3,
    capabilities: anthropicCaps,
    bestFor: "Mechanical, well-specified work: classification, extraction, formatting, log triage, cheap sub-agents."
  },
  /* ---------------------------------------------------------------- OpenAI */
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    provider: "openai",
    tier: "frontier",
    rates: gpt(10, 1, 50, "2026-03-05", { writes: true, long: true }),
    contextTokens: 105e4,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "OpenAI's flagship: hardest reasoning, long agentic runs, judging other models."
  },
  {
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    provider: "openai",
    tier: "balanced",
    rates: gpt(2, 0.2, 10, "2026-03-05", { writes: true, long: true }),
    contextTokens: 105e4,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "The GPT-6 workhorse: complex coding and agentic workflows."
  },
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    provider: "openai",
    tier: "fast",
    rates: gpt(0.1, 0.01, 0.5, "2026-03-05", { writes: true, long: true }),
    contextTokens: 105e4,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Focused, high-volume work: classification, extraction, cheap sub-agents."
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    provider: "openai",
    tier: "frontier",
    rates: gpt(4, 0.4, 20, "2026-01-01", { writes: true, long: true }),
    contextTokens: 105e4,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Previous-generation flagship, below GPT-6 Astra's price."
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    provider: "openai",
    tier: "balanced",
    rates: gpt(2, 0.2, 12, "2026-01-01", { writes: true, long: true }),
    contextTokens: 105e4,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Previous-generation workhorse, superseded by GPT-6 Sol at a lower output rate."
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    provider: "openai",
    tier: "fast",
    rates: gpt(0.2, 0.02, 1.2, "2026-01-01", { writes: true, long: true }),
    contextTokens: 105e4,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Previous-generation cheap tier, superseded by GPT-6 Luna."
  },
  {
    id: "gpt-5.5-pro",
    label: "GPT-5.5 pro",
    provider: "openai",
    tier: "frontier",
    rates: gpt(30, void 0, 180, "2026-04-23", { long: true }),
    contextTokens: 105e4,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Maximum-effort answers where cost is secondary. No prompt caching."
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    provider: "openai",
    tier: "frontier",
    rates: gpt(5, 0.5, 30, "2026-04-23", { long: true }),
    contextTokens: 105e4,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Previous frontier generation."
  },
  {
    id: "gpt-5.4-pro",
    label: "GPT-5.4 pro",
    provider: "openai",
    tier: "frontier",
    rates: gpt(30, void 0, 180, "2026-03-05", { long: true }),
    contextTokens: 105e4,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Older maximum-effort tier. No prompt caching."
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
    provider: "openai",
    tier: "balanced",
    rates: gpt(0.75, 0.075, 4.5, "2026-03-05"),
    contextTokens: 4e5,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Older mid tier."
  },
  {
    id: "gpt-5.4-nano",
    label: "GPT-5.4 nano",
    provider: "openai",
    tier: "fast",
    rates: gpt(0.2, 0.02, 1.25, "2026-03-05"),
    contextTokens: 4e5,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Older cheap tier."
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    provider: "openai",
    tier: "frontier",
    rates: gpt(2.5, 0.25, 15, "2026-03-05", { long: true }),
    contextTokens: 105e4,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Older frontier generation."
  },
  {
    id: "gpt-5.2-pro",
    label: "GPT-5.2 pro",
    provider: "openai",
    tier: "frontier",
    rates: gpt(21, void 0, 168, "2025-12-11"),
    contextTokens: 4e5,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Older maximum-effort tier. No prompt caching."
  },
  {
    id: "gpt-5.2",
    label: "GPT-5.2",
    provider: "openai",
    tier: "frontier",
    rates: gpt(1.75, 0.175, 14, "2025-12-11"),
    contextTokens: 4e5,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Older frontier generation."
  },
  {
    id: "gpt-5.1",
    label: "GPT-5.1",
    provider: "openai",
    tier: "frontier",
    rates: gpt(1.25, 0.125, 10, "2025-11-13"),
    contextTokens: 4e5,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Older frontier generation."
  },
  {
    id: "gpt-5-pro",
    label: "GPT-5 pro",
    provider: "openai",
    tier: "frontier",
    rates: gpt(15, void 0, 120, "2025-10-06"),
    contextTokens: 4e5,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Older maximum-effort tier. No prompt caching."
  },
  {
    id: "gpt-5",
    label: "GPT-5",
    provider: "openai",
    tier: "frontier",
    rates: withCache(1.25, 10, 0.125, "2025-08-07"),
    contextTokens: 4e5,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Hardest reasoning, long agentic runs, and judging other models."
  },
  {
    id: "gpt-5-mini",
    label: "GPT-5 mini",
    provider: "openai",
    tier: "balanced",
    rates: withCache(0.25, 2, 0.025, "2025-08-07"),
    contextTokens: 4e5,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "The workhorse of the GPT-5 family: most coding, editing and tool-driven turns."
  },
  {
    id: "gpt-5-nano",
    label: "GPT-5 nano",
    provider: "openai",
    tier: "fast",
    rates: withCache(0.05, 0.4, 5e-3, "2025-08-07"),
    contextTokens: 4e5,
    maxOutputTokens: 128e3,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Mechanical, well-specified work: classification, extraction, formatting, cheap sub-agents."
  },
  {
    id: "o3",
    label: "o3",
    provider: "openai",
    tier: "frontier",
    rates: withCache(2, 8, 0.5, "2025-06-10"),
    contextTokens: 2e5,
    maxOutputTokens: 1e5,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Deliberate step-by-step reasoning on maths, science and hard debugging."
  },
  {
    id: "o4-mini",
    label: "o4-mini",
    provider: "openai",
    tier: "balanced",
    rates: withCache(1.1, 4.4, 0.275, "2025-04-16"),
    contextTokens: 2e5,
    maxOutputTokens: 1e5,
    capabilities: [...openaiCaps, "reasoning"],
    bestFor: "Cheaper reasoning where o3's depth is more than the task needs."
  },
  {
    id: "gpt-4.1",
    label: "GPT-4.1",
    provider: "openai",
    tier: "balanced",
    rates: withCache(2, 8, 0.5, "2025-04-14"),
    contextTokens: 1047576,
    maxOutputTokens: 32768,
    capabilities: openaiCaps,
    bestFor: "Long-context work that does not need reasoning: large documents, wide edits."
  },
  {
    id: "gpt-4.1-mini",
    label: "GPT-4.1 mini",
    provider: "openai",
    tier: "fast",
    rates: withCache(0.4, 1.6, 0.1, "2025-04-14"),
    contextTokens: 1047576,
    maxOutputTokens: 32768,
    capabilities: openaiCaps,
    bestFor: "Long-context work that does not need frontier judgement."
  },
  {
    id: "gpt-4.1-nano",
    label: "GPT-4.1 nano",
    provider: "openai",
    tier: "fast",
    rates: withCache(0.1, 0.4, 0.025, "2025-04-14"),
    contextTokens: 1047576,
    maxOutputTokens: 32768,
    capabilities: openaiCaps,
    bestFor: "High-volume classification and extraction at the lowest rate on offer."
  },
  {
    id: "gpt-4o",
    label: "GPT-4o",
    provider: "openai",
    tier: "balanced",
    // 4o discounts cache reads 2x, not 10x, hence the explicit cached rate.
    rates: withCache(2.5, 10, 1.25, "2024-08-06"),
    contextTokens: 128e3,
    maxOutputTokens: 16384,
    capabilities: openaiCaps,
    bestFor: "Previous generation; still common in production traffic."
  },
  {
    id: "gpt-4o-mini",
    label: "GPT-4o mini",
    provider: "openai",
    tier: "fast",
    rates: withCache(0.15, 0.6, 0.075, "2024-07-18"),
    contextTokens: 128e3,
    maxOutputTokens: 16384,
    capabilities: openaiCaps,
    bestFor: "Previous-generation cheap tier, superseded by GPT-5 nano."
  }
];
var GEMINI_MODELS = [
  {
    id: "gemini-3-pro",
    label: "Gemini 3 Pro",
    provider: "google",
    tier: "frontier",
    rates: tiered(2, 12, 2e5, 4, 18, "2025-11-18"),
    contextTokens: 1e6,
    maxOutputTokens: 64e3,
    capabilities: [...googleCaps, "reasoning"],
    bestFor: "Hardest reasoning and very long context. Thinking is always on."
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    provider: "google",
    tier: "frontier",
    rates: tiered(1.25, 10, 2e5, 2.5, 15, "2025-06-17"),
    contextTokens: 1e6,
    maxOutputTokens: 64e3,
    capabilities: [...googleCaps, "reasoning"],
    bestFor: "Long-context analysis and multi-step work below Gemini 3 Pro's price."
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    provider: "google",
    tier: "balanced",
    rates: flat(0.3, 2.5, "2025-06-17"),
    contextTokens: 1e6,
    maxOutputTokens: 64e3,
    capabilities: [...googleCaps, "reasoning"],
    bestFor: "The default workhorse: fast, cheap, and still able to think."
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    provider: "google",
    tier: "fast",
    rates: flat(0.1, 0.4, "2025-07-22"),
    contextTokens: 1e6,
    maxOutputTokens: 64e3,
    capabilities: googleCaps,
    bestFor: "Classification, extraction and other mechanical steps at the lowest rate."
  }
];
var catalogue = [...BUILTIN_MODELS];
var byId = new Map(catalogue.map((m) => [m.id, m]));
var MODELS = catalogue;
function allModels() {
  return catalogue;
}
function priceFor(modelId) {
  if (!modelId)
    return null;
  const id = modelId.trim().replace(/^(us|eu|apac)\./, "").replace(/^(anthropic|openai|azure)[./]/, "");
  const exact = byId.get(id);
  if (exact)
    return exact;
  let best = null;
  for (const m of catalogue) {
    if (id.startsWith(m.id) && (!best || m.id.length > best.id.length))
      best = m;
  }
  return best;
}
function providerOf(modelId) {
  return priceFor(modelId)?.provider ?? "unknown";
}
function modelLabel(modelId) {
  if (!modelId)
    return "unknown";
  return priceFor(modelId)?.label ?? modelId;
}
function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
function normalizeUsage(usage, modelId) {
  const u = usage ?? {};
  const cacheRead = num(u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? u.cachedContentTokenCount);
  const includedWrites = num(u.input_tokens_details?.cache_write_tokens);
  let input = num(u.input_tokens ?? u.prompt_tokens ?? u.promptTokenCount);
  const policy = PROVIDERS[providerOf(modelId)];
  if (policy?.inputIncludesCacheReads)
    input = Math.max(0, input - cacheRead - includedWrites);
  const thinking = num(u.output_tokens_details?.thinking_tokens ?? u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? u.thoughtsTokenCount);
  const output = u.output_tokens !== void 0 || u.completion_tokens !== void 0 ? num(u.output_tokens ?? u.completion_tokens) : num(u.candidatesTokenCount) + thinking;
  const write1h = num(u.cache_creation?.ephemeral_1h_input_tokens);
  const writeReported5m = num(u.cache_creation?.ephemeral_5m_input_tokens);
  const writeTotal = num(u.cache_creation_input_tokens) || write1h + writeReported5m || includedWrites;
  return {
    inputTokens: input,
    outputTokens: output,
    thinkingTokens: thinking,
    cacheReadTokens: cacheRead,
    // Only the aggregate reported: bill at the cheaper short-TTL rate, which
    // understates rather than inflates.
    cacheWrite5mTokens: Math.max(0, writeTotal - write1h),
    cacheWrite1hTokens: write1h,
    webSearches: num(u.server_tool_use?.web_search_requests)
  };
}
var ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  serverTools: 0,
  total: 0,
  unpriced: true
};
function cardFor(price, at) {
  const when = at ? new Date(at) : /* @__PURE__ */ new Date();
  const time = when.getTime();
  if (!Number.isNaN(time)) {
    for (const card of price.rates) {
      const from = (/* @__PURE__ */ new Date(`${card.from}T00:00:00.000Z`)).getTime();
      const until = card.until ? (/* @__PURE__ */ new Date(`${card.until}T23:59:59.999Z`)).getTime() : Infinity;
      if (time >= from && time <= until)
        return card;
    }
  }
  return price.rates[price.rates.length - 1];
}
function ratesFor(price, opts = {}) {
  const card = cardFor(price, opts.at);
  const policy = PROVIDERS[price.provider] ?? PROVIDERS.anthropic;
  let inputPerM = card.inputPerM;
  let outputPerM = card.outputPerM;
  let cardCachedPerM = card.cachedInputPerM;
  let cardWritePerM = card.cacheWritePerM;
  const band = card.longContext;
  if (band && (opts.promptTokens ?? 0) > band.aboveTokens) {
    inputPerM = band.inputPerM;
    outputPerM = band.outputPerM;
    cardCachedPerM = band.cachedInputPerM ?? void 0;
    cardWritePerM = band.cacheWritePerM ?? void 0;
  }
  if (opts.speed === "fast" && price.fast) {
    const premium = price.fast.inputPerM / inputPerM;
    if (cardCachedPerM !== void 0)
      cardCachedPerM *= premium;
    if (cardWritePerM !== void 0)
      cardWritePerM *= premium;
    inputPerM = price.fast.inputPerM;
    outputPerM = price.fast.outputPerM;
  }
  let cachedInputPerM = cardCachedPerM ?? inputPerM * policy.read;
  let cacheWrite5mPerM = cardWritePerM ?? inputPerM * policy.write5m;
  let cacheWrite1hPerM = cardWritePerM ?? inputPerM * policy.write1h;
  if (opts.batch) {
    const d = policy.batch;
    inputPerM *= d;
    outputPerM *= d;
    cachedInputPerM *= d;
    cacheWrite5mPerM *= d;
    cacheWrite1hPerM *= d;
  }
  return { inputPerM, outputPerM, cachedInputPerM, cacheWrite5mPerM, cacheWrite1hPerM, card };
}
function costOf(usage, modelId, opts = {}) {
  const price = priceFor(modelId);
  if (!price || !usage)
    return { ...ZERO_COST };
  const n = normalizeUsage(usage, modelId);
  const M3 = 1e6;
  const r = ratesFor(price, {
    ...opts,
    promptTokens: opts.promptTokens ?? n.inputTokens + n.cacheReadTokens + n.cacheWrite5mTokens + n.cacheWrite1hTokens
  });
  const input = n.inputTokens * r.inputPerM / M3;
  const output = n.outputTokens * r.outputPerM / M3;
  const cacheRead = n.cacheReadTokens * r.cachedInputPerM / M3;
  const cacheWrite = (n.cacheWrite5mTokens * r.cacheWrite5mPerM + n.cacheWrite1hTokens * r.cacheWrite1hPerM) / M3;
  const tools = SERVER_TOOLS[price.provider];
  const serverTools = tools ? n.webSearches * tools.webSearchPer1k / 1e3 : 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    serverTools,
    total: input + output + cacheRead + cacheWrite + serverTools,
    unpriced: false
  };
}
function costOnModel(usage, targetModelId, opts = {}) {
  return costOf(usage, targetModelId, opts);
}
function addCost(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    serverTools: a.serverTools + b.serverTools,
    total: a.total + b.total,
    unpriced: a.unpriced && b.unpriced
  };
}
function emptyCost() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    serverTools: 0,
    total: 0,
    unpriced: false
  };
}
function usd(n) {
  if (!Number.isFinite(n))
    return "$0.00";
  if (n === 0)
    return "$0.00";
  if (Math.abs(n) < 0.01)
    return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1)
    return `$${n.toFixed(3)}`;
  if (Math.abs(n) >= 1e3)
    return `$${Math.round(n).toLocaleString()}`;
  return `$${n.toFixed(2)}`;
}
function tokens(n) {
  if (n >= 1e9)
    return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)
    return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3)
    return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

// ../../packages/core/dist/analyze/classify.js
var REASONING_FLOOR = 200;
var GENERATION_FLOOR = 900;
var MECHANICAL_CEILING = 600;
function classify(e) {
  if (e.thinkingTokens >= REASONING_FLOOR)
    return "reasoning";
  if (e.tools.length >= 2)
    return "tool-orchestration";
  if (e.outputTokens >= GENERATION_FLOOR)
    return "generation";
  if (e.thinkingTokens === 0 && e.outputTokens < MECHANICAL_CEILING && e.tools.length <= 1) {
    return "mechanical";
  }
  return "unknown";
}
function classifyAll(events) {
  for (const e of events) {
    if (!e.category)
      e.category = classify(e);
  }
}

// ../../packages/core/dist/analyze/tasks.js
var MECHANICAL_TASKS = /* @__PURE__ */ new Set(["quick-edit", "lookup"]);
var TASK_KIND_LABEL = {
  "quick-edit": "quick edit",
  lookup: "lookup",
  conversation: "conversation",
  "multi-step": "multi-step task",
  debugging: "debugging",
  reasoning: "reasoning"
};
var QUICK_MAX_CALLS = 8;
var QUICK_MAX_FILES = 2;
var QUICK_MAX_ANSWER = 1500;
var TASK_REASONING_TOKENS = 2e3;
var DEBUG_FAILURES = 2;
var QUIET_MS = 15 * 6e4;
var TERMINAL_STOPS = /* @__PURE__ */ new Set(["end_turn", "stop_sequence", "max_tokens"]);
var EDIT_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);
var READ_TOOLS = /* @__PURE__ */ new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "NotebookRead"]);
var SHELL_TOOLS = /* @__PURE__ */ new Set(["Bash", "exec_command", "shell", "local_shell"]);
var NEUTRAL_TOOLS = /* @__PURE__ */ new Set([
  "TodoWrite",
  "update_plan",
  "write_stdin",
  "BashOutput",
  "ToolSearch",
  "Skill",
  "AskUserQuestion"
]);
var DELEGATE_TOOLS = /* @__PURE__ */ new Set(["Task", "Agent"]);
var READ_ONLY_COMMAND = /^(ls|cat|head|tail|less|grep|egrep|rg|ag|find|fd|pwd|echo|printf|wc|which|type|tree|stat|file|du|df|sort|uniq|cut|tr|awk|diff|cmp|date|env|printenv|basename|dirname|realpath|ps|lsof|sed -n|jq|test|\[|true|git (status|diff|log|show|branch|blame|rev-parse|ls-files|remote|config --get)|gh (api|run (view|list)|pr (view|list|diff|checks)|issue (view|list))|curl)\b/;
var NEUTRAL_COMMAND = /^(cd|export|source|\.|set|unset|nvm use|for|while|until|if|done|fi|esac|\w+=\S*$)(\s|$)/;
var CONTROL_PREFIX = /^(do|then|else|elif)\s+/;
function commandOf(t) {
  if (!SHELL_TOOLS.has(t.name))
    return null;
  const rest = t.signature.slice(t.name.length + 1);
  if (t.name === "Bash")
    return rest;
  const m = /"(?:cmd|command)":\s*(?:\[\s*)?"((?:[^"\\]|\\.)*)"/.exec(rest);
  return m ? m[1] : rest;
}
function commandParts(command) {
  const unquoted = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "Q");
  return unquoted.split(/&&|\|\||;|\||\n/).map((p) => p.trim().replace(CONTROL_PREFIX, "").replace(/^(\w+=\S+\s+)+/, "")).filter(Boolean);
}
function isReadOnlyCommand(command) {
  const parts = commandParts(command).filter((p) => !NEUTRAL_COMMAND.test(p));
  return parts.length > 0 && parts.every((p) => READ_ONLY_COMMAND.test(p) && !/(^|[^0-9&>])>{1,2}(?!\s*(&|\/dev\/null))/.test(p) && !(/^find\b/.test(p) && /\s-(delete|exec|execdir|ok)\b/.test(p)) && !(/^curl\b/.test(p) && /\s(-d|--data\S*|-X\s*(POST|PUT|PATCH|DELETE)|-T|-F)\b/.test(p)) && !(/^gh api\b/.test(p) && /\s(-X|--method|-f|-F)\b/.test(p)));
}
function isMutating(t) {
  if (EDIT_TOOLS.has(t.name))
    return true;
  const cmd = commandOf(t);
  return cmd !== null && !isReadOnlyCommand(cmd);
}
function isEdit(t) {
  return EDIT_TOOLS.has(t.name);
}
function visible(e) {
  return Math.max(0, e.outputTokens - e.thinkingTokens);
}
function contextOf(e) {
  return e.inputTokens + e.cacheReadTokens + e.cacheWrite5mTokens + e.cacheWrite1hTokens;
}
function shapeOf(t, tools) {
  if (t.failures >= DEBUG_FAILURES)
    return "debugging";
  if (t.delegated || t.calls > QUICK_MAX_CALLS || t.filesEdited > QUICK_MAX_FILES || t.answerTokens > QUICK_MAX_ANSWER) {
    return "multi-step";
  }
  const working = tools.filter((x) => !NEUTRAL_TOOLS.has(x.name));
  if (working.length === 0)
    return "conversation";
  if (t.edits > 0)
    return "quick-edit";
  const onlyReads = working.every((x) => READ_TOOLS.has(x.name) || commandOf(x) !== null && !isMutating(x));
  return onlyReads ? "lookup" : "multi-step";
}
function buildTasks(events, opts = {}) {
  const byTurn = /* @__PURE__ */ new Map();
  let newest = -Infinity;
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (Number.isFinite(t) && t > newest)
      newest = t;
    if (!e.turnId)
      continue;
    const arr = byTurn.get(e.turnId);
    if (arr)
      arr.push(e);
    else
      byTurn.set(e.turnId, [e]);
  }
  const now = opts.now ?? newest;
  const tasks = [];
  for (const [id, list] of byTurn) {
    const evs = [...list].sort((a, b) => a.ts.localeCompare(b.ts));
    const first = evs[0];
    const last = evs[evs.length - 1];
    const tools = evs.flatMap((e) => e.tools);
    const costByModel = /* @__PURE__ */ new Map();
    for (const e of evs)
      costByModel.set(e.model, (costByModel.get(e.model) ?? 0) + e.cost.total);
    const model = [...costByModel].sort((a, b) => b[1] - a[1])[0][0];
    const edited = tools.filter((t) => isEdit(t) && !t.isError);
    const base = {
      id,
      sessionId: first.sessionId,
      source: first.source,
      project: first.project,
      isSubagent: Boolean(first.isSubagent),
      events: evs,
      model,
      start: first.ts,
      end: last.ts,
      calls: evs.length,
      costUsd: evs.reduce((s, e) => s + e.cost.total, 0),
      outputTokens: evs.reduce((s, e) => s + e.outputTokens, 0),
      thinkingTokens: evs.reduce((s, e) => s + e.thinkingTokens, 0),
      answerTokens: visible(last),
      edits: edited.length,
      filesEdited: new Set(edited.map((t) => t.target ?? t.signature)).size,
      failures: tools.filter((t) => t.isError).length,
      delegated: tools.some((t) => DELEGATE_TOOLS.has(t.name)),
      firstContext: contextOf(first),
      maxContext: Math.max(...evs.map(contextOf))
    };
    const shape = shapeOf(base, tools);
    tasks.push({
      ...base,
      done: TERMINAL_STOPS.has(last.stopReason ?? "") || now - Date.parse(last.ts) > QUIET_MS,
      kind: base.thinkingTokens >= TASK_REASONING_TOKENS ? "reasoning" : shape,
      shape
    });
  }
  const bySession = /* @__PURE__ */ new Map();
  for (const t of tasks) {
    const arr = bySession.get(t.sessionId);
    if (arr)
      arr.push(t);
    else
      bySession.set(t.sessionId, [t]);
  }
  for (const list of bySession.values()) {
    for (const t of list) {
      if (!t.done)
        t.done = list.some((o) => o !== t && o.start > t.end);
    }
  }
  return tasks.sort((a, b) => a.start.localeCompare(b.start));
}
function stampTasks(tasks) {
  const byEvent = /* @__PURE__ */ new Map();
  for (const t of tasks) {
    for (const e of t.events) {
      e.taskKind = t.kind;
      byEvent.set(e.id, t);
    }
  }
  return byEvent;
}

// ../../packages/core/dist/analyze/summary.js
function resolveTimeZone(tz = "UTC") {
  if (tz === "local")
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return tz;
}
function dayKeyIn(ts, tz = "UTC") {
  const zone = resolveTimeZone(tz);
  if (zone === "UTC")
    return ts.slice(0, 10);
  const at = new Date(ts);
  if (Number.isNaN(at.getTime()))
    return ts.slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(at);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
    const y = get("year");
    const m = get("month");
    const d = get("day");
    if (y.length !== 4 || m.length !== 2 || d.length !== 2)
      return ts.slice(0, 10);
    return `${y}-${m}-${d}`;
  } catch {
    return ts.slice(0, 10);
  }
}
var PACE_DAYS = 30;
function projectionDays(data) {
  const days = Math.max(1, data.window.days || 1);
  if (days <= PACE_DAYS)
    return days;
  const end = Date.parse(data.window.to);
  if (!Number.isFinite(end))
    return days;
  const from = end - PACE_DAYS * 864e5;
  let total = 0;
  let recent = 0;
  for (const e of data.events) {
    total += e.cost.total;
    if (Date.parse(e.ts) >= from)
      recent += e.cost.total;
  }
  if (total <= 0 || recent <= 0)
    return days;
  return total / (recent / PACE_DAYS);
}
function newBucket(key) {
  return {
    key,
    calls: 0,
    cost: emptyCost(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    thinkingTokens: 0
  };
}
function push(map, key, e) {
  let b = map.get(key);
  if (!b) {
    b = newBucket(key);
    map.set(key, b);
  }
  b.calls++;
  b.cost = addCost(b.cost, e.cost);
  b.inputTokens += e.inputTokens;
  b.outputTokens += e.outputTokens;
  b.cacheReadTokens += e.cacheReadTokens;
  b.cacheWriteTokens += e.cacheWrite5mTokens + e.cacheWrite1hTokens;
  b.cacheWrite5mTokens += e.cacheWrite5mTokens;
  b.cacheWrite1hTokens += e.cacheWrite1hTokens;
  b.thinkingTokens += e.thinkingTokens;
}
function sorted(map) {
  return [...map.values()].sort((a, b) => b.cost.total - a.cost.total);
}
function percentile(sortedValues, p) {
  if (sortedValues.length === 0)
    return 0;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(p / 100 * sortedValues.length) - 1));
  return sortedValues[idx];
}
function inputRateOf(e) {
  const price = priceFor(e.model);
  if (!price)
    return 0;
  return ratesFor(price, { at: e.ts, speed: e.speed, batch: e.batch }).inputPerM;
}
function summarize(data, opts = {}) {
  const dayTimeZone = resolveTimeZone(opts.timeZone ?? "UTC");
  const byModel = /* @__PURE__ */ new Map();
  const byProvider = /* @__PURE__ */ new Map();
  const byDay = /* @__PURE__ */ new Map();
  const byProject = /* @__PURE__ */ new Map();
  const bySession = /* @__PURE__ */ new Map();
  const byRoute = /* @__PURE__ */ new Map();
  let cost = emptyCost();
  let inputTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cacheWrite5mTokens = 0;
  let cacheWrite1hTokens = 0;
  let webSearches = 0;
  let thinkingCost = 0;
  const latencies = [];
  for (const e of data.events) {
    cost = addCost(cost, e.cost);
    inputTokens += e.inputTokens;
    outputTokens += e.outputTokens;
    thinkingTokens += e.thinkingTokens;
    cacheReadTokens += e.cacheReadTokens;
    cacheWriteTokens += e.cacheWrite5mTokens + e.cacheWrite1hTokens;
    cacheWrite5mTokens += e.cacheWrite5mTokens;
    cacheWrite1hTokens += e.cacheWrite1hTokens;
    webSearches += e.webSearches ?? 0;
    if (e.outputTokens > 0) {
      thinkingCost += e.cost.output * (e.thinkingTokens / e.outputTokens);
    }
    if (typeof e.latencyMs === "number")
      latencies.push(e.latencyMs);
    push(byModel, e.model, e);
    push(byProvider, e.provider ?? "unknown", e);
    push(byDay, dayKeyIn(e.ts, dayTimeZone), e);
    push(byProject, e.project, e);
    push(bySession, e.sessionId, e);
    if (e.route)
      push(byRoute, e.route, e);
  }
  const tokensOf = (e) => e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWrite5mTokens + e.cacheWrite1hTokens;
  const toTop = (e) => ({
    id: e.id,
    ts: e.ts,
    model: e.model,
    provider: e.provider ?? "unknown",
    project: e.project,
    route: e.route,
    costUsd: e.cost.total,
    totalTokens: tokensOf(e),
    inputTokens: e.inputTokens + e.cacheReadTokens + e.cacheWrite5mTokens + e.cacheWrite1hTokens,
    outputTokens: e.outputTokens,
    latencyMs: e.latencyMs
  });
  const topByCost = [...data.events].sort((a, b) => b.cost.total - a.cost.total).slice(0, 10).map(toTop);
  const topByTokens = [...data.events].sort((a, b) => tokensOf(b) - tokensOf(a)).slice(0, 10).map(toTop);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const days = projectionDays(data);
  const totalInputSide = inputTokens + cacheReadTokens + cacheWriteTokens;
  latencies.sort((a, b) => a - b);
  return {
    calls: data.events.length,
    totalCost: cost.total,
    cost,
    window: data.window,
    // Divided by elapsed days, not days with traffic: a quiet fortnight is part
    // of the rate. Past 30 days, it's the last 30 days' rate (see projectionDays).
    perDay: cost.total / days,
    perMonth: cost.total / days * 30,
    pace: Math.max(1, data.window.days || 1) > PACE_DAYS ? "last-30-days" : "window",
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    webSearches,
    dayTimeZone,
    windowDays: {
      from: data.window.from ? dayKeyIn(data.window.from, dayTimeZone) : "",
      to: data.window.to ? dayKeyIn(data.window.to, dayTimeZone) : ""
    },
    cacheHitRate: totalInputSide > 0 ? cacheReadTokens / totalInputSide : 0,
    thinkingShare: cost.output > 0 ? thinkingCost / cost.output : 0,
    totalTokens,
    avgTokensPerCall: data.events.length ? totalTokens / data.events.length : 0,
    avgCostPerCall: data.events.length ? cost.total / data.events.length : 0,
    byModel: sorted(byModel),
    byProvider: sorted(byProvider),
    topByCost,
    topByTokens,
    byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byProject: sorted(byProject),
    bySession: sorted(bySession),
    byRoute: sorted(byRoute),
    latency: latencies.length ? {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      count: latencies.length
    } : null
  };
}

// ../../packages/core/dist/analyze/cold.js
var COLD_MIN_CONTEXT = 5e4;
var REWRITE_SHARE = 0.6;
var AUTO_IDLE_MINUTES = 5;
var M = 1e6;
var emptySeen = () => ({ w5: 0, w1: 0, read: 0 });
function see(s, e) {
  s.w5 += e.cacheWrite5mTokens;
  s.w1 += e.cacheWrite1hTokens;
  s.read += e.cacheReadTokens;
}
function cachesOnItsOwn(e) {
  return e.source === "codex";
}
function cacheMinutes(s, e) {
  if (cachesOnItsOwn(e))
    return null;
  return s.w1 >= s.w5 ? 60 : 5;
}
function mainConversations(events) {
  const out = /* @__PURE__ */ new Map();
  for (const e of events) {
    if (e.isSubagent)
      continue;
    const key = `${e.sessionId}|${e.contextEpoch ?? 0}`;
    const arr = out.get(key);
    if (arr)
      arr.push(e);
    else
      out.set(key, [e]);
  }
  for (const arr of out.values())
    arr.sort((a, b) => a.ts.localeCompare(b.ts));
  return [...out.values()];
}
function coldReturn(prev, e, before) {
  const auto = cachesOnItsOwn(e);
  const hadCache = auto ? before.read > 0 : before.w5 + before.w1 > 0;
  if (!hadCache)
    return null;
  const ttlMinutes = cacheMinutes(before, e);
  const gapMinutes = (Date.parse(e.ts) - Date.parse(prev.ts)) / 6e4;
  const context = contextOf(e);
  if (gapMinutes < (ttlMinutes ?? AUTO_IDLE_MINUTES) || context < COLD_MIN_CONTEXT)
    return null;
  const rewriteTokens = auto ? e.inputTokens : e.cacheWrite5mTokens + e.cacheWrite1hTokens;
  if (rewriteTokens < context * REWRITE_SHARE)
    return null;
  const price = priceFor(e.model);
  if (!price)
    return null;
  const r = ratesFor(price, { at: e.ts, speed: e.speed, batch: e.batch });
  if (auto) {
    const warmShare = r.inputPerM > 0 ? r.cachedInputPerM / r.inputPerM : 0;
    return {
      event: e,
      previous: prev,
      gapMinutes,
      ttlMinutes,
      rewriteTokens,
      rewriteUsd: e.cost.input,
      warmUsd: e.cost.input * warmShare
    };
  }
  return {
    event: e,
    previous: prev,
    gapMinutes,
    ttlMinutes,
    rewriteTokens,
    rewriteUsd: (e.cacheWrite5mTokens * r.cacheWrite5mPerM + e.cacheWrite1hTokens * r.cacheWrite1hPerM) / M,
    warmUsd: rewriteTokens * r.cachedInputPerM / M
  };
}
function coldResumes(events) {
  const found = [];
  for (const conversation of mainConversations(events)) {
    const seen = emptySeen();
    for (let i = 0; i < conversation.length; i++) {
      const e = conversation[i];
      const prev = conversation[i - 1];
      const cold = prev ? coldReturn(prev, e, seen) : null;
      see(seen, e);
      if (cold)
        found.push(cold);
    }
  }
  return found;
}

// ../../packages/core/dist/analyze/rules.js
var CHARS_PER_TOKEN = 4;
var MONTH_DAYS = 30;
var YEAR_DAYS = 365;
var M2 = 1e6;
var READ_ONLY_TOOLS = /* @__PURE__ */ new Set(["Read", "Grep", "Glob", "WebFetch", "NotebookRead"]);
function resultTokensOf(t) {
  if (typeof t.resultTokens === "number")
    return t.resultTokens;
  return (t.resultChars ?? 0) / CHARS_PER_TOKEN;
}
function cachePolicyOf(e) {
  return PROVIDERS[e.provider] ?? PROVIDERS.anthropic;
}
function buildCtx(data) {
  classifyAll(data.events);
  const tasks = buildTasks(data.events);
  const taskOf = stampTasks(tasks);
  const sessions = /* @__PURE__ */ new Map();
  let totalCost = 0;
  for (const e of data.events) {
    totalCost += e.cost.total;
    let arr = sessions.get(e.sessionId);
    if (!arr) {
      arr = [];
      sessions.set(e.sessionId, arr);
    }
    arr.push(e);
  }
  for (const arr of sessions.values())
    arr.sort((a, b) => a.ts.localeCompare(b.ts));
  return { data, days: projectionDays(data), totalCost, sessions, tasks, taskOf };
}
var perMonth = (ctx, observed) => observed / ctx.days * MONTH_DAYS;
var perYear = (ctx, observed) => observed / ctx.days * YEAR_DAYS;
function shortPath(p) {
  const parts = p.split("/");
  return parts.length > 3 ? `.../${parts.slice(-2).join("/")}` : p;
}
var SAMPLE_THIN = 10;
var SAMPLE_SOLID = 50;
function confidenceOf(input) {
  const reasons = [
    input.measured ? "costed from recorded tokens at the rate in force" : "modelled rather than measured",
    `${input.sample} affected call${input.sample === 1 ? "" : "s"}`,
    input.tokenProfileStable ? "token counts unchanged by the fix" : "the replacement model's token counts are assumed to match"
  ];
  let level;
  if (!input.measured) {
    level = "low";
    reasons.push("low because the cost was never measured");
  } else if (input.sample < SAMPLE_THIN) {
    level = "low";
    reasons.push(`low because fewer than ${SAMPLE_THIN} calls is too thin to average`);
  } else if (!input.tokenProfileStable) {
    level = "medium";
    reasons.push("medium because the fix changes how the model responds");
  } else if (input.sample < SAMPLE_SOLID) {
    level = "medium";
    reasons.push(`medium because the sample is under ${SAMPLE_SOLID} calls`);
  } else {
    level = "high";
    reasons.push("high because only future traffic is assumed");
  }
  return { level, basis: reasons.join("; ") };
}
function build(ctx, base) {
  const claimedUsd = base.advisory ? 0 : Math.max(0, base.currentUsd - base.optimizedUsd);
  const affectedSpend = base.events.reduce((s, e) => s + e.cost.total, 0);
  const windowUsd = Math.min(claimedUsd, affectedSpend);
  const capped = claimedUsd - windowUsd > 1e-9;
  const optimizedUsd = base.advisory ? base.optimizedUsd : Math.max(0, base.currentUsd - windowUsd);
  const projected = base.advisory ? base.currentUsd : windowUsd;
  const assumptions = capped ? [
    ...base.assumptions,
    `This detector modelled ${usd(claimedUsd)} of waste over the window, which is more than the affected calls cost (${usd(affectedSpend)}). The figure has been capped at what was actually spent.`
  ] : base.assumptions;
  const affectedIds = new Set(base.events.map((e) => e.id));
  const affects = (e) => affectedIds.has(e.id);
  const candidate = base.candidate ? { ...base.candidate, matches: affects } : void 0;
  const verification = base.risk === "safe" ? "not-required" : candidate ? "replay" : "manual";
  const claimByEvent = /* @__PURE__ */ new Map();
  if (windowUsd > 0 && base.events.length > 0) {
    for (const e of base.events) {
      const share = affectedSpend > 0 ? e.cost.total / affectedSpend : 1 / base.events.length;
      claimByEvent.set(e.id, (claimByEvent.get(e.id) ?? 0) + windowUsd * share);
    }
  }
  const byCost = [...base.events].sort((a, b) => b.cost.total - a.cost.total);
  const dailyWaste = windowUsd / ctx.days;
  return {
    rule: base.rule,
    category: base.category,
    title: base.title,
    detail: base.detail,
    why: base.why,
    tier: base.tier ?? (base.impact === "none" || base.impact === "low" ? "fix" : "try"),
    savings: {
      currentUsd: base.currentUsd,
      optimizedUsd,
      windowUsd,
      monthlyUsd: perMonth(ctx, projected),
      annualUsd: perYear(ctx, projected),
      windowDays: Math.max(1, ctx.data.window.days || 1),
      projectionDays: ctx.days,
      confidence: base.confidence.level,
      confidenceBasis: base.confidence.basis,
      assumptions,
      calculation: base.calculation,
      evidence: base.evidence
    },
    affected: {
      calls: base.events.length,
      models: [...new Set(base.events.map((e) => e.model))].sort(),
      projects: [...new Set(base.events.map((e) => e.project))].sort(),
      routes: [...new Set(base.events.map((e) => e.route).filter(Boolean))],
      share: ctx.totalCost > 0 ? affectedSpend / ctx.totalCost : 0,
      sampleEventIds: byCost.slice(0, 20).map((e) => e.id)
    },
    impact: base.impact,
    severity: base.severityOverride ?? (dailyWaste > 0.5 ? "high" : dailyWaste > 0.05 ? "medium" : "low"),
    risk: base.risk,
    verification,
    advisory: base.advisory,
    observations: base.observations,
    fix: base.fix,
    affects,
    claimByEvent,
    candidate
  };
}
var evidence = (kind, basis) => ({ kind, basis });
function contexts(ctx) {
  const out = /* @__PURE__ */ new Map();
  for (const events of ctx.sessions.values()) {
    for (const e of events) {
      const who = e.isSubagent ? `sub:${e.turnId ?? ""}` : "main";
      const key = `${e.sessionId}|${who}|${e.contextEpoch ?? 0}`;
      const arr = out.get(key);
      if (arr)
        arr.push(e);
      else
        out.set(key, [e]);
    }
  }
  return [...out.values()];
}
function repeatToolCalls(ctx) {
  let wasted = 0;
  const perSignature = /* @__PURE__ */ new Map();
  const touched = /* @__PURE__ */ new Set();
  for (const events2 of contexts(ctx)) {
    const seen = /* @__PURE__ */ new Map();
    for (let i = 0; i < events2.length; i++) {
      const e = events2[i];
      const remaining = events2.length - i - 1;
      const rate = inputRateOf(e);
      const policy = cachePolicyOf(e);
      for (const t of e.tools) {
        if (!t.isError && isMutating(t)) {
          for (const sig of [...seen.keys()]) {
            const file = sig.startsWith("Read:") ? sig.slice(5).replace(/#[^#]*$/, "") : null;
            if (file === null ? !sig.startsWith("WebFetch:") : !t.target || t.target === file) {
              seen.delete(sig);
            }
          }
          continue;
        }
        if (!READ_ONLY_TOOLS.has(t.name))
          continue;
        const prior = seen.get(t.signature) ?? 0;
        seen.set(t.signature, prior + 1);
        if (prior === 0)
          continue;
        const tk = resultTokensOf(t);
        if (tk < 50)
          continue;
        const cost = tk * rate * (policy.write5m + remaining * policy.read) / M2;
        wasted += cost;
        touched.add(e);
        const agg = perSignature.get(t.signature) ?? { count: 0, cost: 0, tokens: 0 };
        agg.count++;
        agg.cost += cost;
        agg.tokens += tk;
        perSignature.set(t.signature, agg);
      }
    }
  }
  if (wasted < 0.01)
    return null;
  const top = [...perSignature.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 5);
  const totalRepeats = [...perSignature.values()].reduce((s, v) => s + v.count, 0);
  const events = [...touched];
  const currentUsd = events.reduce((s, e) => s + e.cost.total, 0);
  return build(ctx, {
    rule: "repeat-tool-calls",
    why: "A repeat is written into the conversation again and re-read by every later call, so it keeps costing until the conversation ends or is compacted.",
    category: "context-bloat",
    title: `${totalRepeats} redundant re-reads of content already in context`,
    detail: "The same file or search was fetched again in the same conversation, with nothing edited in between. Re-reads after an edit, after a compaction or by a subagent are not counted. Each duplicate is re-written into the cacheable prefix and then re-read by every later call, so the cost compounds with conversation length.",
    currentUsd,
    optimizedUsd: currentUsd - wasted,
    events,
    evidence: evidence("measured", "Duplicate results were counted directly and priced at the rate in force"),
    confidence: confidenceOf({ measured: true, sample: totalRepeats, tokenProfileStable: true }),
    impact: "none",
    risk: "safe",
    assumptions: [
      "A duplicate read returns the same content the conversation already had: no edit to that file, and no change at all for a search, came in between.",
      "The duplicate stays in the prefix until the conversation ends or is compacted.",
      "Removing it changes nothing else about the call."
    ],
    calculation: "For each duplicate: result tokens x input rate x (cache-write multiplier + remaining calls in session x cache-read multiplier).",
    observations: top.map(([sig, v]) => `${shortPath(sig).slice(0, 60)}: ${v.count} duplicate${v.count === 1 ? "" : "s"}, ${tokens(v.tokens)} tok, ${usd(v.cost)}`),
    fix: "Keep a per-session record of what has already been read and serve repeats from it. In agent harnesses, prefer a targeted re-read (offset/limit) over refetching a whole file."
  });
}
var OVERSPEC_TIERS = /* @__PURE__ */ new Set(["frontier", "balanced"]);
function isMechanicalCall(e) {
  return OVERSPEC_TIERS.has(priceFor(e.model)?.tier ?? "") && e.thinkingTokens === 0 && e.outputTokens < 600 && e.tools.length <= 1;
}
function blendedRate(price) {
  const card = cardFor(price);
  return card.inputPerM + card.outputPerM;
}
var STEP_DOWN = {
  frontier: ["balanced", "fast"],
  balanced: ["fast"]
};
function downgradeTargetFor(modelId) {
  const from = priceFor(modelId);
  if (!from)
    return null;
  const ceiling = blendedRate(from);
  for (const tier of STEP_DOWN[from.tier] ?? []) {
    let best = null;
    let sibling = null;
    for (const m of allModels()) {
      if (m.provider !== from.provider || m.tier !== tier)
        continue;
      const rate = blendedRate(m);
      if (rate >= ceiling)
        continue;
      if (m.id.startsWith(`${from.id}-`) && !sibling)
        sibling = m;
      if (!best || rate < blendedRate(best))
        best = m;
    }
    if (sibling ?? best)
      return sibling ?? best;
  }
  return null;
}
function listOf(items) {
  if (items.length <= 1)
    return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
function repriced(e, from, to) {
  const now = ratesFor(from, { at: e.ts, speed: e.speed, batch: e.batch });
  const then = ratesFor(to, { at: e.ts, batch: e.batch });
  const priceWith = (r) => (e.inputTokens * r.inputPerM + e.outputTokens * r.outputPerM + e.cacheReadTokens * r.cachedInputPerM + e.cacheWrite5mTokens * r.cacheWrite5mPerM + e.cacheWrite1hTokens * r.cacheWrite1hPerM) / M2;
  return { before: priceWith(now), after: priceWith(then) };
}
function reloadCost(to, contextTokens, at) {
  const r = ratesFor(to, { at });
  return contextTokens * (Math.max(r.inputPerM, r.cacheWrite5mPerM) - r.cachedInputPerM) / M2;
}
function kindMix(tasks) {
  const counts2 = /* @__PURE__ */ new Map();
  for (const t of tasks)
    counts2.set(t.kind, (counts2.get(t.kind) ?? 0) + 1);
  return listOf([...counts2].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${TASK_KIND_LABEL[k]}${n === 1 ? "" : "s"}`));
}
function modelFit(ctx) {
  let currentUsd = 0;
  let optimizedUsd = 0;
  const events = [];
  const samples = [];
  const targets = /* @__PURE__ */ new Map();
  const sources = /* @__PURE__ */ new Set();
  const pairs = /* @__PURE__ */ new Map();
  let calls = 0;
  for (const e of ctx.data.events) {
    if (ctx.taskOf.has(e.id) || !isMechanicalCall(e))
      continue;
    const price = priceFor(e.model);
    const target = downgradeTargetFor(e.model);
    if (!price || !target || contextOf(e) > target.contextTokens * 0.9)
      continue;
    const { before, after } = repriced(e, price, target);
    if (after >= before)
      continue;
    currentUsd += before;
    optimizedUsd += after;
    events.push(e);
    calls++;
    targets.set(target.id, target);
    sources.add(price.label);
    pairs.set(price.label, target.label);
    if (samples.length < 5) {
      samples.push({
        desc: `${modelLabel(e.model)} -> ${target.label} \xB7 ${tokens(contextOf(e))} ctx \xB7 ${e.outputTokens} out \xB7 ${e.tools[0]?.name ?? "no tool"}`,
        saved: before - after
      });
    }
  }
  const counted = [];
  const taskSamples = [];
  const eligible = (t) => {
    const price = priceFor(t.model);
    if (!t.done || !MECHANICAL_TASKS.has(t.kind) || !price || !OVERSPEC_TIERS.has(price.tier)) {
      return null;
    }
    const target = downgradeTargetFor(t.model);
    return target && t.maxContext <= target.contextTokens * 0.9 ? target : null;
  };
  const runs = [];
  const open = /* @__PURE__ */ new Map();
  for (const t of ctx.tasks) {
    const fits = eligible(t) !== null;
    if (t.isSubagent) {
      if (fits)
        runs.push([t]);
      continue;
    }
    const run = open.get(t.sessionId);
    if (!fits)
      open.delete(t.sessionId);
    else if (run)
      run.push(t);
    else {
      const fresh = [t];
      open.set(t.sessionId, fresh);
      runs.push(fresh);
    }
  }
  for (const run of runs) {
    const first = run[0];
    const target = eligible(first);
    let before = 0;
    let after = 0;
    const perTask = [];
    for (const t of run) {
      let b = 0;
      let a = 0;
      for (const e of t.events) {
        const fromPrice = priceFor(e.model);
        const to = downgradeTargetFor(e.model);
        if (!fromPrice || !to)
          continue;
        const r = repriced(e, fromPrice, to);
        b += r.before;
        a += Math.min(r.after, r.before);
      }
      before += b;
      after += a;
      perTask.push({ t, saved: b - a });
    }
    const reload = first.isSubagent ? 0 : reloadCost(target, first.firstContext, first.start);
    if (before - after - reload <= 0)
      continue;
    currentUsd += before;
    optimizedUsd += after + reload;
    for (const { t, saved } of perTask) {
      events.push(...t.events);
      counted.push(t);
      targets.set(eligible(t).id, eligible(t));
      sources.add(priceFor(t.model).label);
      pairs.set(priceFor(t.model).label, eligible(t).label);
      taskSamples.push({
        desc: `${TASK_KIND_LABEL[t.kind]} \xB7 ${t.calls} call${t.calls === 1 ? "" : "s"}${t.filesEdited ? ` \xB7 ${t.filesEdited} file${t.filesEdited === 1 ? "" : "s"}` : ""} \xB7 ${tokens(t.firstContext)} ctx${t.isSubagent ? " \xB7 subagent" : ""} \xB7 ${modelLabel(t.model)} -> ${eligible(t).label}`,
        saved
      });
    }
  }
  const saving = currentUsd - optimizedUsd;
  const tasks = counted.length;
  if (saving < 0.01 || calls < 5 && tasks < 5)
    return null;
  const names = listOf([...targets.values()].map((t) => t.label));
  const from = listOf([...sources]);
  const pairText = listOf([...pairs].map(([a, b]) => `${a} to ${b}`));
  const subagents = counted.filter((t) => t.isSubagent).length;
  const what = tasks > 0 ? `${tasks} quick task${tasks === 1 ? "" : "s"}${calls >= 5 ? ` and ${calls} simple calls` : ""}` : `${calls} simple calls`;
  const shapeNote = tasks > 0 ? `Each task took at most ${QUICK_MAX_CALLS} calls, edited at most ${QUICK_MAX_FILES} files, failed at most once, thought for under ${tokens(TASK_REASONING_TOKENS)} tokens and ended with a short answer (${kindMix(counted)}${subagents ? `; ${subagents} in subagents` : ""}).` : "Each call had no reasoning tokens, a short output and at most one tool call.";
  return build(ctx, {
    rule: "model-fit",
    why: `These jobs were within reach of a model one tier down, so the bigger model's price bought nothing extra: the same work costs ${currentUsd > 0 ? Math.round((1 - optimizedUsd / currentUsd) * 100) : 0}% less there.`,
    category: "model-selection",
    title: `${what} ran on ${from}`,
    detail: `${shapeNote} Re-priced on ${names}${tasks > 0 ? ", including reloading a conversation into its cache where it would switch mid-way" : ""}, the same work costs ${usd(optimizedUsd)} instead of ${usd(currentUsd)}.`,
    currentUsd,
    optimizedUsd,
    events,
    evidence: evidence("estimated", `Recorded tokens re-priced on ${names}; assumes a comparable token profile`),
    confidence: confidenceOf({
      measured: true,
      sample: tasks + calls,
      tokenProfileStable: false
    }),
    impact: "medium",
    risk: "needs-verification",
    assumptions: [
      "The cheaper model produces a comparable token profile. A different model may be more or less verbose.",
      ...tasks > 0 ? [
        "A task is judged by its shape (calls, files edited, failures, output), never by what was asked. Tasks still running are left out.",
        "Switching back afterwards finds the bigger model's cache still warm."
      ] : [],
      "Similar work keeps arriving at the same rate.",
      "Every affected call fits inside the context window of the model it would move to.",
      "Quality is unverified until `optimaizr verify model-fit` replays this traffic."
    ],
    calculation: `Each call re-priced one tier down on the cheapest model from its own provider (${names}) using its recorded token counts and the rate cards in force on the day of the call.${tasks > 0 ? " Consecutive quick tasks in one conversation switch together and pay one cache reload of the context the first one started with; a run whose reload outweighs its saving is left out. Subagents pay no reload." : ""}`,
    observations: [...taskSamples, ...samples].sort((a, b) => b.saved - a.saved).slice(0, 5).map((s) => `${s.desc}, would save ${usd(s.saved)}`),
    fix: tasks > 0 ? `Move quick edits and lookups one model down (${pairText}) and keep the bigger model for planning, debugging and multi-step work: /model before a run of small tasks, or a subagent for them.` : `Route mechanical steps to ${names} and keep the bigger model for planning and multi-step reasoning.`,
    candidate: {
      kind: "swap-model",
      // A single target collapses to `to`; mixed-provider traffic resolves
      // per call instead, so nothing is ever re-routed across vendors.
      to: targets.size === 1 ? [...targets.keys()][0] : void 0,
      targetFor: (modelId) => downgradeTargetFor(modelId)?.id,
      matches: (e) => {
        const task = ctx.taskOf.get(e.id);
        return task ? counted.includes(task) : isMechanicalCall(e);
      },
      description: `Route ${tasks > 0 ? "quick tasks" : "mechanical calls"} to ${names}`
    }
  });
}
function cacheChurn(ctx) {
  const summary = summarize(ctx.data);
  const inputSide = summary.inputTokens + summary.cacheReadTokens + summary.cacheWriteTokens;
  if (inputSide < 1e5)
    return null;
  if (summary.cacheHitRate >= 0.7)
    return null;
  let saving = 0;
  let currentUsd = 0;
  const events = [];
  const offenders = /* @__PURE__ */ new Map();
  for (const e of ctx.data.events) {
    const rate = inputRateOf(e);
    const policy = cachePolicyOf(e);
    if (e.inputTokens > 2e3) {
      saving += (e.inputTokens - 2e3) * rate * (1 - policy.read) / M2;
      currentUsd += e.cost.total;
      events.push(e);
    }
    if (e.prefixHash) {
      const key = e.route ?? e.project;
      const agg = offenders.get(key) ?? { calls: 0, prefixes: /* @__PURE__ */ new Set(), cost: 0 };
      agg.calls++;
      agg.prefixes.add(e.prefixHash);
      agg.cost += e.cost.total;
      offenders.set(key, agg);
    }
  }
  if (saving < 0.01)
    return null;
  const churny = [...offenders.entries()].filter(([, v]) => v.prefixes.size > Math.max(3, v.calls * 0.5)).sort((a, b) => b[1].cost - a[1].cost).slice(0, 5);
  return build(ctx, {
    rule: "cache-churn",
    why: "Input served from cache costs a fraction of the normal rate; this traffic pays full price for a prefix it has sent before.",
    category: "caching",
    title: `Only ${(summary.cacheHitRate * 100).toFixed(0)}% of input tokens are served from cache`,
    detail: "Cache reads bill at a tenth of the input rate or less, so a stable prefix is the single largest lever on input cost. A hit rate this low means the cacheable prefix is changing between calls or cache_control breakpoints are missing.",
    currentUsd,
    optimizedUsd: currentUsd - saving,
    events,
    evidence: evidence("inferred", "Uncached input was measured; that it could be cached is inferred from prefix stability"),
    confidence: confidenceOf({
      measured: true,
      sample: events.length,
      tokenProfileStable: true
    }),
    impact: "none",
    risk: "safe",
    assumptions: [
      "The prefix could be made stable enough to hit cache on repeat calls.",
      "A 2,000-token tail is genuinely per-call and excluded from the estimate.",
      "Cache writes are already being paid for, so only the read discount is counted."
    ],
    calculation: "For each call: (fresh input tokens - 2,000) x input rate x (1 - cache-read multiplier).",
    observations: churny.length ? churny.map(([k, v]) => `${k}: ${v.prefixes.size} distinct prefixes across ${v.calls} calls (${usd(v.cost)})`) : [
      `Cache hit rate ${(summary.cacheHitRate * 100).toFixed(1)}% across ${tokens(inputSide)} input tokens`
    ],
    fix: "Put everything stable (tools, then system prompt) at the very front and mark the last stable block with cache_control. Move timestamps, request ids and user-specific text below the breakpoint. Keep tool definitions in a fixed order.",
    candidate: {
      kind: "enable-cache",
      matches: (e) => e.inputTokens > 2e3,
      description: "Stabilise and cache the request prefix"
    }
  });
}
function repeatedContext(ctx) {
  const byPrefix = /* @__PURE__ */ new Map();
  for (const e of ctx.data.events) {
    if (!e.prefixHash)
      continue;
    const agg = byPrefix.get(e.prefixHash) ?? { events: [], sessions: /* @__PURE__ */ new Set() };
    agg.events.push(e);
    agg.sessions.add(e.sessionId);
    byPrefix.set(e.prefixHash, agg);
  }
  const recurring = [...byPrefix.entries()].filter(([, v]) => v.sessions.size >= 3 && v.events.length >= 10);
  if (recurring.length === 0)
    return null;
  let saving = 0;
  const events = [];
  const rows = [];
  for (const [hash2, v] of recurring) {
    const uncached = v.events.reduce((s, e) => s + e.inputTokens, 0);
    if (uncached < 2e4)
      continue;
    const rate = inputRateOf(v.events[0]);
    const policy = cachePolicyOf(v.events[0]);
    const delta = uncached * rate * (1 - policy.read) / M2;
    saving += delta;
    for (const e of v.events)
      events.push(e);
    rows.push(`prefix ${hash2}: ${v.events.length} calls across ${v.sessions.size} sessions, ${tokens(uncached)} uncached (${usd(delta)})`);
  }
  if (saving < 0.01 || events.length === 0)
    return null;
  const currentUsd = events.reduce((s, e) => s + e.cost.total, 0);
  return build(ctx, {
    rule: "repeated-context",
    why: "Context that recurs across requests could be cached at a fraction of the price, but is paid in full every time.",
    category: "caching",
    title: `The same context is re-sent across ${recurring.length} recurring prompt pattern${recurring.length === 1 ? "" : "s"}`,
    detail: "An identical cacheable prefix appears in many separate sessions, but is being paid for at full input rate each time. A prefix that recurs across sessions is exactly what a longer cache TTL is for.",
    currentUsd,
    optimizedUsd: currentUsd - saving,
    events,
    evidence: evidence("inferred", "Prefix fingerprints are measured; that a longer TTL would capture them is inferred"),
    confidence: confidenceOf({
      measured: true,
      sample: events.length,
      tokenProfileStable: true
    }),
    impact: "none",
    risk: "safe",
    assumptions: [
      "The recurring prefix is stable enough to hit a cache entry written by an earlier session.",
      "Calls recur inside the cache TTL you configure."
    ],
    calculation: "Uncached input tokens on recurring prefixes x input rate x (1 - cache-read multiplier).",
    observations: rows.slice(0, 5),
    fix: "Mark the recurring prefix with a 1-hour cache_control breakpoint so it survives between sessions. The write costs twice the input rate once, then every later read costs a tenth or less.",
    candidate: {
      kind: "enable-cache",
      matches: (e) => Boolean(e.prefixHash),
      description: "Extend cache TTL for recurring prefixes"
    }
  });
}
function promptBloat(ctx) {
  const withSystem = ctx.data.events.filter((e) => typeof e.systemChars === "number" && e.systemChars > 0);
  if (withSystem.length < 20)
    return null;
  const avgChars = withSystem.reduce((s, e) => s + (e.systemChars ?? 0), 0) / withSystem.length;
  const avgTokens = avgChars / CHARS_PER_TOKEN;
  if (avgTokens < 4e3)
    return null;
  const TRIM_SHARE = 0.25;
  let saving = 0;
  let currentUsd = 0;
  for (const e of withSystem) {
    const rate = inputRateOf(e);
    const policy = cachePolicyOf(e);
    const sysTokens = (e.systemChars ?? 0) / CHARS_PER_TOKEN;
    const effectiveRate = e.cacheReadTokens > 0 ? rate * policy.read : rate;
    saving += sysTokens * TRIM_SHARE * effectiveRate / M2;
    currentUsd += e.cost.total;
  }
  if (saving < 0.01)
    return null;
  return build(ctx, {
    rule: "prompt-bloat",
    why: "The system prompt is billed on every request, so its size is multiplied across all of your traffic.",
    category: "context-bloat",
    title: `System prompt averages ${tokens(avgTokens)} tokens on every call`,
    detail: "A large system prompt is paid for on every single request. Where it is cached the cost is a tenth or less, but it still occupies context and still bills, and most long prompts carry restated instructions and dead examples.",
    currentUsd,
    optimizedUsd: currentUsd - saving,
    events: withSystem,
    evidence: evidence("estimated", "Prompt size is measured; the trimmable share is a heuristic, not a measurement"),
    confidence: confidenceOf({
      measured: false,
      sample: withSystem.length,
      tokenProfileStable: true
    }),
    impact: "medium",
    risk: "needs-verification",
    assumptions: [
      "A quarter of the prompt is trimmable. This is a heuristic, not a measurement.",
      "Characters are converted at roughly four per token.",
      "Cached prompts are credited at the cache-read rate, not the full input rate."
    ],
    calculation: `Average system prompt of ${tokens(avgTokens)} tokens x ${TRIM_SHARE * 100}% x the effective input rate, summed over ${withSystem.length} calls.`,
    observations: [
      `${withSystem.length} calls carried a system prompt averaging ${Math.round(avgChars).toLocaleString()} characters`,
      `Largest observed: ${withSystem.reduce((m, e) => Math.max(m, e.systemChars ?? 0), 0).toLocaleString()} characters`
    ],
    fix: "Cut restated instructions and stale examples, then measure. Move anything request-specific out of the system prompt and below the cache breakpoint.",
    candidate: {
      kind: "trim-prompt",
      matches: (e) => (e.systemChars ?? 0) / CHARS_PER_TOKEN > 4e3,
      description: "Trim the system prompt"
    }
  });
}
var CONTEXT_BASELINE_TASKS = 20;
function oversizedInput(ctx) {
  let saving = 0;
  const events = [];
  const observations = [];
  const quick = ctx.tasks.filter((t) => t.done && MECHANICAL_TASKS.has(t.kind));
  let flagged = [];
  let baseline = 0;
  if (quick.length >= CONTEXT_BASELINE_TASKS) {
    const starts = quick.map((t) => t.firstContext).sort((a, b) => a - b);
    baseline = starts[Math.floor(starts.length / 2)];
    const bar = Math.max(5e4, baseline * 3, baseline + 5e4);
    flagged = quick.filter((t) => t.firstContext >= bar);
    if (flagged.length < 5)
      flagged = [];
    for (const t of flagged) {
      for (const e of t.events) {
        saving += Math.max(0, contextOf(e) - baseline) * inputRateOf(e) * cachePolicyOf(e).read / M2;
      }
      events.push(...t.events);
    }
    observations.push(...[...flagged].sort((a, b) => b.firstContext - a.firstContext).slice(0, 5).map((t) => `${TASK_KIND_LABEL[t.kind]} \xB7 started at ${tokens(t.firstContext)} ctx \xB7 ${t.calls} call${t.calls === 1 ? "" : "s"} \xB7 ${modelLabel(t.model)} \xB7 ${usd(t.costUsd)}`));
  }
  const loose = ctx.data.events.filter((e) => !ctx.taskOf.has(e.id));
  const sizes = loose.map(contextOf).sort((a, b) => a - b);
  let heavy = [];
  let p90 = 0;
  let median2 = 0;
  if (sizes.length >= 20) {
    p90 = sizes[Math.floor(sizes.length * 0.9)];
    median2 = sizes[Math.floor(sizes.length * 0.5)];
    if (p90 >= 5e4) {
      heavy = loose.filter((e) => contextOf(e) >= p90 && e.category === "mechanical");
      if (heavy.length < 5)
        heavy = [];
    }
    for (const e of heavy) {
      saving += Math.max(0, contextOf(e) - median2) * inputRateOf(e) * cachePolicyOf(e).read / M2;
    }
    events.push(...heavy);
    observations.push(...[...heavy].sort((a, b) => contextOf(b) - contextOf(a)).slice(0, Math.max(0, 5 - observations.length)).map((e) => `${modelLabel(e.model)} \xB7 ${tokens(contextOf(e))} ctx \u2192 ${e.outputTokens} out \xB7 ${usd(e.cost.total)}`));
  }
  if (saving < 0.01 || events.length === 0)
    return null;
  const currentUsd = events.reduce((s, e) => s + e.cost.total, 0);
  const tasks = flagged.length;
  const typicalStart = tasks ? [...flagged].sort((a, b) => a.firstContext - b.firstContext)[Math.floor(tasks / 2)].firstContext : 0;
  return build(ctx, {
    rule: "oversized-input",
    why: "Every call in those tasks re-reads the whole history, so a small job costs as much as a big one.",
    category: "context-bloat",
    title: tasks ? `${tasks} small tasks started with ~${tokens(typicalStart)} of context; similar tasks start near ${tokens(baseline)}` : `${heavy.length} mechanical calls carried ${tokens(p90)}+ of context`,
    detail: tasks ? `Quick edits and lookups in your usage typically start with about ${tokens(baseline)} of context. These ${tasks} started with ${tokens(typicalStart)} or more: history from earlier work in the same conversation, carried into a small job that did not use it. Long conversations doing substantial work are not counted.${heavy.length ? ` ${heavy.length} independent API calls show the same pattern.` : ""}` : `These requests sit in the top 10% by context size but did mechanical work: short output, no reasoning, at most one tool. They are paying to carry a whole session's history to do a small job.`,
    currentUsd,
    optimizedUsd: currentUsd - saving,
    events,
    evidence: evidence("inferred", "Context sizes are measured; that the excess was unnecessary is inferred from what the task did"),
    confidence: confidenceOf({
      measured: true,
      sample: tasks + heavy.length,
      tokenProfileStable: true
    }),
    impact: "low",
    risk: "needs-verification",
    assumptions: [
      tasks ? `Context above what similar small tasks start with (${tokens(baseline)}) was not needed for these tasks.` : `Context above the median (${tokens(median2)}) was not needed for these specific calls.`,
      "The excess is served from cache, so it is credited at the cache-read rate.",
      "What a task was doing is inferred from its shape (calls, files edited, output), not from what was asked."
    ],
    calculation: tasks ? `For each call of a flagged task: (context tokens - ${tokens(baseline)}, the median start of ${quick.length} quick tasks) x input rate x cache-read multiplier. A task is flagged when it started at 3x that median or more, and at least 50K.` : `For each top-decile mechanical call: (context tokens - median ${tokens(median2)}) x input rate x cache-read multiplier.`,
    observations,
    fix: tasks ? "Start small, unrelated jobs in a fresh conversation (/clear), or /compact when you change topic. A subagent also starts with an empty context." : "Split long-running sessions, or dispatch mechanical steps to a fresh short context instead of inheriting the whole conversation. In agent harnesses this is a sub-agent with its own context."
  });
}
function oversizedOutput(ctx) {
  const prose = ctx.data.events.filter((e) => !e.tools.some(isEdit));
  const outputs = prose.map((e) => e.outputTokens).sort((a, b) => a - b);
  if (outputs.length < 20)
    return null;
  const p95 = outputs[Math.floor(outputs.length * 0.95)];
  if (p95 < 4e3)
    return null;
  const big = prose.filter((e) => e.outputTokens >= p95);
  if (big.length < 5)
    return null;
  const median2 = outputs[Math.floor(outputs.length * 0.5)];
  let saving = 0;
  for (const e of big) {
    const price = priceFor(e.model);
    if (!price)
      continue;
    const r = ratesFor(price, { at: e.ts, speed: e.speed, batch: e.batch });
    const visibleExcess = Math.max(0, e.outputTokens - e.thinkingTokens - median2);
    saving += visibleExcess * r.outputPerM / M2;
  }
  if (saving < 0.01)
    return null;
  const currentUsd = big.reduce((s, e) => s + e.cost.total, 0);
  const truncated = big.filter((e) => e.stopReason === "max_tokens").length;
  return build(ctx, {
    rule: "oversized-output",
    why: "Output tokens are the most expensive tokens, around five times the input rate, and these answers are outliers in length.",
    category: "context-bloat",
    title: `${big.length} responses exceeded ${tokens(p95)} output tokens`,
    detail: `Output tokens are the most expensive tokens you buy, typically five times the input rate. These responses are in the top 5% by length against a median of ${tokens(median2)}.${truncated > 0 ? ` ${truncated} hit the max_tokens ceiling, so they were cut off mid-answer and paid for in full.` : ""}`,
    currentUsd,
    optimizedUsd: currentUsd - saving,
    events: big,
    evidence: evidence("measured", "Output tokens and rates are both recorded"),
    confidence: confidenceOf({ measured: true, sample: big.length, tokenProfileStable: false }),
    impact: "medium",
    risk: "needs-verification",
    assumptions: [
      `Output beyond the median (${tokens(median2)}) was longer than the task required.`,
      "Reasoning tokens are excluded here; they are covered by the reasoning-effort rule.",
      "Calls that wrote or edited a file are left out: their output is the file.",
      "A shorter response would still have satisfied the request."
    ],
    calculation: `Responses above the 95th percentile (${tokens(p95)}) are selected, then charged (visible output tokens - median ${tokens(median2)}) x the model's output rate.`,
    observations: big.sort((a, b) => b.outputTokens - a.outputTokens).slice(0, 5).map((e) => `${modelLabel(e.model)} \xB7 ${tokens(e.outputTokens)} out${e.stopReason === "max_tokens" ? " (truncated)" : ""} \xB7 ${usd(e.cost.total)}`),
    fix: "Set an explicit length budget in the prompt and a max_tokens that matches it. Where output is truncated, the request is too broad: split it rather than raising the ceiling."
  });
}
var MIN_BLIND_RETRIES = 3;
function errorLoops(ctx) {
  let wasted = 0;
  const loops = /* @__PURE__ */ new Map();
  const touched = /* @__PURE__ */ new Set();
  for (const events2 of contexts(ctx)) {
    let changes = 0;
    const failed2 = /* @__PURE__ */ new Map();
    for (let i = 0; i < events2.length; i++) {
      const e = events2[i];
      const remaining = events2.length - i - 1;
      const rate = inputRateOf(e);
      const policy = cachePolicyOf(e);
      for (const t of e.tools) {
        if (!t.isError) {
          if (isMutating(t))
            changes++;
          failed2.delete(t.signature);
          continue;
        }
        const prev = failed2.get(t.signature);
        if (!prev || prev.at !== changes) {
          failed2.set(t.signature, { at: changes, streak: 1 });
          continue;
        }
        prev.streak++;
        const tk = resultTokensOf(t);
        wasted += tk * rate * (policy.write5m + remaining * policy.read) / M2 + e.cost.output * 0.25;
        const agg = loops.get(t.signature) ?? {
          repeats: 0,
          streak: 0,
          label: commandOf(t) ?? `${t.name} ${shortPath(t.target ?? t.signature)}`,
          sessions: /* @__PURE__ */ new Set()
        };
        agg.repeats++;
        agg.streak = Math.max(agg.streak, prev.streak);
        agg.sessions.add(e.sessionId);
        loops.set(t.signature, agg);
        touched.add(e);
      }
    }
  }
  const total = [...loops.values()].reduce((a, b) => a + b.repeats, 0);
  if (wasted < 5e-3 || total < MIN_BLIND_RETRIES)
    return null;
  const events = [...touched];
  const currentUsd = events.reduce((s, e) => s + e.cost.total, 0);
  const top = [...loops.values()].sort((a, b) => b.repeats - a.repeats).slice(0, 5);
  const worst = top[0];
  return build(ctx, {
    rule: "error-loops",
    why: "A blind retry can only fail the same way: you pay for the error and for the turn that produced it, and both stay in context.",
    category: "retries",
    title: `${total} retries of a failing command with nothing changed in between`,
    detail: `A command failed and was run again exactly as before, with no edit or other change in between, so it could only fail the same way. The worst ran ${worst.streak} times in a row. Retrying after a fix is normal debugging and is not counted. Each blind retry pays for the error output entering context and for the turn that produced it.`,
    currentUsd,
    optimizedUsd: currentUsd - wasted,
    events,
    evidence: evidence("measured", "Failed results were counted directly from the transcript"),
    confidence: confidenceOf({ measured: true, sample: total, tokenProfileStable: true }),
    impact: "none",
    risk: "safe",
    assumptions: [
      "A retry with the same arguments and nothing changed since the last failure was avoidable.",
      "A quarter of the retry turn's output tokens are attributable to the retry."
    ],
    calculation: "Per blind retry: error tokens x input rate x (cache-write + remaining calls x cache-read), plus 25% of that turn's output cost.",
    observations: top.map((l) => `${l.label.slice(0, 60)}: ${l.repeats} blind retr${l.repeats === 1 ? "y" : "ies"}, up to ${l.streak} in a row${l.sessions.size > 1 ? `, in ${l.sessions.size} sessions` : ""}`),
    fix: "When something fails twice, stop and change the approach: read the error, fix the cause, or ask Claude to try a different route. Starting a fresh conversation also clears the failed attempts from context. The optimAIzr mod holds a third identical attempt automatically."
  });
}
function oversizedResults(ctx) {
  const THRESHOLD_TOKENS = 1e4;
  let wasted = 0;
  const offenders = [];
  const touched = /* @__PURE__ */ new Set();
  for (const events2 of ctx.sessions.values()) {
    for (let i = 0; i < events2.length; i++) {
      const e = events2[i];
      const remaining = events2.length - i - 1;
      const rate = inputRateOf(e);
      const policy = cachePolicyOf(e);
      for (const t of e.tools) {
        const tk = resultTokensOf(t);
        if (tk < THRESHOLD_TOKENS)
          continue;
        const excess = tk - THRESHOLD_TOKENS;
        const cost = excess * rate * (policy.write5m + remaining * policy.read) / M2;
        wasted += cost;
        offenders.push({ sig: t.signature, tokens: tk, cost });
        touched.add(e);
      }
    }
  }
  if (wasted < 0.01)
    return null;
  offenders.sort((a, b) => b.cost - a.cost);
  const events = [...touched];
  const currentUsd = events.reduce((s, e) => s + e.cost.total, 0);
  return build(ctx, {
    rule: "oversized-tool-output",
    why: "A huge tool result stays in context and is re-read by every call after it.",
    category: "context-bloat",
    title: `${offenders.length} tool results larger than 10K tokens`,
    detail: "Large tool output is paid for once on the way in and then on every subsequent call in the session. A single unfiltered log dump or full-file read can dominate a session's input bill.",
    currentUsd,
    optimizedUsd: currentUsd - wasted,
    events,
    evidence: evidence("measured", "Result sizes were measured, images by pixel area"),
    confidence: confidenceOf({
      measured: true,
      sample: offenders.length,
      tokenProfileStable: true
    }),
    impact: "low",
    risk: "safe",
    assumptions: [
      "A 10,000-token result is a reasonable ceiling; only the excess is counted as waste.",
      "The oversized result could have been filtered at the source without losing what mattered."
    ],
    calculation: "Per result: (result tokens - 10,000) x input rate x (cache-write + remaining calls x cache-read).",
    observations: offenders.slice(0, 5).map((o) => `${shortPath(o.sig).slice(0, 60)}: ${tokens(o.tokens)} tok, ${usd(o.cost)}`),
    fix: "Filter at the source: grep instead of cat, head/tail on logs, offset+limit on large files. Cap tool output and return a pointer to the full result rather than the result itself."
  });
}
function thinkingSpend(ctx) {
  let thinkingCost = 0;
  let shallowCost = 0;
  const events = [];
  for (const e of ctx.data.events) {
    if (e.thinkingTokens <= 0 || e.outputTokens <= 0)
      continue;
    const cost = e.cost.output * (e.thinkingTokens / e.outputTokens);
    thinkingCost += cost;
    const visible2 = e.outputTokens - e.thinkingTokens;
    const task = ctx.taskOf.get(e.id);
    const quickJob = task ? task.done && MECHANICAL_TASKS.has(task.shape) : true;
    if (quickJob && e.thinkingTokens > 500 && visible2 < 150 && e.tools.length <= 1) {
      shallowCost += cost;
      events.push(e);
    }
  }
  if (shallowCost < 0.01 || events.length < 5)
    return null;
  const currentUsd = events.reduce((s, e) => s + e.cost.total, 0);
  return build(ctx, {
    rule: "reasoning-effort",
    why: "Thinking is billed as output, the most expensive tokens, and here it led to a short answer.",
    category: "reasoning",
    title: `${events.length} calls spent heavy reasoning on trivial output`,
    detail: `Reasoning tokens bill at the output rate. These calls thought for 500+ tokens and then produced under 150 tokens of visible output with at most one tool call: deliberation that did not change what the model did. Total reasoning spend in the window was ${usd(thinkingCost)}.`,
    currentUsd,
    optimizedUsd: currentUsd - shallowCost,
    events,
    evidence: evidence("estimated", "Reasoning tokens are measured; that they were unnecessary is an assumption"),
    confidence: confidenceOf({
      measured: true,
      sample: events.length,
      tokenProfileStable: false
    }),
    impact: "high",
    risk: "needs-verification",
    assumptions: [
      "Lowering effort removes the reasoning tokens without changing the visible answer.",
      "These calls stay shallow in future traffic. Some may have needed the reasoning.",
      "Reasoning tokens are billed at the model's output rate."
    ],
    calculation: "Per call: output cost x (reasoning tokens / total output tokens), summed over calls with 500+ reasoning tokens and under 150 visible output tokens.",
    observations: [
      `${events.length} shallow-output reasoning calls costing ${usd(shallowCost)}`,
      `Reasoning is ${(thinkingCost / Math.max(1e-9, ctx.totalCost) * 100).toFixed(1)}% of total spend`
    ],
    fix: "Lower the effort level for this class of call, or route it to a model without always-on reasoning. Reserve high effort for turns that plan multi-step work.",
    candidate: {
      kind: "lower-effort",
      from: "high",
      to: "low",
      matches: (e) => e.thinkingTokens > 500 && e.outputTokens - e.thinkingTokens < 150 && e.tools.length <= 1,
      description: "Reduce reasoning effort on shallow-output calls"
    }
  });
}
function spendConcentration(ctx) {
  if (ctx.data.events.length < 50)
    return null;
  const bySession = /* @__PURE__ */ new Map();
  for (const e of ctx.data.events) {
    const agg = bySession.get(e.sessionId) ?? { cost: 0, project: e.project, calls: 0 };
    agg.cost += e.cost.total;
    agg.calls++;
    bySession.set(e.sessionId, agg);
  }
  const ranked = [...bySession.entries()].sort((a, b) => b[1].cost - a[1].cost);
  if (ranked.length < 5)
    return null;
  const target = ctx.totalCost * 0.8;
  let running = 0;
  let count = 0;
  for (const [, v] of ranked) {
    running += v.cost;
    count++;
    if (running >= target)
      break;
  }
  const shareOfWorkloads = count / ranked.length;
  if (shareOfWorkloads > 0.35)
    return null;
  const topIds = ranked.slice(0, count).map(([id]) => id);
  const events = ctx.data.events.filter((e) => topIds.includes(e.sessionId));
  return build(ctx, {
    rule: "spend-concentration",
    why: "A few workloads decide most of your bill, so that is where any change moves it.",
    category: "concentration",
    title: `${(shareOfWorkloads * 100).toFixed(0)}% of your workloads drive 80% of spend`,
    detail: `${count} of ${ranked.length} sessions account for ${usd(running)} of ${usd(ctx.totalCost)}. That is not waste: it is where optimisation effort actually pays back. A fix applied to these sessions is worth several times the same fix applied anywhere else.`,
    currentUsd: running,
    optimizedUsd: running,
    events,
    advisory: true,
    evidence: evidence("measured", "Spend per session summed directly from recorded costs"),
    confidence: confidenceOf({
      measured: true,
      sample: events.length,
      tokenProfileStable: true
    }),
    impact: "none",
    risk: "safe",
    severityOverride: "low",
    assumptions: ["Sessions are a reasonable proxy for a workload."],
    calculation: "Sessions ranked by total cost; counted until the running total reaches 80% of spend.",
    observations: ranked.slice(0, 5).map(([id, v]) => `${v.project.split("/").slice(-1)[0]} \xB7 ${id.slice(0, 8)}: ${usd(v.cost)} across ${v.calls} calls`),
    fix: "Target the findings above at these workloads first. Optimising the long tail is rarely worth the engineering time."
  });
}
function costSpike(ctx) {
  const summary = summarize(ctx.data);
  const days = summary.byDay;
  if (days.length < 5)
    return null;
  const costs = days.map((d) => d.cost.total);
  const median2 = [...costs].sort((a, b) => a - b)[Math.floor(costs.length / 2)];
  if (median2 <= 0)
    return null;
  const spikes = days.filter((d) => d.cost.total > median2 * 2.5);
  if (spikes.length === 0)
    return null;
  const worst = spikes.sort((a, b) => b.cost.total - a.cost.total)[0];
  const medianCalls = [...days.map((d) => d.calls)].sort((a, b) => a - b)[Math.floor(days.length / 2)] || 1;
  const callRatio = worst.calls / medianCalls;
  const costRatio = worst.cost.total / median2;
  const explainedByVolume = callRatio > 0 && costRatio / callRatio < 1.4;
  if (explainedByVolume)
    return null;
  const events = ctx.data.events.filter((e) => e.ts.slice(0, 10) === worst.key);
  const perCall = worst.calls > 0 ? worst.cost.total / worst.calls : 0;
  const overallPerCall = summary.avgCostPerCall;
  return build(ctx, {
    rule: "cost-spike",
    why: "A spike usually has one cause, such as a runaway loop or a huge input, and it recurs until that cause is found.",
    category: "anomaly",
    title: `Spend on ${worst.key} was ${costRatio.toFixed(1)}x the daily median`,
    detail: `${usd(worst.cost.total)} against a median day of ${usd(median2)}, but only ${callRatio.toFixed(1)}x the usual call volume, so the cost per call rose to ${usd(perCall)} against ${usd(overallPerCall)} overall. Volume does not explain this one. optimAIzr cannot tell you why from usage data alone; it can only tell you it happened.`,
    currentUsd: worst.cost.total - median2,
    optimizedUsd: worst.cost.total - median2,
    events,
    advisory: true,
    evidence: evidence("inferred", "Daily totals are measured; 'unexplained' means unexplained by call volume alone"),
    confidence: confidenceOf({
      measured: true,
      sample: events.length,
      tokenProfileStable: true
    }),
    impact: "none",
    risk: "safe",
    severityOverride: "medium",
    assumptions: [
      "Call volume is the main thing that should move daily cost.",
      "A single unusual day may be entirely legitimate work."
    ],
    calculation: "Days above 2.5x the median daily cost, excluding those where cost rose roughly in line with call volume.",
    observations: [
      `${worst.key}: ${usd(worst.cost.total)} across ${worst.calls} calls (${usd(perCall)}/call)`,
      `Median day: ${usd(median2)} across ${medianCalls} calls`,
      ...spikes.filter((s) => s.key !== worst.key).slice(0, 3).map((s) => `${s.key}: ${usd(s.cost.total)} across ${s.calls} calls`)
    ],
    fix: "Check what changed that day: a new model, a longer prompt, a retry loop, or a backfill. `optimaizr show cost-spike` lists that day's priciest calls."
  });
}
function pricingChange(ctx) {
  const summary = summarize(ctx.data);
  for (const bucket of summary.byModel) {
    const price = priceFor(bucket.key);
    if (!price || price.rates.length < 2)
      continue;
    const events = ctx.data.events.filter((e) => e.model === bucket.key);
    if (events.length === 0)
      continue;
    let billed = 0;
    let atCurrentRates = 0;
    const now = /* @__PURE__ */ new Date();
    for (const e of events) {
      const then = ratesFor(price, { at: e.ts, speed: e.speed, batch: e.batch });
      const current = ratesFor(price, { at: now, speed: e.speed, batch: e.batch });
      const priceOut = (r) => (e.inputTokens * r.inputPerM + e.outputTokens * r.outputPerM + e.cacheReadTokens * r.cachedInputPerM + e.cacheWrite5mTokens * r.cacheWrite5mPerM + e.cacheWrite1hTokens * r.cacheWrite1hPerM) / M2;
      billed += priceOut(then);
      atCurrentRates += priceOut(current);
    }
    const delta = atCurrentRates - billed;
    if (delta < 0.01)
      continue;
    const oldCard = price.rates[price.rates.length - 2];
    const newCard = price.rates[price.rates.length - 1];
    return build(ctx, {
      rule: "pricing-change",
      why: "The same traffic now costs a different amount, whatever you do.",
      category: "pricing",
      title: `${price.label} ${oldCard.label ?? "previous pricing"} ended ${oldCard.until ?? newCard.from}`,
      detail: `Your ${price.label} traffic in this window was largely billed at $${oldCard.inputPerM}/$${oldCard.outputPerM} per million. At the current $${newCard.inputPerM}/$${newCard.outputPerM} the same usage costs ${usd(atCurrentRates)} instead of ${usd(billed)}, a ${(delta / billed * 100).toFixed(0)}% increase that arrives without any change on your side.`,
      currentUsd: delta,
      optimizedUsd: 0,
      events,
      advisory: true,
      evidence: evidence("measured", "Every call re-priced against both rate cards"),
      confidence: confidenceOf({
        measured: true,
        sample: events.length,
        tokenProfileStable: true
      }),
      impact: "none",
      risk: "safe",
      severityOverride: "medium",
      assumptions: [
        "Future usage resembles the usage in this window.",
        "No further rate change lands in the meantime."
      ],
      calculation: "Every call re-priced at the current rate card and compared with what it was actually billed at the time.",
      observations: [
        `${bucket.calls} calls \xB7 ${tokens(bucket.inputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens)} in / ${tokens(bucket.outputTokens)} out`,
        `Same usage: ${usd(billed)} as billed vs ${usd(atCurrentRates)} at current rates`
      ],
      fix: "Budget for the higher rate, and re-check the cheap-model and caching findings: they are worth proportionally more once the old rate lapses."
    });
  }
  return null;
}
var LEVER_CONFIDENCE = {
  level: "low",
  basis: "the arithmetic uses recorded tokens, but the saving depends on a change in how you work, and its effect on quality is untested; possible until a before/after shows it"
};
var COMPACT_AT = 2e5;
var COMPACT_LATER = [3e5, 4e5, 6e5];
var AFTER_COMPACT = 4e4;
var SUMMARY_TOKENS = 8e3;
var LONG_CALL_SHARE = 0.2;
var AGENTS = ["claude-code", "codex"];
var AGENT_NAME = { "claude-code": "Claude Code", codex: "Codex" };
function compactSetting(agent) {
  return agent === "claude-code" ? `Claude Code: add "env": { "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "${COMPACT_AT}" } to ~/.claude/settings.json, and it compacts a little before that point` : `Codex: set model_auto_compact_token_limit = ${COMPACT_AT} in ~/.codex/config.toml`;
}
function kLabel(tokens2) {
  return `${Math.round(tokens2 / 1e3)}K`;
}
function replayCompaction(ctx, agents, at) {
  let saved = 0;
  let compactionCost = 0;
  let compactions = 0;
  let rereadUsd = 0;
  const events = [];
  let hourWrites = 0;
  let allWrites = 0;
  for (const conversation of contexts(ctx)) {
    const first = conversation[0];
    if (!first || !agents.includes(first.source) || first.isSubagent)
      continue;
    const w1 = conversation.reduce((s, e) => s + e.cacheWrite1hTokens, 0);
    const w5 = conversation.reduce((s, e) => s + e.cacheWrite5mTokens, 0);
    hourWrites += w1;
    allWrites += w1 + w5;
    let dropped = 0;
    let last = 0;
    for (const e of conversation) {
      const price = priceFor(e.model);
      if (!price)
        continue;
      const r = ratesFor(price, { at: e.ts, speed: e.speed, batch: e.batch });
      const writeRate = w1 > w5 ? r.cacheWrite1hPerM : Math.max(r.inputPerM, r.cacheWrite5mPerM);
      rereadUsd += e.cacheReadTokens * r.cachedInputPerM / M2;
      const actual = contextOf(e);
      if (actual < last * 0.5)
        dropped = 0;
      last = actual;
      if (actual - dropped > at) {
        compactions++;
        compactionCost += (at * r.cachedInputPerM + SUMMARY_TOKENS * r.outputPerM + AFTER_COMPACT * (writeRate - r.cachedInputPerM)) / M2;
        dropped = actual - AFTER_COMPACT;
      }
      const fewer = Math.max(0, Math.min(dropped, actual - AFTER_COMPACT, e.cacheReadTokens));
      if (fewer > 0) {
        saved += fewer * r.cachedInputPerM / M2;
        events.push(e);
      }
    }
  }
  return { saved, cost: compactionCost, compactions, rereadUsd, events, hourWrites, allWrites };
}
function realCompactions(ctx) {
  const all = (ctx.data.compactions ?? []).filter((c2) => c2.source === "claude-code");
  if (all.length === 0)
    return null;
  const auto = all.filter((c2) => c2.trigger === "auto").length;
  const mid = all.filter((c2) => c2.midTask).length;
  const waitMs = all.reduce((t, c2) => t + (c2.durationMs ?? 0), 0);
  const wait = waitMs >= 6e4 ? duration(waitMs / 6e4) : `${Math.round(waitMs / 1e3)}s`;
  return `Claude Code compacted ${all.length} time${all.length === 1 ? "" : "s"}: ${auto} automatic, ${mid} mid-task, ${wait} waiting for summaries`;
}
function contextCompaction(ctx) {
  const compactAt = kLabel(COMPACT_AT);
  const agents = AGENTS.filter((a) => {
    const calls = ctx.data.events.filter((e) => e.source === a);
    const long2 = calls.filter((e) => contextOf(e) > COMPACT_AT).length;
    return calls.length >= 50 && long2 / calls.length >= LONG_CALL_SHARE;
  });
  if (agents.length === 0)
    return null;
  const mine = ctx.data.events.filter((e) => agents.includes(e.source));
  const long = mine.filter((e) => contextOf(e) > COMPACT_AT).length;
  const { saved, cost: compactionCost, compactions, rereadUsd, events, hourWrites, allWrites } = replayCompaction(ctx, agents, COMPACT_AT);
  const net = saved - compactionCost;
  if (net < 0.5 || events.length === 0)
    return null;
  const later = COMPACT_LATER.map((at) => {
    const r = replayCompaction(ctx, agents, at);
    const n = r.saved - r.cost;
    return `${kLabel(at)} ${n > 0 ? `${usd(n)} less` : "no saving"}`;
  });
  const real = agents.includes("claude-code") ? realCompactions(ctx) : null;
  const names = listOf(agents.map((a) => AGENT_NAME[a]));
  const sizes = mine.map(contextOf).sort((a, b) => a - b);
  const median2 = sizes[Math.floor(sizes.length / 2)];
  const p90 = sizes[Math.floor(sizes.length * 0.9)];
  const spend = mine.reduce((t, e) => t + e.cost.total, 0);
  const currentUsd = events.reduce((t, e) => t + e.cost.total, 0);
  return build(ctx, {
    rule: "context-compaction",
    why: `Every call re-reads the whole conversation, so each call costs more than the last: re-reading took ${spend > 0 ? Math.round(rereadUsd / spend * 100) : 0}% of your ${names} spend.`,
    tier: "test",
    category: "context-bloat",
    title: `${Math.round(long / mine.length * 100)}% of your ${names} calls carried over ${compactAt} of conversation`,
    detail: `Your median call re-read ${tokens(median2)} of conversation and 1 in 10 re-read ${tokens(p90)}: ${agents.length > 1 ? "both agents compact" : `${names} compacts`} only near the model's context window. Compacting at ${compactAt} would have meant about ${compactions} compaction${compactions === 1 ? "" : "s"} and ${usd(net)} less over this window, after paying for them.`,
    currentUsd,
    optimizedUsd: currentUsd - net,
    events,
    evidence: evidence("estimated", "Context sizes are measured; the compactions and what they keep are simulated"),
    confidence: LEVER_CONFIDENCE,
    impact: "medium",
    risk: "needs-verification",
    assumptions: [
      `A compacted conversation starts again at about ${tokens(AFTER_COMPACT)}: the summary, the system prompt and recently read files.`,
      `Each compaction costs one summary call over ${compactAt} of context, writing about ${tokens(SUMMARY_TOKENS)} tokens, and one reload of what remains, written to the cache again${hourWrites > allWrites / 2 ? " at the 1-hour write rate your conversations use" : ""}.`,
      "The work after a compaction takes as many calls as it did. A summary can lose details from early in the conversation, which can cost calls back.",
      "Subagents are left out: they start with a fresh context."
    ],
    calculation: `Each main conversation replayed in order: when its context passes ${compactAt}, it compacts to ${tokens(AFTER_COMPACT)} and the compaction is charged; every later call re-reads that much less, priced at its own cache-read rate. Where the agent compacted on its own, the replay starts over from there.`,
    observations: [
      `median call: ${tokens(median2)} of conversation, 90th percentile: ${tokens(p90)}`,
      `${compactions} compaction${compactions === 1 ? "" : "s"} at ${compactAt} would have cost ${usd(compactionCost)} and saved ${usd(saved)} of re-reading`,
      `compacting later instead: ${later.join(", ")}`,
      ...real ? [real] : []
    ],
    fix: `Compact at ${compactAt}. ${agents.map(compactSetting).join("; ")}. The saving already pays for each summary and the cache it rebuilds. A lower point compacts more often, and automatic compaction usually lands mid-task, so the safer habit is to compact by hand when you finish a piece of work, saying what to keep (/compact keep the API decisions). To keep more of each conversation, pick a later point: optimaizr apply context-compaction --at 400K. A summary can drop details from early in a long conversation, so try it for a week and compare.`
  });
}
var FRESH_START = 3e4;
var HANDOFF_TOKENS = 1500;
var COLD_MIN = 3;
function duration(minutes) {
  if (minutes < 60)
    return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 && h < 10 ? `${h}h ${m}m` : `${h}h`;
}
function coldResume(ctx) {
  const cold = coldResumes(ctx.data.events);
  if (cold.length < COLD_MIN)
    return null;
  let saving = 0;
  let rewriteUsd = 0;
  let warmUsd = 0;
  let rates = null;
  let costliest = 0;
  for (const c2 of cold) {
    const price = priceFor(c2.event.model);
    if (!price || c2.rewriteTokens <= 0)
      continue;
    const r = ratesFor(price, { at: c2.event.ts, speed: c2.event.speed, batch: c2.event.batch });
    if (c2.rewriteUsd > costliest) {
      costliest = c2.rewriteUsd;
      rates = r;
    }
    const perToken = c2.rewriteUsd / c2.rewriteTokens;
    const note = (contextOf(c2.previous) * r.cachedInputPerM + HANDOFF_TOKENS * r.outputPerM) / M2;
    const fresh = (FRESH_START + HANDOFF_TOKENS) * perToken;
    saving += Math.max(0, c2.rewriteUsd - fresh - note);
    rewriteUsd += c2.rewriteUsd;
    warmUsd += c2.warmUsd;
  }
  if (saving < 0.5)
    return null;
  const events = cold.map((c2) => c2.event);
  const currentUsd = events.reduce((s, e) => s + e.cost.total, 0);
  const tokens2 = cold.reduce((s, c2) => s + c2.rewriteTokens, 0);
  const gaps = cold.map((c2) => c2.gapMinutes).sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  const auto = cold.filter((c2) => c2.ttlMinutes === null).length > cold.length / 2;
  const hour = cold.filter((c2) => c2.ttlMinutes === 60).length >= cold.length / 2;
  const ttl = hour ? "an hour" : "5 minutes";
  const times = (rate) => rates && rates.inputPerM > 0 ? `${+(rate / rates.inputPerM).toFixed(2)}x` : "";
  const writeX = rates ? times(hour ? rates.cacheWrite1hPerM : rates.cacheWrite5mPerM) : "";
  const readX = rates ? times(rates.cachedInputPerM) : "";
  const handoff = events.some((e) => e.source === "claude-code") ? " With the optimAIzr mod, /optimaizr handoff writes the note, and the next conversation after /clear starts from it." : "";
  const why = auto ? `OpenAI keeps a conversation cached only while it is in use, and after a few idle minutes it can be gone. Come back later and the next call sends all of it again at the full input rate${readX ? `, where reading it from cache would have cost ${readX}` : ""}.` : `The cache keeps a conversation for ${ttl}. Come back later and the next call writes all of it again${writeX && readX ? ` at ${writeX} the input rate, where reading it would have cost ${readX}` : ", where reading it would have cost a fraction"}.`;
  const away = auto ? "step away" : `stop for more than ${ttl}`;
  return build(ctx, {
    rule: "cold-resume",
    why,
    tier: "try",
    category: "caching",
    title: `${cold.length} returns to an expired cache ${auto ? "resent" : "rewrote"} ${tokens(tokens2)} of conversation`,
    detail: `You came back to a long conversation ${cold.length} times after its cache had expired (median gap ${duration(medianGap)}). Each time the first call ${auto ? "sent the whole conversation again uncached" : "wrote the whole conversation into the cache again"}, ${tokens(tokens2 / cold.length)} on average: ${usd(rewriteUsd)} in all, where a warm cache would have read it for ${usd(warmUsd)}. A fresh session started from a short handoff note would have cost ${usd(saving)} less.`,
    currentUsd,
    optimizedUsd: currentUsd - saving,
    events,
    evidence: evidence("inferred", auto ? "The resends are measured from recorded uncached input; the size of a fresh start is an estimate" : "The rewrites are measured from recorded cache writes; the size of a fresh start is an estimate"),
    confidence: confidenceOf({ measured: true, sample: cold.length, tokenProfileStable: true }),
    impact: "medium",
    risk: "needs-verification",
    assumptions: [
      `A fresh session starts at about ${tokens(FRESH_START)}: system prompt, tools and memory files, plus up to ${tokens(HANDOFF_TOKENS)} tokens of handoff note.`,
      "The note is written before you leave, while the cache is still warm, and is charged.",
      "A note keeps less than the full conversation, which can cost calls back. Only the first call back is counted, not the cheaper calls after it."
    ],
    calculation: `For each return after the cache expired (main conversation, ${tokens(COLD_MIN_CONTEXT)}+ of context, most of it written or sent again): the recorded cost of that call's uncached input, minus a fresh start of ${tokens(FRESH_START + HANDOFF_TOKENS)} at the same rate, minus the note (one cached read of the conversation and ${tokens(HANDOFF_TOKENS)} output tokens).`,
    observations: [...cold].sort((a, b) => b.rewriteUsd - a.rewriteUsd).slice(0, 5).map((c2) => `${c2.event.ts.slice(0, 10)} \xB7 back after ${duration(c2.gapMinutes)} \xB7 ${c2.ttlMinutes === null ? "resent" : "rewrote"} ${tokens(c2.rewriteTokens)} \xB7 ${usd(c2.rewriteUsd)}`),
    fix: `Before you ${away} in the middle of a long conversation, ask for a three-line handoff note (done, next, and the file to start from), then /clear and start from the note when you return.${handoff}`
  });
}
function familyAlias(modelId) {
  return /haiku|sonnet|opus|fable/.exec(modelId.toLowerCase())?.[0] ?? modelId;
}
function defaultSetting(agent, target) {
  if (agent === "claude-code") {
    const alias = familyAlias(target.id);
    return `Claude Code: /model ${alias}, or "model": "${alias}" in ~/.claude/settings.json`;
  }
  return `Codex: model = "${target.id}" in ~/.codex/config.toml, or /model`;
}
function modelDefault(ctx) {
  let before = 0;
  let after = 0;
  let frontierSpend = 0;
  const counted = [];
  const targets = /* @__PURE__ */ new Map();
  const sources = /* @__PURE__ */ new Set();
  const byAgent = /* @__PURE__ */ new Map();
  for (const t of ctx.tasks) {
    if (!AGENTS.includes(t.source))
      continue;
    const price = priceFor(t.model);
    if (!price || price.tier !== "frontier")
      continue;
    frontierSpend += t.costUsd;
    if (!t.done || t.kind === "reasoning" || t.kind === "debugging")
      continue;
    const target = downgradeTargetFor(t.model);
    if (!target || t.maxContext > target.contextTokens * 0.9)
      continue;
    for (const e of t.events) {
      const from2 = priceFor(e.model);
      const to = downgradeTargetFor(e.model);
      if (!from2 || !to)
        continue;
      const r = repriced(e, from2, to);
      before += r.before;
      after += Math.min(r.after, r.before);
    }
    counted.push(t);
    targets.set(target.id, target);
    sources.add(price.label);
    if (!byAgent.has(t.source))
      byAgent.set(t.source, target);
  }
  const saving = before - after;
  if (counted.length < 10 || saving < 0.5)
    return null;
  const events = counted.flatMap((t) => t.events);
  const names = listOf([...targets.values()].map((t) => t.label));
  const from = listOf([...sources]);
  const spentOn = counted.reduce((s, t) => s + t.costUsd, 0);
  const settings = AGENTS.filter((a) => byAgent.has(a)).map((a) => defaultSetting(a, byAgent.get(a)));
  return build(ctx, {
    rule: "model-default",
    why: `${names} ${targets.size > 1 ? "do" : "does"} the same tokens for ${before > 0 ? Math.round(saving / before * 100) : 0}% less, and work without heavy reasoning is where a smaller model most often keeps up.`,
    tier: "test",
    category: "model-selection",
    title: `${frontierSpend > 0 ? Math.round(spentOn / frontierSpend * 100) : 0}% of your ${from} spend went to tasks without heavy reasoning`,
    detail: `${counted.length} tasks on ${from} (${kindMix(counted)}) thought for under ${tokens(TASK_REASONING_TOKENS)} tokens and failed at most once. On ${names} the same tokens cost ${usd(after)} instead of ${usd(before)}, ${before > 0 ? Math.round(saving / before * 100) : 0}% less, if ${names} does the work as well.`,
    currentUsd: before,
    optimizedUsd: after,
    events,
    evidence: evidence("estimated", `Recorded tokens re-priced on ${names}; whether the work comes out as well is untested`),
    confidence: LEVER_CONFIDENCE,
    impact: "high",
    risk: "needs-verification",
    assumptions: [
      `${names} does these tasks as well, in a similar number of tokens.`,
      "Sessions start on the smaller model, so there is no cache reload; switching up for a hard task costs one.",
      "Tasks with heavy reasoning or repeated failures stay on the bigger model and are not counted."
    ],
    calculation: `Every finished agent task on ${from} without heavy reasoning or repeated failures, each call re-priced one tier down (${names}) at the rates of its day.`,
    observations: [
      `${counted.length} of your ${from} tasks qualify: ${kindMix(counted)}`,
      `kept on ${from}: tasks with ${tokens(TASK_REASONING_TOKENS)}+ thinking tokens or two or more failures`
    ],
    fix: `Make the smaller model your default and switch up for debugging, design and hard problems. ${settings.join("; ")}. \`optimaizr verify model-default\` replays a sample of your own calls on it first${byAgent.has("claude-code") ? "; `optimaizr live --auto` with the mod switches Claude Code as you go" : ""}.`,
    candidate: {
      kind: "swap-model",
      to: targets.size === 1 ? [...targets.keys()][0] : void 0,
      targetFor: (modelId) => downgradeTargetFor(modelId)?.id,
      matches: (e) => {
        const task = ctx.taskOf.get(e.id);
        return task ? counted.includes(task) : false;
      },
      description: `Make ${names} the default for work without heavy reasoning`
    }
  });
}
var RULES = [
  { name: "pricing-change", run: pricingChange },
  { name: "cost-spike", run: costSpike },
  { name: "spend-concentration", run: spendConcentration },
  { name: "cache-churn", run: cacheChurn },
  { name: "repeated-context", run: repeatedContext },
  { name: "prompt-bloat", run: promptBloat },
  { name: "repeat-tool-calls", run: repeatToolCalls },
  { name: "model-fit", run: modelFit },
  { name: "reasoning-effort", run: thinkingSpend },
  { name: "oversized-input", run: oversizedInput },
  { name: "oversized-output", run: oversizedOutput },
  { name: "oversized-tool-output", run: oversizedResults },
  { name: "error-loops", run: errorLoops },
  { name: "cold-resume", run: coldResume },
  { name: "context-compaction", run: contextCompaction },
  { name: "model-default", run: modelDefault }
];
function analyze(data) {
  if (data.events.length === 0)
    return { findings: [], errors: [] };
  const ctx = buildCtx(data);
  const findings = [];
  const errors = [];
  for (const rule of RULES) {
    try {
      const f = rule.run(ctx);
      if (f)
        findings.push(f);
    } catch (err) {
      errors.push({
        rule: rule.name,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }
  findings.sort((a, b) => b.savings.monthlyUsd - a.savings.monthlyUsd);
  return { findings, errors };
}
function ruleErrorWarning(e) {
  return `detector "${e.rule}" failed and was skipped - its findings are missing from this report: ${e.message}`;
}
function findWaste(data) {
  const { findings, errors } = analyze(data);
  for (const e of errors) {
    const warning = ruleErrorWarning(e);
    if (!data.warnings.includes(warning))
      data.warnings.push(warning);
  }
  return findings;
}
var RULE_COUNT = RULES.length;

// ../../packages/core/dist/analyze/plan.js
var PLANS = {
  pro: { label: "Claude Pro", priceUsd: 20, perSeat: false },
  max5: { label: "Claude Max 5x", priceUsd: 100, perSeat: false },
  max20: { label: "Claude Max 20x", priceUsd: 200, perSeat: false },
  team: { label: "Claude Team Standard", priceUsd: 25, perSeat: true },
  "team-premium": { label: "Claude Team Premium", priceUsd: 125, perSeat: true }
};
var PLAN_IDS = Object.keys(PLANS);
var SESSION_HOURS = 5;
var HOUR = 36e5;
var SESSION_MS = SESSION_HOURS * HOUR;

// ../../packages/core/dist/verify/state.js
function verificationModeOf(finding) {
  if (finding.verification)
    return finding.verification;
  if (finding.risk === "safe")
    return "not-required";
  return finding.candidate ? "replay" : "manual";
}
function memoryStore() {
  let state = {};
  return {
    load: () => state,
    save: (all) => {
      state = all;
    }
  };
}
var store = memoryStore();

// ../../packages/core/dist/recommend/recommendations.js
function actionFor(f) {
  const c2 = f.candidate;
  if (f.rule === "model-default")
    return leverAction(f);
  if (c2?.kind === "swap-model" && c2.to) {
    const from = f.affected.models.map((m) => priceFor(m)?.label ?? m).join(" / ");
    const to = priceFor(c2.to)?.label ?? c2.to;
    return `Switch eligible requests from ${from} to ${to}`;
  }
  if (c2?.kind === "lower-effort")
    return "Lower reasoning effort on shallow-output requests";
  if (c2?.kind === "enable-cache")
    return "Stabilise and cache the request prefix";
  if (c2?.kind === "trim-prompt")
    return "Trim the system prompt";
  if (f.rule === "context-compaction")
    return "Compact conversations earlier";
  if (f.rule === "oversized-input")
    return "Start small jobs in a fresh context";
  if (f.rule === "cold-resume")
    return "Leave a handoff note and start fresh after a long break";
  if (f.rule === "oversized-output")
    return "Cap response length on outlier requests";
  if (f.rule === "oversized-tool-output")
    return "Filter oversized tool output at the source";
  if (f.rule === "error-loops")
    return "Stop retrying identical failing calls";
  return f.title;
}
function leverAction(f) {
  const to = f.candidate?.to ? priceFor(f.candidate.to)?.label ?? f.candidate.to : null;
  return `Make ${to ?? "a smaller model"} your default and switch up for hard problems`;
}
function rationaleFor(f, totalCalls) {
  const share = totalCalls > 0 ? f.affected.calls / totalCalls * 100 : 0;
  switch (f.rule) {
    case "model-fit":
      return `${share.toFixed(0)}% of your requests use a model whose capabilities exceed the detected workload requirements.`;
    case "reasoning-effort":
      return `${f.affected.calls} requests spent more on deliberation than on the answer they produced.`;
    case "cache-churn":
    case "repeated-context":
      return `Input that could be served from cache at a tenth of the rate or less is being paid for in full.`;
    case "repeat-tool-calls":
      return `Content already present in the session is being fetched and re-billed on every later call.`;
    case "prompt-bloat":
      return `A large system prompt is charged on every single request.`;
    case "oversized-output":
      return `Output tokens cost roughly five times input tokens, and these responses are outliers.`;
    case "oversized-input":
      return `Small jobs are inheriting a whole session's context to do their work.`;
    case "cold-resume":
      return `Coming back after the cache expired writes the whole conversation again at the cache-write rate.`;
    case "oversized-tool-output":
      return `Oversized tool results stay in context and are re-billed for the rest of the session.`;
    case "error-loops":
      return `Identical failing calls were retried without changing anything.`;
    default:
      return f.detail.split(". ")[0] + ".";
  }
}
function actionsFor(f) {
  const actions = ["view-affected", "simulate"];
  if (verificationModeOf(f) === "replay")
    actions.push("verify");
  actions.push("apply");
  return actions;
}
function memoryStore2() {
  let state = {};
  return {
    load: () => state,
    save: (all) => {
      state = all;
    }
  };
}
var store2 = memoryStore2();
function loadDecisions() {
  try {
    return store2.load();
  } catch {
    return {};
  }
}
function setStatus(id, status, note) {
  try {
    const all = { ...loadDecisions() };
    all[id] = { id, status, at: (/* @__PURE__ */ new Date()).toISOString(), note };
    store2.save(all);
  } catch {
  }
}
function toRecommendations(findings, totalCalls) {
  const decisions = loadDecisions();
  return findings.filter((f) => !f.advisory).map((f) => ({
    id: f.rule,
    rule: f.rule,
    category: f.category,
    action: actionFor(f),
    rationale: f.why || rationaleFor(f, totalCalls),
    tier: f.tier,
    happened: f.title,
    why: f.why || rationaleFor(f, totalCalls),
    fix: f.fix,
    savings: f.savings,
    affected: f.affected,
    impact: f.impact,
    risk: f.risk,
    verification: verificationModeOf(f),
    actions: actionsFor(f),
    status: decisions[f.rule]?.status ?? "new"
  })).sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.savings.monthlyUsd - a.savings.monthlyUsd);
}

// ../../packages/core/dist/recommend/actions.js
function trafficOf(f, events) {
  const slices = /* @__PURE__ */ new Map();
  const total = /* @__PURE__ */ new Map();
  const hit = /* @__PURE__ */ new Map();
  const sliceSpend = /* @__PURE__ */ new Map();
  const sliceHit = /* @__PURE__ */ new Map();
  for (const e of events) {
    total.set(e.source, (total.get(e.source) ?? 0) + e.cost.total);
    const agent = e.source === "claude-code" ? e.isSubagent ? "sub" : "main" : "";
    const key = [e.source, e.project, e.route ?? "", e.model, agent].join("\0");
    sliceSpend.set(key, (sliceSpend.get(key) ?? 0) + e.cost.total);
    if (!f.affects(e))
      continue;
    hit.set(e.source, (hit.get(e.source) ?? 0) + e.cost.total);
    sliceHit.set(key, (sliceHit.get(key) ?? 0) + e.cost.total);
    const s = slices.get(key);
    if (s)
      s.calls++;
    else
      slices.set(key, {
        source: e.source,
        project: e.project,
        ...e.route !== void 0 ? { route: e.route } : {},
        model: e.model,
        calls: 1,
        ...agent ? { subagent: agent === "sub" } : {}
      });
  }
  for (const [key, s] of slices) {
    const all = sliceSpend.get(key) ?? 0;
    s.share = all > 0 ? (sliceHit.get(key) ?? 0) / all : 0;
  }
  const shareBySource = {};
  for (const [source, usd2] of hit) {
    const all = total.get(source) ?? 0;
    shareBySource[source] = all > 0 ? usd2 / all : 0;
  }
  return { slices: [...slices.values()], shareBySource };
}
function proposedChange(f, traffic) {
  const t = traffic ? { traffic } : {};
  const c2 = f.candidate;
  if (c2?.kind === "swap-model" && (c2.to || c2.targetFor)) {
    const from = f.affected.models.map((m) => priceFor(m)?.label ?? m).join(" / ");
    const targets = c2.to ? [c2.to] : [...new Set(f.affected.models.map((m) => c2.targetFor?.(m)).filter((m) => m !== void 0))];
    const to = targets.map((id) => priceFor(id)?.label ?? id).join(" / ");
    return {
      kind: "swap-model",
      label: `Switch to ${to}`,
      from,
      to,
      ...c2.to ? { toModelId: c2.to } : {},
      ...t
    };
  }
  if (c2?.kind === "lower-effort")
    return { kind: "lower-effort", label: "Lower reasoning effort", ...t };
  if (c2?.kind === "enable-cache")
    return { kind: "enable-cache", label: "Cache the request prefix", ...t };
  if (c2?.kind === "trim-prompt")
    return { kind: "trim-prompt", label: "Trim the system prompt", ...t };
  return { kind: "manual", label: f.fix, ...t };
}
function nextCommandFor(f) {
  switch (verificationModeOf(f)) {
    case "replay":
      return `optimaizr verify ${f.rule}`;
    case "manual":
      return `optimaizr show ${f.rule}`;
    default:
      return `optimaizr apply ${f.rule}`;
  }
}
function accept(f, opts = {}) {
  const change = proposedChange(f, opts.traffic);
  const rewriters = [...opts.rewriters ?? [], ...opts.rewriter ? [opts.rewriter] : []];
  const results = [];
  if (!opts.dryRun) {
    for (const r of rewriters) {
      let supported = false;
      try {
        supported = r.supports(change, f);
      } catch {
      }
      if (!supported)
        continue;
      try {
        results.push({ via: r.kind, ...r.install(change, f) });
      } catch (err) {
        results.push({ via: r.kind, ok: false, detail: errorText(err) });
      }
    }
  }
  const now = results.find((r) => r.now)?.now;
  const [lead, ...rest] = results.filter((r) => r.ok);
  if (lead) {
    const also = [...rest, ...results.filter((r) => !r.ok)].map((r) => ({
      via: r.via,
      applied: r.ok,
      detail: r.detail
    }));
    return {
      kind: "applied",
      via: lead.via,
      detail: lead.detail,
      ...now ? { now } : {},
      ...also.length > 0 ? { also } : {}
    };
  }
  if (results.length > 0 && results.every((r) => !r.declined)) {
    return { kind: "failed", detail: results.map((r) => r.detail).join("; ") };
  }
  if (!opts.dryRun)
    setStatus(f.rule, "viewed", "accepted from optimaizr live");
  if (results.length > 0) {
    return {
      kind: "queued",
      declined: true,
      reason: results.map((r) => r.detail).join("; "),
      next: nextCommandFor(f),
      ...now ? { now } : {}
    };
  }
  const sources = new Set(change.traffic?.slices.map((s) => s.source));
  if (change.kind === "swap-model" && sources.size === 1 && sources.has("codex")) {
    return {
      kind: "queued",
      reason: "it had already completed when optimAIzr saw it, and Codex reads its model when a session starts, so nothing outside it can switch the one running",
      next: nextCommandFor(f),
      now: "type /model in Codex to switch this session"
    };
  }
  return {
    kind: "queued",
    reason: "it had already completed when optimAIzr saw it, and no pre-request integration is installed, so nothing was changed",
    next: nextCommandFor(f)
  };
}
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

// ../../packages/core/dist/analyze/live.js
var LIVE_DEFAULTS = {
  /** Calls held in memory. Enough for the 50-event rules to reach quorum. */
  maxEvents: 500,
  /** Floor on re-analysis, so a burst of calls cannot spin the rule engine. */
  minIntervalMs: 2e3,
  /** Also re-analyse after this many calls, however fast they arrive. */
  everyNEvents: 25,
  /** Don't announce trivia. Cents over a few minutes read as noise, not advice. */
  minUsd: 0.25,
  /** Affected calls quoted under a finding, so it can be traced to an agent. */
  examples: 3,
  /** Re-announce a standing finding only once its cost has grown this much. */
  regrowth: 2,
  /** Above this probability, the judge's "needs a big model" wins. */
  frontierThreshold: 0.6
};
var JUDGEABLE_RULES = /* @__PURE__ */ new Set(["model-fit", "reasoning-effort", "thinking-spend"]);
function datasetOf(events) {
  const from = events[0]?.ts ?? "";
  const to = events[events.length - 1]?.ts ?? "";
  const days = from && to ? Math.max(0, (new Date(to).getTime() - new Date(from).getTime()) / 864e5) : 0;
  return { events, window: { from, to, days }, sources: ["live"], warnings: [] };
}
function consult(finding, events, judge) {
  let sampled = 0;
  let needs = 0;
  for (const e of events) {
    if (!finding.affects(e))
      continue;
    const p = judge(e);
    if (p === void 0)
      continue;
    sampled++;
    needs += p;
  }
  if (sampled === 0)
    return void 0;
  return { needsFrontierShare: needs / sampled, sampled };
}
function createLiveAnalyzer(opts = {}) {
  const maxEvents = opts.maxEvents ?? LIVE_DEFAULTS.maxEvents;
  const minIntervalMs = opts.minIntervalMs ?? LIVE_DEFAULTS.minIntervalMs;
  const everyNEvents = opts.everyNEvents ?? LIVE_DEFAULTS.everyNEvents;
  const minUsd = opts.minUsd ?? LIVE_DEFAULTS.minUsd;
  const regrowth = opts.regrowth ?? LIVE_DEFAULTS.regrowth;
  const frontierThreshold = opts.frontierThreshold ?? LIVE_DEFAULTS.frontierThreshold;
  const now = opts.now ?? Date.now;
  const events = [];
  const announced = /* @__PURE__ */ new Map();
  let lastRun = 0;
  let sinceRun = 0;
  function run(trigger) {
    lastRun = now();
    sinceRun = 0;
    if (events.length === 0)
      return [];
    const data = datasetOf(events);
    const { findings } = analyze(data);
    if (findings.length === 0)
      return [];
    const recs = new Map(toRecommendations(findings, events.length).map((r) => [r.rule, r]));
    const out = [];
    for (const finding of findings) {
      if (finding.advisory)
        continue;
      if (finding.tier === "test")
        continue;
      const observedUsd = finding.savings.windowUsd;
      if (observedUsd < minUsd)
        continue;
      const recommendation = recs.get(finding.rule);
      if (!recommendation)
        continue;
      let judged;
      let withheld;
      if (opts.judge && JUDGEABLE_RULES.has(finding.rule)) {
        judged = consult(finding, events, opts.judge);
        if (judged && judged.needsFrontierShare >= frontierThreshold) {
          withheld = { by: "jev", ...judged };
        }
      }
      const before = announced.get(finding.rule);
      if (before !== void 0 && observedUsd < before * regrowth)
        continue;
      announced.set(finding.rule, observedUsd);
      const first = events[0];
      const last = events[events.length - 1];
      const windowMs = first && last ? new Date(last.ts).getTime() - new Date(first.ts).getTime() : 0;
      const at = trigger ?? last;
      const affected = events.filter(finding.affects);
      out.push({
        recommendation,
        finding,
        observedUsd,
        windowMs: Math.max(0, windowMs),
        windowEvents: events.length,
        trigger: {
          id: at?.id ?? "",
          model: at?.model ?? "",
          route: at?.route,
          ts: at?.ts ?? ""
        },
        sessions: new Set(affected.map((e) => e.sessionId)).size,
        examples: affected.slice(-LIVE_DEFAULTS.examples).reverse(),
        traffic: trafficOf(finding, events),
        ...before !== void 0 ? { repeatOf: before } : {},
        ...judged ? { judged } : {},
        ...withheld ? { withheld } : {}
      });
    }
    return out;
  }
  return {
    push(event) {
      events.push(event);
      if (events.length > maxEvents)
        events.splice(0, events.length - maxEvents);
      sinceRun++;
      const due = now() - lastRun >= minIntervalMs || sinceRun >= everyNEvents;
      if (!due)
        return [];
      return run(event);
    },
    flush() {
      return run(null);
    },
    window() {
      return events;
    },
    reset() {
      events.length = 0;
      announced.clear();
      lastRun = 0;
      sinceRun = 0;
    }
  };
}

// ../../packages/core/dist/analyze/cache-watch.js
var EXPIRY_WARN_MS = 5 * 6e4;
var COUNTDOWN_MS = 15 * 6e4;
var EARLY = 1 / 12;

// ../../packages/core/dist/ingest/images.js
var MAX_EDGE = 1568;
var PIXELS_PER_TOKEN = 750;
var FALLBACK_TOKENS = 1600;
function pngSize(buf) {
  if (buf.length < 24)
    return null;
  if (buf.readUInt32BE(0) !== 2303741511)
    return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
function gifSize(buf) {
  if (buf.length < 10)
    return null;
  if (buf.toString("ascii", 0, 3) !== "GIF")
    return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}
function jpegSize(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 65496)
    return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 255) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) {
      return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
    }
    const segmentLength = buf.readUInt16BE(offset + 2);
    if (segmentLength <= 0)
      return null;
    offset += 2 + segmentLength;
  }
  return null;
}
function webpSize(buf) {
  if (buf.length < 30)
    return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP")
    return null;
  const format = buf.toString("ascii", 12, 16);
  if (format === "VP8X") {
    return {
      width: 1 + (buf.readUIntLE(24, 3) & 16777215),
      height: 1 + (buf.readUIntLE(27, 3) & 16777215)
    };
  }
  if (format === "VP8 ") {
    return { width: buf.readUInt16LE(26) & 16383, height: buf.readUInt16LE(28) & 16383 };
  }
  return null;
}
function readDimensions(header) {
  return pngSize(header) ?? jpegSize(header) ?? gifSize(header) ?? webpSize(header);
}
function imageTokensFor(dim2) {
  if (!dim2 || dim2.width <= 0 || dim2.height <= 0)
    return FALLBACK_TOKENS;
  const scale = Math.min(1, MAX_EDGE / Math.max(dim2.width, dim2.height));
  const w = dim2.width * scale;
  const h = dim2.height * scale;
  return Math.round(w * h / PIXELS_PER_TOKEN);
}
function estimateImageTokens(base64Data) {
  try {
    const slice = base64Data.slice(0, 4096);
    const header = Buffer.from(slice, "base64");
    return imageTokensFor(readDimensions(header));
  } catch {
    return FALLBACK_TOKENS;
  }
}

// ../../packages/core/dist/ingest/claudecode.js
import fs3 from "node:fs";
import path3 from "node:path";
import os2 from "node:os";
import readline3 from "node:readline";
function claudeConfigDir() {
  const set = process.env.CLAUDE_CONFIG_DIR?.trim();
  return set ? userPath(set) : path3.join(os2.homedir(), ".claude");
}
function userPath(p) {
  return path3.resolve(p === "~" || p.startsWith("~/") ? path3.join(os2.homedir(), p.slice(1)) : p);
}
var CHARS_PER_TOKEN2 = 4;
function measureResult(content) {
  if (typeof content === "string") {
    return { chars: content.length, tokens: content.length / CHARS_PER_TOKEN2, images: 0 };
  }
  if (!Array.isArray(content)) {
    if (content == null)
      return { chars: 0, tokens: 0, images: 0 };
    const s = JSON.stringify(content);
    return { chars: s.length, tokens: s.length / CHARS_PER_TOKEN2, images: 0 };
  }
  let chars = 0;
  let tokens2 = 0;
  let images = 0;
  for (const block of content) {
    if (block?.type === "image" && typeof block?.source?.data === "string") {
      images++;
      tokens2 += estimateImageTokens(block.source.data);
      continue;
    }
    if (block?.type === "text" && typeof block.text === "string") {
      chars += block.text.length;
      tokens2 += block.text.length / CHARS_PER_TOKEN2;
      continue;
    }
    const s = JSON.stringify(block ?? {});
    chars += s.length;
    tokens2 += s.length / CHARS_PER_TOKEN2;
  }
  return { chars, tokens: tokens2, images };
}
function createTranscriptState() {
  return {
    partials: /* @__PURE__ */ new Map(),
    toolResults: /* @__PURE__ */ new Map(),
    touchedAt: /* @__PURE__ */ new Map(),
    threads: /* @__PURE__ */ new Map(),
    compactions: /* @__PURE__ */ new Map()
  };
}
function threadOf(state, file, rec) {
  const key = `${file}|${rec.isSidechain ? rec.agentId ?? "side" : "main"}`;
  let t = state.threads.get(key);
  if (!t) {
    t = { epoch: 0 };
    state.threads.set(key, t);
  }
  return t;
}
var NOT_A_PROMPT = /^\s*(<local-command|<bash-|<system-reminder|<task-notification|\[Request interrupted|Caveat: )/;
function isPrompt(rec) {
  if (rec.isMeta || rec.isCompactSummary)
    return false;
  const content = rec.message?.content;
  let text;
  if (typeof content === "string")
    text = content;
  else if (Array.isArray(content)) {
    const blocks = content;
    if (blocks.some((b) => b?.type === "tool_result"))
      return false;
    text = blocks.find((b) => b?.type === "text")?.text;
  }
  return typeof text === "string" && text.trim() !== "" && !NOT_A_PROMPT.test(text);
}
function tokenWeight(u) {
  if (!u)
    return -1;
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}
function hashOf(text) {
  let h = 2166136261;
  for (let k = 0; k < text.length; k++) {
    h ^= text.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
function targetOf(input) {
  const i = input ?? {};
  const v = i.file_path ?? i.notebook_path;
  return typeof v === "string" && v ? v : void 0;
}
function signatureOf(name, input) {
  const i = input ?? {};
  const pick = (k) => typeof i[k] === "string" ? i[k] : void 0;
  switch (name) {
    case "Read": {
      const slice = [i.offset, i.limit].some((v) => v !== void 0) ? `#${String(i.offset ?? "")}:${String(i.limit ?? "")}` : "";
      return `Read:${pick("file_path") ?? ""}${slice}`;
    }
    case "NotebookEdit":
      return `${name}:${pick("notebook_path") ?? pick("file_path") ?? ""}`;
    case "Edit":
    case "Write":
    case "MultiEdit":
      return `${name}:${pick("file_path") ?? ""}#${hashOf(JSON.stringify(i))}`;
    case "Bash":
      return `Bash:${(pick("command") ?? "").trim().replace(/\s+/g, " ")}`;
    case "Grep":
      return `Grep:${pick("pattern") ?? ""}|${pick("path") ?? ""}`;
    case "Glob":
      return `Glob:${pick("pattern") ?? ""}`;
    case "WebFetch":
      return `WebFetch:${pick("url") ?? ""}`;
    default: {
      const json = JSON.stringify(i ?? {});
      return `${name}:${json.length > 200 ? json.slice(0, 200) : json}`;
    }
  }
}
function decodeProjectDir(dirName) {
  return dirName.replace(/^-/, "/").replace(/-/g, "/");
}
function consumeTranscriptLine(state, line2, file, at = Date.now()) {
  const out = state.partials;
  const toolResults = state.toolResults;
  if (!line2.trim())
    return true;
  let rec;
  try {
    rec = JSON.parse(line2);
  } catch {
    return false;
  }
  if (rec.type === "system" && rec.subtype === "compact_boundary") {
    const thread2 = threadOf(state, file, rec);
    thread2.epoch++;
    const meta = rec.compactMetadata;
    if (!rec.isSidechain && typeof meta?.preTokens === "number") {
      state.compactions.set(rec.uuid ?? `${file}:${rec.timestamp}`, {
        source: "claude-code",
        ts: rec.timestamp ?? new Date(at).toISOString(),
        sessionId: rec.sessionId ?? path3.basename(file, ".jsonl"),
        project: rec.cwd ?? "unknown",
        trigger: typeof meta.trigger === "string" ? meta.trigger : "unknown",
        preTokens: meta.preTokens,
        ...typeof meta.postTokens === "number" ? { postTokens: meta.postTokens } : {},
        ...typeof meta.durationMs === "number" ? { durationMs: meta.durationMs } : {},
        midTask: thread2.lastStop === "tool_use"
      });
    }
    return true;
  }
  if (rec.type === "user") {
    if (isPrompt(rec)) {
      threadOf(state, file, rec).turnId = rec.uuid ?? `${file}:${state.threads.size}:${rec.timestamp}`;
    }
    const content = rec.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== "tool_result")
          continue;
        const m = measureResult(block.content);
        toolResults.set(block.tool_use_id, {
          chars: m.chars,
          tokens: m.tokens,
          images: m.images,
          isError: Boolean(block.is_error)
        });
      }
    }
    return true;
  }
  if (rec.type !== "assistant")
    return true;
  const msg = rec.message;
  if (!msg)
    return true;
  const model = msg.model ?? "";
  if (!model || model === "<synthetic>")
    return true;
  const messageId = msg.id ?? rec.requestId ?? rec.uuid;
  if (!messageId)
    return true;
  const usage = msg.usage ?? {};
  const weight = tokenWeight(usage);
  const thread = threadOf(state, file, rec);
  let p = out.get(messageId);
  if (!p) {
    p = {
      messageId,
      usage,
      usageWeight: weight,
      model,
      ts: rec.timestamp ?? (/* @__PURE__ */ new Date()).toISOString(),
      sessionId: rec.sessionId ?? path3.basename(file, ".jsonl"),
      cwd: rec.cwd,
      effort: rec.effort ?? null,
      isSubagent: Boolean(rec.isSidechain),
      stopReason: msg.stop_reason ?? null,
      turnId: thread.turnId,
      contextEpoch: thread.epoch,
      tools: /* @__PURE__ */ new Map()
    };
    out.set(messageId, p);
  } else if (weight > p.usageWeight) {
    p.usage = usage;
    p.usageWeight = weight;
    if (msg.stop_reason)
      p.stopReason = msg.stop_reason;
  }
  thread.lastStop = msg.stop_reason ?? p.stopReason ?? null;
  state.touchedAt.set(messageId, at);
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block?.type !== "tool_use")
        continue;
      const id = block.id ?? `${messageId}:${p.tools.size}`;
      if (!p.tools.has(id)) {
        const target = targetOf(block.input);
        p.tools.set(id, {
          id,
          name: block.name ?? "unknown",
          signature: signatureOf(block.name ?? "unknown", block.input),
          ...target ? { target } : {}
        });
      }
    }
  }
  return true;
}
async function readTranscript(file, fallbackProject, state, warnings) {
  const stream = fs3.createReadStream(file, { encoding: "utf8" });
  const rl = readline3.createInterface({ input: stream, crlfDelay: Infinity });
  let bad = 0;
  for await (const line2 of rl) {
    if (!consumeTranscriptLine(state, line2, file))
      bad++;
  }
  if (bad > 0)
    warnings.push(`${path3.basename(file)}: skipped ${bad} unparseable line(s)`);
  void fallbackProject;
}
function listTranscripts(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs3.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path3.join(dir, e.name);
      if (e.isDirectory())
        walk(full);
      else if (e.isFile() && e.name.endsWith(".jsonl"))
        files.push(full);
    }
  };
  walk(root);
  return files;
}
async function ingestClaudeCode(opts = {}) {
  const root = opts.root ?? path3.join(claudeConfigDir(), "projects");
  const warnings = [];
  if (!fs3.existsSync(root)) {
    return {
      events: [],
      window: { from: "", to: "", days: 0 },
      sources: [],
      warnings: [`No Claude Code transcripts found at ${root}`]
    };
  }
  const files = listTranscripts(root);
  const state = createTranscriptState();
  for (const file of files) {
    const projectDir = path3.relative(root, file).split(path3.sep)[0] ?? "";
    try {
      await readTranscript(file, decodeProjectDir(projectDir), state, warnings);
    } catch (err) {
      warnings.push(`${path3.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const cutoff = opts.days ? Date.now() - opts.days * 864e5 : null;
  const events = [];
  for (const p of state.partials.values()) {
    const at = new Date(p.ts);
    if (cutoff && at.getTime() < cutoff)
      continue;
    const project = p.cwd ?? "unknown";
    if (opts.project && !project.toLowerCase().includes(opts.project.toLowerCase()))
      continue;
    events.push(buildTranscriptEvent(p, state));
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  const from = events[0]?.ts ?? "";
  const to = events[events.length - 1]?.ts ?? "";
  const days = from && to ? Math.max(1, (new Date(to).getTime() - new Date(from).getTime()) / 864e5) : 0;
  const unpriced = new Set(events.filter((e) => e.cost.unpriced).map((e) => e.model));
  for (const m of unpriced)
    warnings.push(`Unknown model "${m}", priced at $0`);
  const compactions = [...state.compactions.values()].filter((c2) => !cutoff || new Date(c2.ts).getTime() >= cutoff).filter((c2) => !opts.project || c2.project.toLowerCase().includes(opts.project.toLowerCase())).sort((a, b) => a.ts.localeCompare(b.ts));
  return { events, window: { from, to, days }, sources: files, warnings, compactions };
}
function buildTranscriptEvent(p, state) {
  const u = p.usage;
  const tools = [...p.tools.values()].map((t) => {
    const r = state.toolResults.get(t.id);
    return r ? {
      ...t,
      resultChars: r.chars,
      resultTokens: r.tokens,
      imageCount: r.images,
      isError: r.isError
    } : t;
  });
  return {
    id: p.messageId,
    source: "claude-code",
    ts: p.ts,
    model: p.model,
    provider: providerOf(p.model),
    sessionId: p.sessionId,
    project: p.cwd ?? "unknown",
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    thinkingTokens: u.output_tokens_details?.thinking_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: Math.max(0, (u.cache_creation_input_tokens ?? 0) - (u.cache_creation?.ephemeral_1h_input_tokens ?? 0)),
    cacheWrite1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    webSearches: u.server_tool_use?.web_search_requests ?? 0,
    stopReason: p.stopReason,
    effort: p.effort,
    speed: u.speed ?? null,
    serviceTier: u.service_tier ?? null,
    isSubagent: p.isSubagent,
    ...p.turnId ? { turnId: p.turnId } : {},
    ...p.contextEpoch ? { contextEpoch: p.contextEpoch } : {},
    tools,
    cost: costOf(u, p.model, { at: p.ts, speed: u.speed })
  };
}
function takeSettled(state, quietMs, at = Date.now()) {
  const out = [];
  for (const [id, touched] of state.touchedAt) {
    if (at - touched < quietMs)
      continue;
    const p = state.partials.get(id);
    if (p)
      out.push(buildTranscriptEvent(p, state));
    state.partials.delete(id);
    state.touchedAt.delete(id);
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

// ../../packages/core/dist/ingest/codex.js
import fs4 from "node:fs";
import path4 from "node:path";
import os3 from "node:os";
import readline4 from "node:readline";
function codexHome() {
  const set = process.env.CODEX_HOME?.trim();
  return set ? userPath(set) : path4.join(os3.homedir(), ".codex");
}
function num2(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function usageShape(u) {
  return {
    input_tokens: num2(u.input_tokens),
    input_tokens_details: { cached_tokens: num2(u.cached_input_tokens) },
    output_tokens: num2(u.output_tokens),
    output_tokens_details: { reasoning_tokens: num2(u.reasoning_output_tokens) }
  };
}
function signatureOf2(name, args) {
  const raw = typeof args === "string" ? args : JSON.stringify(args ?? {});
  const text = raw.trim().replace(/\s+/g, " ");
  return `${name}:${text.length > 200 ? text.slice(0, 200) : text}`;
}
function outputChars(output) {
  if (typeof output === "string")
    return output.length;
  if (output && typeof output === "object") {
    const o = output;
    if (typeof o.output === "string")
      return o.output.length;
    if (typeof o.content === "string")
      return o.content.length;
    try {
      return JSON.stringify(output).length;
    } catch {
      return 0;
    }
  }
  return 0;
}
function listRollouts(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs4.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path4.join(dir, e.name);
      if (e.isDirectory())
        walk(full);
      else if (e.isFile() && e.name.endsWith(".jsonl"))
        out.push(full);
    }
  };
  walk(root);
  return out.sort();
}
function createCodexState(file) {
  return {
    file,
    sessionId: path4.basename(file, ".jsonl"),
    cwd: "unknown",
    model: "",
    effort: null,
    seq: 0,
    lastTotal: 0,
    pending: /* @__PURE__ */ new Map(),
    turns: 0,
    epoch: 0
  };
}
function failed(output) {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  const m = /Process exited with code (\d+)|"exit_code":\s*(\d+)/.exec(text ?? "");
  return Boolean(m && Number(m[1] ?? m[2]) !== 0);
}
function consumeCodexLine(state, line2) {
  if (!line2.trim())
    return null;
  let row;
  try {
    row = JSON.parse(line2);
  } catch {
    return null;
  }
  const p = row.payload ?? {};
  if (row.type === "session_meta") {
    if (typeof p.id === "string")
      state.sessionId = p.id;
    if (typeof p.cwd === "string")
      state.cwd = p.cwd;
    return null;
  }
  if (row.type === "turn_context") {
    if (typeof p.model === "string")
      state.model = p.model;
    state.effort = typeof p.effort === "string" ? p.effort : null;
    return null;
  }
  if (row.type === "response_item") {
    const kind = p.type;
    if (kind === "function_call" || kind === "custom_tool_call") {
      const id = typeof p.call_id === "string" ? p.call_id : `t${state.pending.size}`;
      const name = typeof p.name === "string" ? p.name : "unknown";
      state.pending.set(id, { id, name, signature: signatureOf2(name, p.arguments ?? p.input) });
    } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      const id = typeof p.call_id === "string" ? p.call_id : "";
      const tool = state.pending.get(id);
      if (tool) {
        tool.resultChars = outputChars(p.output);
        if (failed(p.output))
          tool.isError = true;
      }
    }
    return null;
  }
  if (row.type === "event_msg" && p.type === "context_compacted") {
    state.epoch++;
    return null;
  }
  if (row.type === "event_msg" && p.type === "user_message") {
    state.turnId = `${state.sessionId}:t${state.turns++}`;
    return null;
  }
  if (row.type !== "event_msg" || p.type !== "token_count")
    return null;
  const limits = rateLimitsOf(p.rate_limits, row.timestamp);
  if (limits)
    state.limits = limits;
  const info = p.info;
  if (!info || !info.last_token_usage)
    return null;
  const last = info.last_token_usage;
  const total = num2(info.total_token_usage?.total_tokens);
  if (total > 0 && total <= state.lastTotal)
    return null;
  if (num2(last.total_tokens) === 0)
    return null;
  state.lastTotal = total;
  const ts = row.timestamp ?? (/* @__PURE__ */ new Date()).toISOString();
  const usage = usageShape(last);
  const resolved = state.model || "gpt-5";
  const tools = [...state.pending.values()];
  state.pending = /* @__PURE__ */ new Map();
  return {
    // Deterministic, so re-reading the same rollout yields the same ids and
    // decisions stay attached to the calls they were made about.
    id: `${state.sessionId}#${state.seq++}`,
    source: "codex",
    ts,
    model: resolved,
    provider: providerOf(resolved),
    sessionId: state.sessionId,
    project: state.cwd,
    inputTokens: num2(last.input_tokens) - num2(last.cached_input_tokens),
    outputTokens: num2(last.output_tokens),
    thinkingTokens: num2(last.reasoning_output_tokens),
    cacheReadTokens: num2(last.cached_input_tokens),
    // Codex never reports a cache write: OpenAI caches automatically and
    // bills nothing to create one.
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    effort: state.effort,
    ...state.turnId ? { turnId: state.turnId } : {},
    ...state.epoch ? { contextEpoch: state.epoch } : {},
    tools,
    ...state.limits ? { rateLimits: state.limits } : {},
    cost: costOf(usage, resolved, { at: ts })
  };
}
function rateLimitsOf(raw, at) {
  if (!raw || typeof raw !== "object")
    return void 0;
  const r = raw;
  const base = at ? Date.parse(at) : NaN;
  const windows = [];
  for (const key of ["primary", "secondary"]) {
    const w = r[key];
    if (!w || typeof w !== "object")
      continue;
    const used = Number(w.used_percent);
    const minutes = Number(w.window_minutes);
    let resets = NaN;
    if (Number.isFinite(Number(w.resets_at)))
      resets = Number(w.resets_at) * 1e3;
    else if (Number.isFinite(Number(w.resets_in_seconds)) && Number.isFinite(base))
      resets = base + Number(w.resets_in_seconds) * 1e3;
    if (!Number.isFinite(used) || !Number.isFinite(minutes) || !Number.isFinite(resets))
      continue;
    windows.push({
      usedPercent: used,
      windowMinutes: minutes,
      resetsAt: new Date(resets).toISOString()
    });
  }
  if (windows.length === 0)
    return void 0;
  return { planType: typeof r.plan_type === "string" ? r.plan_type : null, windows };
}
async function readRollout(file, warnings) {
  const events = [];
  const state = createCodexState(file);
  let bad = 0;
  const rl = readline4.createInterface({
    input: fs4.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  for await (const line2 of rl) {
    if (!line2.trim())
      continue;
    try {
      JSON.parse(line2);
    } catch {
      bad++;
      continue;
    }
    const event = consumeCodexLine(state, line2);
    if (event)
      events.push(event);
  }
  if (bad)
    warnings.push(`${path4.basename(file)}: skipped ${bad} unparseable line(s)`);
  return events;
}
async function ingestCodex(opts = {}) {
  const root = opts.root ?? path4.join(codexHome(), "sessions");
  const warnings = [];
  if (!fs4.existsSync(root)) {
    return {
      events: [],
      window: { from: "", to: "", days: 0 },
      sources: [],
      warnings: [`No Codex transcripts found at ${root}`]
    };
  }
  const files = listRollouts(root);
  const cutoff = opts.days ? Date.now() - opts.days * 864e5 : null;
  const events = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = await readRollout(file, warnings);
    } catch (err) {
      warnings.push(`${path4.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const e of parsed) {
      if (cutoff && new Date(e.ts).getTime() < cutoff)
        continue;
      if (opts.project && !e.project.toLowerCase().includes(opts.project.toLowerCase()))
        continue;
      events.push(e);
    }
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  const from = events[0]?.ts ?? "";
  const to = events[events.length - 1]?.ts ?? "";
  const days = from && to ? Math.max(1, (new Date(to).getTime() - new Date(from).getTime()) / 864e5) : 0;
  return { events, window: { from, to, days }, sources: [root], warnings };
}

// ../../packages/core/dist/ingest/import.js
import fs5 from "node:fs";
import crypto3 from "node:crypto";
var FIELDS = {
  model: ["model", "modelid", "modelname", "engine", "deployment"],
  ts: ["timestamp", "time", "date", "createdat", "requesttime", "starttime"],
  inputTokens: ["inputtokens", "prompttokens", "input", "ntokensprompt", "tokensin"],
  outputTokens: ["outputtokens", "completiontokens", "output", "ntokenscompletion", "tokensout"],
  cacheReadTokens: ["cachereadtokens", "cachereadinputtokens", "cachedtokens", "cachedinputtokens"],
  cacheWriteTokens: ["cachewritetokens", "cachecreationinputtokens", "cachecreationtokens"],
  thinkingTokens: ["thinkingtokens", "reasoningtokens"],
  latencyMs: ["latencyms", "latency", "durationms", "responsetimems"],
  route: ["route", "endpoint", "operation", "feature", "usecase"],
  project: ["project", "service", "application", "app", "workspace"],
  sessionId: ["sessionid", "session", "conversationid", "traceid", "requestid"],
  costUsd: ["cost", "costusd", "amount", "spend", "totalcost"]
};
function normalise(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function mapHeaders(headers) {
  const map = /* @__PURE__ */ new Map();
  for (const header of headers) {
    const n = normalise(header);
    for (const [field, aliases] of Object.entries(FIELDS)) {
      if (aliases.includes(n)) {
        map.set(header, field);
        break;
      }
    }
  }
  return map;
}
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else
          quoted = false;
      } else
        field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n")
        i++;
      row.push(field);
      field = "";
      if (row.some((c2) => c2.trim() !== ""))
        rows.push(row);
      row = [];
    } else
      field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((c2) => c2.trim() !== ""))
      rows.push(row);
  }
  const header = rows.shift();
  if (!header)
    return [];
  return rows.map((r) => {
    const obj = {};
    header.forEach((h, i) => {
      obj[h.trim()] = (r[i] ?? "").trim();
    });
    return obj;
  });
}
function toNumber(value) {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string")
    return 0;
  const n = Number(value.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function rowToEvent(row, headerMap, opts) {
  const get = (field) => {
    for (const [header, mapped] of headerMap) {
      if (mapped === field && row[header] !== void 0 && row[header] !== "")
        return row[header];
    }
    return void 0;
  };
  const model = String(get("model") ?? "").trim();
  if (!model)
    return null;
  const inputTokens = toNumber(get("inputTokens"));
  const outputTokens = toNumber(get("outputTokens"));
  const cacheReadTokens = toNumber(get("cacheReadTokens"));
  const cacheWriteTokens = toNumber(get("cacheWriteTokens"));
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0)
    return null;
  const rawTs = get("ts");
  const parsed = rawTs ? new Date(String(rawTs)) : /* @__PURE__ */ new Date();
  const ts = Number.isNaN(parsed.getTime()) ? (/* @__PURE__ */ new Date()).toISOString() : parsed.toISOString();
  const usage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheWriteTokens
  };
  const n = normalizeUsage(usage, model);
  const computed = costOf(usage, model, { at: ts });
  const stated = get("costUsd");
  const cost = stated !== void 0 && toNumber(stated) > 0 ? { ...computed, total: toNumber(stated), unpriced: false } : computed;
  const latency = toNumber(get("latencyMs"));
  return {
    id: String(get("sessionId") ?? crypto3.randomUUID()),
    source: "sdk",
    ts,
    model,
    provider: providerOf(model),
    sessionId: String(get("sessionId") ?? "imported"),
    project: String(get("project") ?? opts.service ?? "imported"),
    route: get("route") ? String(get("route")) : void 0,
    inputTokens: n.inputTokens,
    outputTokens: n.outputTokens,
    thinkingTokens: toNumber(get("thinkingTokens")) || n.thinkingTokens,
    cacheReadTokens: n.cacheReadTokens,
    cacheWrite5mTokens: n.cacheWrite5mTokens,
    cacheWrite1hTokens: n.cacheWrite1hTokens,
    webSearches: n.webSearches,
    latencyMs: latency > 0 ? latency : void 0,
    tools: [],
    cost
  };
}
function importUsageFile(file, opts = {}) {
  const text = fs5.readFileSync(file, "utf8");
  let rows;
  if (file.endsWith(".json") || text.trimStart().startsWith("[") || text.trimStart().startsWith("{")) {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : parsed.data ?? parsed.usage ?? parsed.results ?? [];
  } else {
    rows = parseCsv(text);
  }
  if (!Array.isArray(rows) || rows.length === 0)
    return { events: [], skipped: 0 };
  const headerMap = mapHeaders(Object.keys(rows[0]));
  const events = [];
  let skipped = 0;
  for (const row of rows) {
    const event = rowToEvent(row, headerMap, opts);
    if (event)
      events.push(event);
    else
      skipped++;
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return { events, skipped };
}

// ../../packages/core/dist/providers/registry.js
var providers = /* @__PURE__ */ new Map();
var adapters = [];
function registerProvider(provider) {
  providers.set(provider.id, provider);
}
function registerAdapter(adapter) {
  const i = adapters.findIndex((a) => a.label === adapter.label);
  if (i >= 0)
    adapters[i] = adapter;
  else
    adapters.push(adapter);
}
registerProvider({
  id: "anthropic",
  label: "Anthropic",
  cachePolicy: PROVIDERS.anthropic,
  usageExportHint: "console.anthropic.com \u2192 Usage"
});
registerProvider({
  id: "openai",
  label: "OpenAI",
  cachePolicy: PROVIDERS.openai,
  usageExportHint: "platform.openai.com \u2192 Usage \u2192 Export"
});

// ../../packages/core/dist/verify/dialect.js
function dialectOf(request) {
  const provider = providerOf(request?.model);
  if (provider === "google")
    return "google-generate-content";
  if (provider !== "openai")
    return "anthropic-messages";
  const openaiResponses2 = request?.input !== void 0 || request?.instructions !== void 0;
  return openaiResponses2 ? "openai-responses" : "openai-chat";
}
function providerOfDialect(dialect) {
  switch (dialect) {
    case "anthropic-messages":
      return "anthropic";
    case "google-generate-content":
      return "google";
    default:
      return "openai";
  }
}
function outputLimitField(dialect) {
  switch (dialect) {
    case "anthropic-messages":
      return "max_tokens";
    case "openai-chat":
      return "max_completion_tokens";
    case "openai-responses":
      return "max_output_tokens";
    // Gemini nests this under `config`; `setOutputLimit` handles the nesting.
    case "google-generate-content":
      return "maxOutputTokens";
  }
}
function outputLimitOf(request) {
  const value = request.max_tokens ?? request.max_completion_tokens ?? request.max_output_tokens ?? request.config?.maxOutputTokens ?? void 0;
  return typeof value === "number" ? value : void 0;
}
function setOutputLimit(request, dialect, limit) {
  const model = priceFor(request.model);
  const capped = model ? Math.min(limit, model.maxOutputTokens) : limit;
  delete request.max_tokens;
  delete request.max_completion_tokens;
  delete request.max_output_tokens;
  if (request.config && typeof request.config === "object") {
    delete request.config.maxOutputTokens;
  }
  if (dialect === "google-generate-content") {
    request.config = { ...request.config ?? {}, maxOutputTokens: capped };
    return;
  }
  request[outputLimitField(dialect)] = capped;
}
function sendChat(client, request, dialect = dialectOf(request)) {
  switch (dialect) {
    case "anthropic-messages":
      return client.messages.create(request);
    case "openai-chat":
      return client.chat.completions.create(request);
    case "openai-responses":
      return client.responses.create(request);
    case "google-generate-content":
      return client.models.generateContent(request);
  }
}

// ../../packages/core/dist/verify/quality.js
var DEFAULT_BAR = {
  checks: [{ type: "no-refusal" }, { type: "tool-name-matches" }],
  judge: {
    model: "claude-opus-5",
    criteria: "Which response better completes the user's request: more accurate, more complete, and correctly formatted?",
    minWinRate: 0.45
  },
  sampleSize: 40
};
var REFUSAL = /\b(I can't help|I cannot help|I'm unable to|I can't assist|I cannot assist)\b/i;
function textOf2(content) {
  if (typeof content === "string")
    return content;
  if (!content || typeof content !== "object")
    return "";
  const value = content;
  if (Array.isArray(value.content))
    return textOf2(value.content);
  if (Array.isArray(value.choices))
    return textOf2(value.choices);
  if (Array.isArray(value.output))
    return textOf2(value.output);
  if (Array.isArray(value.candidates))
    return textOf2(value.candidates);
  if (Array.isArray(value.parts))
    return textOf2(value.parts);
  if (value.content && Array.isArray(value.content.parts))
    return textOf2(value.content.parts);
  if (value.message && typeof value.message === "object")
    return textOf2(value.message.content);
  if (!Array.isArray(value))
    return "";
  return value.flatMap((b) => {
    if (typeof b === "string")
      return [b];
    if ((b?.type === "text" || b?.type === "output_text") && typeof b.text === "string") {
      return [b.text];
    }
    if (b?.message !== void 0)
      return [textOf2(b.message.content)];
    if (b?.type === "message" && Array.isArray(b.content))
      return [textOf2(b.content)];
    if (b?.content && Array.isArray(b.content.parts))
      return [textOf2(b.content.parts)];
    if (b?.type === void 0 && typeof b?.text === "string")
      return [b.text];
    return [];
  }).filter((t) => t !== "").join("\n");
}
function toolNamesOf(content) {
  if (!content || typeof content !== "object")
    return [];
  const value = content;
  if (Array.isArray(value.content))
    return toolNamesOf(value.content);
  if (Array.isArray(value.choices))
    return toolNamesOf(value.choices);
  if (Array.isArray(value.output))
    return toolNamesOf(value.output);
  if (Array.isArray(value.candidates))
    return toolNamesOf(value.candidates);
  if (Array.isArray(value.parts))
    return toolNamesOf(value.parts);
  if (value.content && Array.isArray(value.content.parts))
    return toolNamesOf(value.content.parts);
  if (!Array.isArray(value))
    return [];
  return value.flatMap((b) => {
    if (b?.type === "tool_use")
      return [String(b.name)];
    if (b?.content && Array.isArray(b.content.parts))
      return toolNamesOf(b.content.parts);
    if (b?.functionCall?.name)
      return [String(b.functionCall.name)];
    if (b?.type === "function_call")
      return [String(b.name ?? "unknown")];
    const calls = b?.message?.tool_calls ?? b?.tool_calls;
    if (Array.isArray(calls)) {
      return calls.map((c2) => String(c2?.function?.name ?? c2?.name ?? "unknown"));
    }
    return [];
  });
}
function labelOf(check) {
  if (check.label)
    return check.label;
  switch (check.type) {
    case "contains":
      return `contains "${check.value.slice(0, 24)}"`;
    case "matches":
      return `matches /${check.pattern.slice(0, 24)}/`;
    case "max-chars":
      return `at most ${check.value} chars`;
    case "min-chars":
      return `at least ${check.value} chars`;
    default:
      return check.type;
  }
}
function runCheck(check, content, baseline) {
  const text = textOf2(content);
  switch (check.type) {
    case "json-parses": {
      const body = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
      if (!body)
        return false;
      try {
        JSON.parse(body);
        return true;
      } catch {
        return false;
      }
    }
    case "contains":
      return text.includes(check.value);
    case "matches":
      try {
        return new RegExp(check.pattern, check.flags ?? "").test(text);
      } catch {
        return false;
      }
    case "max-chars":
      return text.length <= check.value;
    case "min-chars":
      return text.length >= check.value;
    case "tool-name-matches": {
      const want = toolNamesOf(baseline).join(",");
      const got = toolNamesOf(content).join(",");
      return want === got;
    }
    case "no-refusal":
      return !REFUSAL.test(text);
  }
}
var NO_JUDGE_COST = { usd: 0, priced: 0, unpriced: 0 };
function addJudgeCost(a, b) {
  return {
    usd: a.usd + b.usd,
    priced: a.priced + b.priced,
    unpriced: a.unpriced + b.unpriced
  };
}
var emptyJudgeCost = () => ({ ...NO_JUDGE_COST });
var JUDGE_SYSTEM = 'You are evaluating two responses to the same request. Judge only on the stated criteria. Ignore length, style and formatting differences that do not affect whether the request is satisfied. Reply with exactly one token: "A", "B", or "TIE".';
function judgeRequest(cfg, user, dialect) {
  switch (dialect) {
    case "anthropic-messages":
      return {
        model: cfg.model,
        max_tokens: 1024,
        system: JUDGE_SYSTEM,
        messages: [{ role: "user", content: user }]
      };
    case "openai-chat":
      return {
        model: cfg.model,
        max_completion_tokens: 1024,
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: user }
        ]
      };
    case "openai-responses":
      return {
        model: cfg.model,
        max_output_tokens: 1024,
        instructions: JUDGE_SYSTEM,
        input: user
      };
    case "google-generate-content":
      return {
        model: cfg.model,
        contents: [{ role: "user", parts: [{ text: user }] }],
        config: {
          maxOutputTokens: 1024,
          systemInstruction: JUDGE_SYSTEM
        }
      };
  }
}
async function judgePair(client, cfg, prompt, baseline, candidate) {
  const dialect = dialectOf({ model: cfg.model });
  const ask = async (a, b) => {
    const res = await sendChat(client, judgeRequest(cfg, `Criteria: ${cfg.criteria}

--- REQUEST ---
${prompt.slice(0, 6e3)}

--- RESPONSE A ---
${a.slice(0, 6e3)}

--- RESPONSE B ---
${b.slice(0, 6e3)}

Which response better satisfies the criteria? Answer A, B, or TIE.`, dialect), dialect);
    const priced = costOf(res?.usage, res?.model ?? cfg.model);
    const cost2 = priced.unpriced ? { usd: 0, priced: 0, unpriced: 1 } : { usd: priced.total, priced: 1, unpriced: 0 };
    const out = textOf2(res).trim().toUpperCase();
    const answer = out.startsWith("A") ? "A" : out.startsWith("B") ? "B" : "TIE";
    return { answer, cost: cost2 };
  };
  const [first, second] = await Promise.all([ask(baseline, candidate), ask(candidate, baseline)]);
  const cost = addJudgeCost(first.cost, second.cost);
  const firstSaysCandidate = first.answer === "B";
  const secondSaysCandidate = second.answer === "A";
  if (firstSaysCandidate && secondSaysCandidate)
    return { verdict: "candidate", cost };
  const firstSaysBaseline = first.answer === "A";
  const secondSaysBaseline = second.answer === "B";
  if (firstSaysBaseline && secondSaysBaseline)
    return { verdict: "baseline", cost };
  return { verdict: "tie", cost };
}

// ../../packages/core/dist/report/terminal.js
var ESC = String.fromCharCode(27);
var useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
var c = (code) => (s) => useColor ? `${ESC}[${code}m${s}${ESC}[0m` : String(s);
var dim = c("2");
var bold = c("1");
var red = c("31");
var green = c("32");
var yellow = c("33");
var blue = c("36");
var magenta = c("35");
var ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
var IMPACT = {
  none: green("none"),
  low: green("low"),
  medium: yellow("medium"),
  high: red("high")
};
var EVIDENCE = {
  measured: green("measured"),
  inferred: yellow("inferred"),
  estimated: magenta("estimated")
};
function wrap(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let line2 = "";
  for (const w of words) {
    if (line2.length + w.length + 1 > width) {
      if (line2)
        lines.push(line2);
      line2 = w;
    } else {
      line2 = line2 ? `${line2} ${w}` : w;
    }
  }
  if (line2)
    lines.push(line2);
  return lines;
}
var TIER_TAG = {
  fix: green("FIX "),
  try: yellow("TRY "),
  test: blue("TEST")
};
var STATUS_TAG = {
  new: dim("new"),
  viewed: dim("viewed"),
  simulated: blue("simulated"),
  verified: green("verified"),
  rejected: red("rejected"),
  applied: green("applied")
};
function clip(s, n) {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}
function projectName(p) {
  return p.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? p;
}
function callSession(e) {
  return `${e.sessionId.slice(0, 8)}${e.isSubagent ? " sub" : ""}`;
}
function commandOf2(text) {
  if (!text.startsWith("{"))
    return void 0;
  try {
    const a = JSON.parse(text);
    const cmd = a.command ?? a.cmd;
    if (typeof cmd === "string")
      return cmd;
    if (Array.isArray(cmd)) {
      const shell = /^(bash|sh|zsh|pwsh|powershell)(\.exe)?$/.test(String(cmd[0]));
      return shell && cmd.length >= 3 ? String(cmd[cmd.length - 1]) : cmd.join(" ");
    }
  } catch {
  }
  return void 0;
}
function callActivity(e, width = 48) {
  const first = e.tools[0];
  if (!first)
    return "text only, no tools";
  const colon = first.signature.indexOf(":");
  let target = colon >= 0 ? first.signature.slice(colon + 1) : "";
  target = (commandOf2(target) ?? target).replace(/\s+/g, " ").trim();
  target = target.replace(/^cd \S+ && /, "");
  const parts = target.split(/[\\/]/);
  if (parts.length > 3 && !target.includes(" "))
    target = `.../${parts.slice(-2).join("/")}`;
  const more = e.tools.length > 1 ? ` +${e.tools.length - 1} more` : "";
  return clip(`${first.name} ${target}`.trim(), width - more.length) + more;
}
function minutesLabel(ms) {
  const m = Math.max(0, Math.round(ms / 6e4));
  if (m < 60)
    return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// ../../packages/core/dist/report/statusline.js
var ESC2 = String.fromCharCode(27);

// ../../packages/local/dist/overrides.js
import fs6 from "node:fs";
import path5 from "node:path";
function overridesPath() {
  return path5.join(optimaizrDir(), "overrides.json");
}
function readOverrides(file = overridesPath()) {
  try {
    const parsed = JSON.parse(fs6.readFileSync(file, "utf8"));
    return Array.isArray(parsed.overrides) ? parsed.overrides.filter(isOverride) : [];
  } catch {
    return [];
  }
}
function isOverride(o) {
  const v = o;
  return typeof v === "object" && v !== null && typeof v.rule === "string" && typeof v.project === "string" && typeof v.from === "string" && typeof v.to === "string" && (v.route === void 0 || typeof v.route === "string") && (v.source === void 0 || v.source === "claude-code") && (v.subagent === void 0 || typeof v.subagent === "boolean") && (v.effort === void 0 || typeof v.effort === "string") && (v.auto === void 0 || typeof v.auto === "boolean");
}
function writeOverrides(overrides, file = overridesPath()) {
  fs6.mkdirSync(path5.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const body = { version: 1, overrides };
  fs6.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n");
  fs6.renameSync(tmp, file);
}
function removeOverrides(rule, file = overridesPath()) {
  const all = readOverrides(file);
  const kept = all.filter((o) => o.rule !== rule);
  if (kept.length < all.length)
    writeOverrides(kept, file);
  return all.filter((o) => o.rule === rule);
}
var sameSlot = (a, b) => (a.source ?? null) === (b.source ?? null) && a.project === b.project && (a.route ?? null) === (b.route ?? null) && (a.subagent ?? null) === (b.subagent ?? null) && Boolean(a.effort) === Boolean(b.effort) && a.from === b.from;
function overrideFor(overrides, call) {
  return overrides.find((o) => sameSlot(o, { ...call, from: call.model }));
}
var label = (id) => priceFor(id)?.label ?? id;
function sdkOverrideRewriter(opts = {}) {
  const file = opts.file ?? overridesPath();
  const now = opts.now ?? (() => /* @__PURE__ */ new Date());
  return {
    kind: "sdk wrapper",
    supports(change, finding) {
      if (change.kind !== "swap-model")
        return false;
      if (!change.toModelId && !finding.candidate?.targetFor)
        return false;
      return Boolean(change.traffic?.slices.some((s) => s.source === "sdk"));
    },
    install(change, finding) {
      const slices = change.traffic?.slices.filter((s) => s.source === "sdk") ?? [];
      const at = now().toISOString();
      const added = [];
      for (const s of slices) {
        const to = finding.candidate?.targetFor?.(s.model) ?? change.toModelId;
        if (!to || to === s.model)
          continue;
        if (providerOf(to) !== providerOf(s.model))
          continue;
        added.push({
          rule: finding.rule,
          project: s.project,
          ...s.route !== void 0 ? { route: s.route } : {},
          from: s.model,
          to,
          at
        });
      }
      if (added.length === 0) {
        return {
          ok: false,
          declined: true,
          detail: "no SDK call in this finding has a same-provider model to move to"
        };
      }
      try {
        const kept = readOverrides(file).filter((o) => !added.some((a) => sameSlot(o, a)));
        writeOverrides([...kept, ...added], file);
      } catch (err) {
        return {
          ok: false,
          detail: `could not write ${file}: ${err instanceof Error ? err.message : String(err)}`
        };
      }
      const where = added.map((o) => `${o.project}${o.route ? `/${o.route}` : ""}: ${label(o.from)} -> ${label(o.to)}`).join(", ");
      return {
        ok: true,
        detail: `${where}. Wrapped clients pick this up on their next request, no restart. \`optimaizr undo ${finding.rule}\` reverts it.`
      };
    }
  };
}

// ../../packages/local/dist/wrap.js
var routeStore = new AsyncLocalStorage();
function withRoute(route, fn) {
  return routeStore.run(route, fn);
}
var projectOf = (opts) => opts.service ?? process.env.OPTIMAIZR_SERVICE ?? "app";
var routeOf = (opts) => routeStore.getStore() ?? opts.route;
var overrideCache = { stamp: "", list: [] };
function currentOverrides() {
  const file = overridesPath();
  let stamp;
  try {
    const st = fs7.statSync(file);
    stamp = `${file}:${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    overrideCache = { stamp: "", list: [] };
    return overrideCache.list;
  }
  if (stamp !== overrideCache.stamp)
    overrideCache = { stamp, list: readOverrides(file) };
  return overrideCache.list;
}
var refused = /* @__PURE__ */ new Set();
var keyOf = (o) => `${o.project}\0${o.route ?? ""}\0${o.from}\0${o.to}`;
function overrideForCall(params, opts) {
  if (opts.overrides === false || process.env.OPTIMAIZR_OVERRIDES === "0")
    return void 0;
  if (!params || typeof params !== "object" || typeof params.model !== "string")
    return void 0;
  try {
    const o = overrideFor(currentOverrides(), {
      project: projectOf(opts),
      route: routeOf(opts),
      model: params.model
    });
    return o && !refused.has(keyOf(o)) ? o : void 0;
  } catch {
    return void 0;
  }
}
function isRejection(err) {
  const status = err?.status ?? err?.statusCode;
  return status === 400 || status === 404;
}
async function send(call, params, opts) {
  const o = overrideForCall(params, opts);
  if (!o)
    return { result: await call(params), sent: params };
  const sent = { ...params, model: o.to };
  try {
    return { result: await call(sent), sent };
  } catch (err) {
    if (!isRejection(err))
      throw err;
    const result = await call(params);
    refused.add(keyOf(o));
    return { result, sent: params };
  }
}
function buildEvent(shape, params, result, latencyMs, opts, isBatch) {
  const model = shape.modelOf(params, result);
  if (!model)
    return null;
  const usage = shape.usageOf(result);
  const n = normalizeUsage(usage, model);
  const request = shape.requestOf(params);
  const speed = shape.speedOf(params, result);
  return {
    id: shape.idOf(result) ?? crypto4.randomUUID(),
    source: "sdk",
    ts: new Date(Date.now() - latencyMs).toISOString(),
    model,
    provider: providerOf(model),
    sessionId: routeOf(opts) ?? "default",
    project: projectOf(opts),
    route: routeOf(opts),
    inputTokens: n.inputTokens,
    outputTokens: n.outputTokens,
    thinkingTokens: n.thinkingTokens,
    cacheReadTokens: n.cacheReadTokens,
    cacheWrite5mTokens: n.cacheWrite5mTokens,
    cacheWrite1hTokens: n.cacheWrite1hTokens,
    webSearches: n.webSearches,
    latencyMs,
    stopReason: shape.stopOf(result),
    effort: shape.effortOf(params),
    speed,
    serviceTier: shape.tierOf(params, result),
    batch: isBatch,
    tools: shape.toolsOf(result),
    systemChars: request.systemChars,
    toolDefCount: request.toolDefCount,
    prefixHash: request.prefixHash,
    cost: costOf(usage, model, { at: /* @__PURE__ */ new Date(), speed, batch: isBatch })
  };
}
function emit(event, opts) {
  if (!event)
    return;
  try {
    append(event);
    opts.onEvent?.(event);
  } catch {
  }
}
function instrument(surface, shape, opts, isBatch, methods) {
  return new Proxy(surface, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && methods.includes(prop) && typeof value === "function") {
        return async function(original, ...rest) {
          const started = Date.now();
          const { result, sent: params } = await send((p) => value.call(target, p, ...rest), original, opts);
          if (result?.[Symbol.asyncIterator]) {
            const acc = shape.accumulator();
            return new Proxy(result, {
              get(t, p, r) {
                if (p === Symbol.asyncIterator) {
                  return function() {
                    const inner = t[Symbol.asyncIterator]();
                    return {
                      async next(...a) {
                        const step = await inner.next(...a);
                        if (!step.done)
                          acc.observe(step.value);
                        else
                          emit(buildEvent(shape, params, acc.message, Date.now() - started, opts, isBatch), opts);
                        return step;
                      },
                      async return(v) {
                        return inner.return ? inner.return(v) : { done: true, value: v };
                      },
                      [Symbol.asyncIterator]() {
                        return this;
                      }
                    };
                  };
                }
                return Reflect.get(t, p, r);
              }
            });
          }
          emit(buildEvent(shape, params, result, Date.now() - started, opts, isBatch), opts);
          if (opts.capture) {
            maybeCapture(params, result, opts.capture, routeStore.getStore() ?? opts.route, shape);
          }
          return result;
        };
      }
      if (prop === "stream" && typeof value === "function") {
        return function(params, ...rest) {
          const started = Date.now();
          const stream = value.call(target, params, ...rest);
          try {
            for (const method of ["finalMessage", "finalChatCompletion", "finalResponse"]) {
              if (typeof stream?.[method] !== "function")
                continue;
              const original = stream[method].bind(stream);
              let recorded = false;
              stream[method] = async (...a) => {
                const msg = await original(...a);
                if (!recorded) {
                  recorded = true;
                  emit(buildEvent(shape, params, msg, Date.now() - started, opts, isBatch), opts);
                }
                return msg;
              };
              break;
            }
          } catch {
          }
          return stream;
        };
      }
      if (prop === "parse" && typeof value === "function") {
        return async function(original, ...rest) {
          const started = Date.now();
          const { result, sent: params } = await send((p) => value.call(target, p, ...rest), original, opts);
          emit(buildEvent(shape, params, result, Date.now() - started, opts, isBatch), opts);
          return result;
        };
      }
      return value;
    }
  });
}
var DEFAULT_METHODS = ["create"];
var SURFACES = [
  { path: ["messages"], shape: anthropicMessages },
  { path: ["beta", "messages"], shape: anthropicMessages },
  { path: ["chat", "completions"], shape: openaiChat },
  { path: ["beta", "chat", "completions"], shape: openaiChat },
  { path: ["responses"], shape: openaiResponses },
  {
    path: ["models"],
    shape: googleGenerateContent,
    methods: ["generateContent", "generateContentStream"],
    // Gemini is off by default. Asking the catalogue makes `enableGemini()` the
    // single switch: without its models a Google client is left alone.
    enabled: () => priceFor("gemini-2.5-flash") !== null
  }
];
function instrumentPath(node, path8, shape, opts, methods) {
  if (path8.length === 0)
    return instrument(node, shape, opts, false, methods);
  const [head, ...tail] = path8;
  return new Proxy(node, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === head && value && typeof value === "object") {
        return instrumentPath(value, tail, shape, opts, methods);
      }
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
function wrap2(client, options = {}) {
  const opts = { enabled: true, ...options };
  if (opts.enabled === false || process.env.OPTIMAIZR_DISABLED === "1")
    return client;
  try {
    return new Proxy(client, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (!value || typeof value !== "object") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        for (const { path: path8, shape, methods = DEFAULT_METHODS, enabled } of SURFACES) {
          if (path8[0] !== prop)
            continue;
          if (enabled && !enabled())
            continue;
          const rest = path8.slice(1);
          let node = value;
          for (const step of rest) {
            node = node?.[step];
            if (!node || typeof node !== "object")
              break;
          }
          if (!node || typeof node !== "object")
            continue;
          const sends = methods.some((m) => typeof node[m] === "function");
          if (!sends && typeof node.stream !== "function")
            continue;
          return instrumentPath(value, rest, shape, opts, methods);
        }
        return value;
      }
    });
  } catch {
    return client;
  }
}
function record(input) {
  try {
    const n = normalizeUsage(input.usage, input.model);
    const event = {
      id: crypto4.randomUUID(),
      source: "sdk",
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      model: input.model,
      provider: providerOf(input.model),
      sessionId: input.sessionId ?? input.route ?? "default",
      project: input.service ?? process.env.OPTIMAIZR_SERVICE ?? "app",
      route: input.route,
      inputTokens: n.inputTokens,
      outputTokens: n.outputTokens,
      thinkingTokens: n.thinkingTokens,
      cacheReadTokens: n.cacheReadTokens,
      cacheWrite5mTokens: n.cacheWrite5mTokens,
      cacheWrite1hTokens: n.cacheWrite1hTokens,
      webSearches: n.webSearches,
      latencyMs: input.latencyMs,
      tools: [],
      cost: costOf(input.usage, input.model)
    };
    append(event);
  } catch {
  }
}

// ../../packages/local/dist/live.js
import fs8 from "node:fs";
import path6 from "node:path";
import { StringDecoder } from "node:string_decoder";

// ../../packages/local/dist/jev.js
var ENDPOINT = "https://api.typesafe.ai/v1/systemone";
var MODEL = "jev-latest";
var MAX_QUESTIONS_PER_CALL = 32;
function median(xs) {
  if (xs.length === 0)
    return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] ?? 0 : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}
function keyOf2(e) {
  return e.route ?? e.model;
}
function describe(p) {
  const tools = [...p.tools].sort().join(",") || "none";
  return [
    `route=${JSON.stringify(p.route)}`,
    `model=${p.model}`,
    `calls=${p.calls}`,
    `median_input_tokens=${Math.round(median(p.inputTokens))}`,
    `median_output_tokens=${Math.round(median(p.outputTokens))}`,
    `thinking_tokens=${p.thinkingTokens}`,
    `tools=${tools}`
  ].join(" ");
}
function questionFor(p) {
  return {
    type: "noul",
    instructions: `The route ${JSON.stringify(p.route)} in the state list describes a repeated LLM call site, given only by its name, its model and its token and tool profile. This workload genuinely requires a frontier reasoning model and would lose quality on a small fast model.`,
    criteria: {
      true: "The work implied by the route name needs multi-step reasoning, open-ended synthesis, nuanced judgement, or long-range coherence.",
      false: "The work is mechanical (classification, extraction, formatting, routing, short summarisation, or a single tool call) and a small fast model would do it as well."
    }
  };
}
function createJevJudge(opts = {}) {
  const apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
  const model = opts.model ?? MODEL;
  const endpoint = opts.endpoint ?? ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? 1e4;
  const refreshIntervalMs = opts.refreshIntervalMs ?? 6e4;
  const minCalls = opts.minCalls ?? 5;
  const profiles = /* @__PURE__ */ new Map();
  const verdicts = /* @__PURE__ */ new Map();
  let lastRefresh = 0;
  let inFlight = false;
  function pending() {
    const out = [];
    for (const p of profiles.values()) {
      if (p.calls < minCalls)
        continue;
      if (verdicts.has(p.key))
        continue;
      out.push(p);
    }
    return out.slice(0, MAX_QUESTIONS_PER_CALL);
  }
  function buildRequest(batch) {
    if (batch.length === 0)
      return null;
    const questions = {};
    batch.forEach((p, i) => {
      questions[`r${i}`] = questionFor(p);
    });
    return { state: batch.map(describe), model, questions };
  }
  return {
    observe(event) {
      try {
        const key = keyOf2(event);
        let p = profiles.get(key);
        if (!p) {
          p = {
            key,
            route: key,
            model: event.model,
            calls: 0,
            inputTokens: [],
            outputTokens: [],
            thinkingTokens: 0,
            tools: /* @__PURE__ */ new Set()
          };
          profiles.set(key, p);
        }
        p.calls++;
        if (p.inputTokens.length < 200)
          p.inputTokens.push(event.inputTokens);
        if (p.outputTokens.length < 200)
          p.outputTokens.push(event.outputTokens);
        p.thinkingTokens += event.thinkingTokens;
        for (const t of event.tools)
          p.tools.add(t.name);
      } catch {
      }
    },
    judge(event) {
      return verdicts.get(keyOf2(event));
    },
    describeEgress() {
      return buildRequest(pending());
    },
    async refresh() {
      if (!apiKey && !opts.dryRun || inFlight)
        return;
      const since = Date.now() - lastRefresh;
      if (since < refreshIntervalMs)
        return;
      const batch = pending();
      const body = buildRequest(batch);
      if (!body)
        return;
      inFlight = true;
      lastRefresh = Date.now();
      try {
        opts.onRequest?.(body);
        if (opts.dryRun)
          return;
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!res.ok) {
          throw new Error(`jev: ${res.status} ${res.statusText}`);
        }
        const json = await res.json();
        batch.forEach((p, i) => {
          const answer = json.answers[`r${i}`];
          if (!answer || typeof answer.noul !== "number")
            return;
          verdicts.set(p.key, answer.noul);
          opts.onVerdict?.(p.route, answer.noul);
        });
      } catch (err) {
        opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      } finally {
        inFlight = false;
      }
    },
    verdicts() {
      return verdicts;
    }
  };
}

// ../../packages/local/dist/live.js
function createLiveSession(opts) {
  const jev = opts.jev ? createJevJudge(opts.jev) : void 0;
  const analyzer = createLiveAnalyzer({
    ...opts.analyzer,
    // A synchronous cache read. The network refresh below never sits on this
    // path, so a slow or dead Jev cannot delay analysis or the recorded call.
    ...jev ? { judge: jev.judge } : {}
  });
  function emit2(recs) {
    for (const rec of recs) {
      try {
        opts.onRecommendation(rec);
      } catch {
      }
    }
  }
  return {
    onEvent(event) {
      try {
        jev?.observe(event);
        emit2(analyzer.push(event));
        if (jev)
          void jev.refresh();
      } catch {
      }
    },
    flush() {
      const recs = analyzer.flush();
      emit2(recs);
      return recs;
    },
    ...jev ? { jev } : {}
  };
}
function tailLedger(onEvent, opts = {}) {
  const file = opts.path ?? ledgerPath();
  const intervalMs = opts.intervalMs ?? 500;
  let offset = 0;
  let remainder = "";
  let reading = false;
  const decoder = new StringDecoder("utf8");
  function parse(chunk) {
    const lines = (remainder + chunk).split("\n");
    remainder = lines.pop() ?? "";
    for (const line2 of lines) {
      if (!line2.trim())
        continue;
      try {
        onEvent(JSON.parse(line2));
      } catch {
      }
    }
  }
  try {
    const size = fs8.existsSync(file) ? fs8.statSync(file).size : 0;
    if (opts.backfill && size > 0) {
      const all = fs8.readFileSync(file, "utf8").split("\n").filter(Boolean);
      for (const line2 of all.slice(-opts.backfill)) {
        try {
          onEvent(JSON.parse(line2));
        } catch {
        }
      }
    }
    offset = size;
  } catch {
    offset = 0;
  }
  const timer = setInterval(() => {
    if (reading)
      return;
    reading = true;
    try {
      if (!fs8.existsSync(file))
        return;
      const size = fs8.statSync(file).size;
      if (size < offset) {
        offset = 0;
        remainder = "";
      }
      if (size === offset)
        return;
      const fd = fs8.openSync(file, "r");
      try {
        const len = size - offset;
        const buf = Buffer.alloc(len);
        fs8.readSync(fd, buf, 0, len, offset);
        offset = size;
        parse(decoder.write(buf));
      } finally {
        fs8.closeSync(fd);
      }
    } catch {
    } finally {
      reading = false;
    }
  }, intervalMs);
  if (!opts.keepAlive && typeof timer.unref === "function")
    timer.unref();
  return {
    stop() {
      clearInterval(timer);
    }
  };
}
function claudeProjectsRoot() {
  return path6.join(claudeConfigDir(), "projects");
}
function codexSessionsRoot() {
  return path6.join(codexHome(), "sessions");
}
function followFiles(opts) {
  const following = /* @__PURE__ */ new Map();
  let reading = false;
  let startup = true;
  function files() {
    const out = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs8.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path6.join(dir, e.name);
        if (e.isDirectory())
          walk(full);
        else if (e.isFile() && e.name.endsWith(".jsonl"))
          out.push(full);
      }
    };
    for (const root of opts.roots)
      if (fs8.existsSync(root))
        walk(root);
    return out;
  }
  function follow(file, atStartup) {
    let f = following.get(file);
    if (f)
      return f;
    let size = 0;
    try {
      size = fs8.statSync(file).size;
    } catch {
    }
    f = {
      offset: opts.backfill || !atStartup ? 0 : size,
      remainder: "",
      decoder: new StringDecoder("utf8"),
      state: opts.createState(file)
    };
    following.set(file, f);
    return f;
  }
  function emit2(event) {
    if (!event)
      return;
    try {
      opts.onEvent(event);
    } catch {
    }
  }
  function poll(force = false) {
    for (const file of files()) {
      const f = follow(file, startup);
      try {
        const size = fs8.statSync(file).size;
        if (size < f.offset) {
          f.offset = 0;
          f.remainder = "";
        }
        if (size > f.offset) {
          const fd = fs8.openSync(file, "r");
          try {
            const len = size - f.offset;
            const buf = Buffer.alloc(len);
            fs8.readSync(fd, buf, 0, len, f.offset);
            f.offset = size;
            const lines = (f.remainder + f.decoder.write(buf)).split("\n");
            f.remainder = lines.pop() ?? "";
            for (const line2 of lines)
              emit2(opts.onLine(f.state, line2, file));
          } finally {
            fs8.closeSync(fd);
          }
        }
      } catch {
      }
      if (opts.drain)
        for (const event of opts.drain(f.state, force))
          emit2(event);
    }
    startup = false;
  }
  poll();
  const timer = setInterval(() => {
    if (reading)
      return;
    reading = true;
    try {
      poll();
    } finally {
      reading = false;
    }
  }, opts.intervalMs);
  if (!opts.keepAlive && typeof timer.unref === "function")
    timer.unref();
  return {
    /**
     * Emit everything still buffered, settled or not, so a shutdown doesn't
     * lose the response in flight.
     */
    flush() {
      poll(true);
    },
    stop() {
      clearInterval(timer);
    }
  };
}
function tailTranscripts(onEvent, opts = {}) {
  const quietMs = opts.quietMs ?? 2e3;
  return followFiles({
    roots: opts.roots ?? [claudeProjectsRoot()],
    intervalMs: opts.intervalMs ?? 1e3,
    backfill: Boolean(opts.backfill),
    keepAlive: Boolean(opts.keepAlive),
    createState: () => createTranscriptState(),
    onLine: (state, line2, file) => {
      consumeTranscriptLine(state, line2, file);
      return null;
    },
    drain: (state, force) => takeSettled(state, force ? 0 : quietMs),
    onEvent
  });
}
function tailCodex(onEvent, opts = {}) {
  return followFiles({
    roots: opts.roots ?? [codexSessionsRoot()],
    intervalMs: opts.intervalMs ?? 1e3,
    backfill: Boolean(opts.backfill),
    keepAlive: Boolean(opts.keepAlive),
    createState: (file) => createCodexState(file),
    onLine: (state, line2) => consumeCodexLine(state, line2),
    onEvent
  });
}

// ../../packages/local/dist/rewriters.js
import fs9 from "node:fs";
import path7 from "node:path";
function claudeSettingsPath() {
  return path7.join(claudeConfigDir(), "settings.json");
}
function settingsAliasFor(modelId) {
  const id = modelId.toLowerCase();
  for (const family of ["haiku", "sonnet", "opus"]) {
    if (id.includes(family))
      return family;
  }
  return modelId;
}
var GLOBAL_CHANGE_SHARE = 0.8;
function claudeTarget(change, finding) {
  const slices = change.traffic?.slices.filter((s) => s.source === "claude-code");
  if (!slices)
    return change.toModelId;
  const busiest = [...slices].sort((a, b) => b.calls - a.calls)[0];
  if (!busiest)
    return void 0;
  return finding.candidate?.targetFor?.(busiest.model) ?? change.toModelId;
}
function claudeSettingsRewriter(opts = {}) {
  const file = opts.settingsPath ?? claudeSettingsPath();
  const minShare = opts.minShare ?? GLOBAL_CHANGE_SHARE;
  return {
    kind: "claude-code settings",
    supports(change, finding) {
      if (change.kind !== "swap-model" || opts.unless?.())
        return false;
      const target = claudeTarget(change, finding);
      return Boolean(target) && priceFor(target)?.provider === "anthropic";
    },
    install(change, finding) {
      const target = claudeTarget(change, finding);
      if (!target)
        return { ok: false, detail: "no target model on this recommendation" };
      const share = change.traffic?.shareBySource["claude-code"] ?? finding.affected.share;
      if (share < minShare) {
        const pct = (share * 100).toFixed(0);
        return {
          ok: false,
          declined: true,
          detail: `only ${pct}% of your Claude Code spend is affected, so changing its global model would downgrade the rest too; the fix is a per-agent override`
        };
      }
      const alias = settingsAliasFor(target);
      const now = `type /model ${alias} in the running Claude Code session to switch it now`;
      let settings = {};
      try {
        if (fs9.existsSync(file)) {
          settings = JSON.parse(fs9.readFileSync(file, "utf8"));
        }
      } catch (err) {
        return {
          ok: false,
          detail: `could not read ${file}: ${err instanceof Error ? err.message : String(err)}`
        };
      }
      if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
        return { ok: false, detail: `${file} is not a JSON object; leaving it alone` };
      }
      const previous = typeof settings.model === "string" ? settings.model : void 0;
      if (previous === alias) {
        return {
          ok: false,
          declined: true,
          detail: `${file} already sets model to "${alias}"`,
          now
        };
      }
      const next = { ...settings, model: alias };
      try {
        fs9.mkdirSync(path7.dirname(file), { recursive: true });
        fs9.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
      } catch (err) {
        return {
          ok: false,
          detail: `could not write ${file}: ${err instanceof Error ? err.message : String(err)}`
        };
      }
      const undo = previous ? `set "model": "${previous}" to undo` : `remove the "model" key to undo`;
      return {
        ok: true,
        detail: `${file} model ${previous ? `"${previous}"` : "(unset)"} -> "${alias}". Applies to your next session, not the one running. ${undo}`,
        now
      };
    }
  };
}

// ../../packages/local/dist/claude-mod.js
var ALIVE_MS = 3 * 6e4;
var KEEP_MS = 7 * 24 * 60 * 6e4;
var WINDOWS_FRESH_MS = 15 * 6e4;

// ../../packages/local/dist/compaction.js
var CODEX_KEY = "model_auto_compact_token_limit";
var CODEX_LINE = new RegExp(`^\\s*${CODEX_KEY}\\s*=\\s*(.*?)\\s*$`);

// ../../packages/local/dist/statusline.js
var TAIL_BYTES = 512 * 1024;

// ../../packages/local/dist/verify/replay.js
function applyCandidate(request, candidate) {
  const next = JSON.parse(JSON.stringify(request));
  const before = dialectOf(next);
  switch (candidate.kind) {
    case "swap-model": {
      const target = candidate.targetFor?.(next.model) ?? candidate.to;
      if (target)
        next.model = target;
      const limit = outputLimitOf(next);
      if (typeof limit === "number")
        setOutputLimit(next, before, limit);
      break;
    }
    case "lower-effort": {
      const effort = candidate.to ?? "low";
      if (before === "anthropic-messages") {
        next.output_config = { ...next.output_config ?? {}, effort };
      } else if (before === "openai-chat") {
        next.reasoning_effort = effort;
      } else {
        next.reasoning = { ...next.reasoning ?? {}, effort };
      }
      break;
    }
    case "enable-cache": {
      if (before !== "anthropic-messages")
        break;
      if (Array.isArray(next.tools) && next.tools.length > 0) {
        next.tools[next.tools.length - 1] = {
          ...next.tools[next.tools.length - 1],
          cache_control: { type: "ephemeral" }
        };
      } else if (typeof next.system === "string" && next.system.length > 0) {
        next.system = [{ type: "text", text: next.system, cache_control: { type: "ephemeral" } }];
      } else if (Array.isArray(next.system) && next.system.length > 0) {
        next.system[next.system.length - 1] = {
          ...next.system[next.system.length - 1],
          cache_control: { type: "ephemeral" }
        };
      }
      break;
    }
    case "trim-prompt":
      break;
  }
  return next;
}
function promptOf(sample) {
  const input = sample.request.input;
  if (typeof input === "string")
    return input;
  const msgs = sample.request.messages ?? input ?? [];
  const last = Array.isArray(msgs) ? msgs[msgs.length - 1] : void 0;
  const body = typeof last?.content === "string" ? last.content : textOf2(last?.content);
  return body || JSON.stringify(last?.content ?? "").slice(0, 4e3);
}
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (; ; ) {
      const i = cursor++;
      if (i >= items.length)
        return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
var DEFAULT_MAX_OUTPUT = 2048;
function clientFor(opts, provider) {
  return opts.clients?.[provider] ?? opts.client;
}
async function verifyCandidate(opts) {
  const bar = opts.bar ?? DEFAULT_BAR;
  const all = await readSamples({ route: opts.route });
  const samples = all.slice(-(bar.sampleSize ?? 40));
  if (samples.length === 0) {
    return {
      description: opts.candidate.description,
      samples: 0,
      baselineCostPerCall: 0,
      candidateCostPerCall: 0,
      savingPerCall: 0,
      monthlySaving: 0,
      checks: [],
      judge: null,
      verdict: "INCONCLUSIVE",
      reasons: [
        "No captured samples to replay. Enable capture in wrap() to verify on your own traffic."
      ],
      verificationCost: 0,
      unpricedCalls: 0
    };
  }
  let verificationCost = 0;
  let unpricedCalls = 0;
  let done = 0;
  const skipped = /* @__PURE__ */ new Set();
  const replayed = await mapLimit(samples, opts.concurrency ?? 4, async (sample) => {
    const request = applyCandidate(sample.request, opts.candidate);
    const dialect = dialectOf(request);
    const provider = providerOfDialect(dialect);
    const fail = (error) => {
      opts.onProgress?.(++done, samples.length);
      return { sample, response: null, cost: 0, error };
    };
    const client = clientFor(opts, provider);
    if (!client) {
      skipped.add(provider);
      return fail(`no ${provider} client supplied`);
    }
    if (outputLimitOf(request) === void 0) {
      setOutputLimit(request, dialect, DEFAULT_MAX_OUTPUT);
    }
    try {
      const response = await sendChat(client, request, dialect);
      const cost = costOf(response?.usage, response?.model ?? request.model);
      verificationCost += cost.total;
      if (cost.unpriced)
        unpricedCalls++;
      opts.onProgress?.(++done, samples.length);
      return { sample, response, cost: cost.total, error: null };
    } catch (err) {
      return fail(err?.message ? String(err.message) : "request failed");
    }
  });
  const ok = replayed.filter((r) => r.response);
  const failed2 = replayed.length - ok.length;
  const checks = bar.checks.map((check) => {
    let basePass = 0;
    let candPass = 0;
    for (const r of ok) {
      if (runCheck(check, r.sample.response.content, r.sample.response.content))
        basePass++;
      if (runCheck(check, r.response, r.sample.response.content))
        candPass++;
    }
    return {
      label: labelOf(check),
      baselinePassed: basePass,
      candidatePassed: candPass,
      total: ok.length,
      ok: candPass >= basePass
    };
  });
  let judge = null;
  const judgeProvider = bar.judge ? providerOf(bar.judge.model) : "";
  const judgeClient = bar.judge ? clientFor(opts, judgeProvider) : null;
  if (bar.judge && ok.length > 0 && judgeClient) {
    let wins = 0;
    let losses = 0;
    let ties = 0;
    let judgeCost = emptyJudgeCost();
    await mapLimit(ok, Math.min(3, opts.concurrency ?? 3), async (r) => {
      try {
        const { verdict: verdict2, cost } = await judgePair(judgeClient, bar.judge, promptOf(r.sample), textOf2(r.sample.response.content), textOf2(r.response));
        judgeCost = addJudgeCost(judgeCost, cost);
        if (verdict2 === "candidate")
          wins++;
        else if (verdict2 === "baseline")
          losses++;
        else
          ties++;
      } catch {
        ties++;
      }
    });
    const n = wins + losses + ties;
    judge = { wins, losses, ties, winRate: n > 0 ? (wins + ties * 0.5) / n : 0 };
    verificationCost += judgeCost.usd;
    unpricedCalls += judgeCost.unpriced;
  }
  const baselineTotal = ok.reduce((s, r) => s + costOf(r.sample.response.usage, r.sample.model).total, 0);
  const candidateTotal = ok.reduce((s, r) => s + r.cost, 0);
  const baselineCostPerCall = ok.length ? baselineTotal / ok.length : 0;
  const candidateCostPerCall = ok.length ? candidateTotal / ok.length : 0;
  const savingPerCall = baselineCostPerCall - candidateCostPerCall;
  const reasons = [];
  let verdict = "PASS";
  if (skipped.size > 0) {
    reasons.push(`Skipped traffic from ${[...skipped].join(" and ")}: no client for it. Set the API key and re-run to include it.`);
    verdict = "INCONCLUSIVE";
  }
  if (bar.judge && !judgeClient) {
    reasons.push(`Judge model ${bar.judge.model} is a ${judgeProvider} model and no ${judgeProvider} client was supplied, so judging was skipped.`);
    if (verdict === "PASS")
      verdict = "INCONCLUSIVE";
  }
  if (failed2 > 0) {
    reasons.push(`${failed2}/${replayed.length} replays failed outright`);
    if (failed2 / replayed.length > 0.05)
      verdict = "FAIL";
  }
  for (const c2 of checks) {
    if (!c2.ok) {
      reasons.push(`Check "${c2.label}" regressed: ${c2.candidatePassed}/${c2.total} vs baseline ${c2.baselinePassed}/${c2.total}`);
      verdict = "FAIL";
    }
  }
  if (judge) {
    const min = bar.judge?.minWinRate ?? 0.45;
    if (judge.winRate < min) {
      reasons.push(`Judge win rate ${(judge.winRate * 100).toFixed(0)}% is below the ${(min * 100).toFixed(0)}% bar (${judge.wins}W/${judge.losses}L/${judge.ties}T)`);
      verdict = "FAIL";
    } else {
      reasons.push(`Judge win rate ${(judge.winRate * 100).toFixed(0)}% clears the ${(min * 100).toFixed(0)}% bar (${judge.wins}W/${judge.losses}L/${judge.ties}T)`);
    }
  }
  if (unpricedCalls > 0) {
    reasons.push(`${unpricedCalls} verification call${unpricedCalls === 1 ? "" : "s"} could not be priced (unknown model or no usage reported), so ${usd(verificationCost)} is a floor, not the full cost of this check.`);
  }
  if (savingPerCall <= 0) {
    reasons.push(`No measured saving: ${usd(candidateCostPerCall)} vs ${usd(baselineCostPerCall)} per call`);
    if (verdict === "PASS")
      verdict = "FAIL";
  }
  if (ok.length < 10 && verdict === "PASS") {
    verdict = "INCONCLUSIVE";
    reasons.push(`Only ${ok.length} usable samples. Capture more traffic before trusting this`);
  }
  return {
    description: opts.candidate.description,
    samples: ok.length,
    baselineCostPerCall,
    candidateCostPerCall,
    savingPerCall,
    monthlySaving: savingPerCall * (opts.monthlyCalls ?? 0),
    checks,
    judge,
    verdict,
    reasons,
    verificationCost,
    unpricedCalls
  };
}

// ../../packages/local/dist/providers/anthropic.js
registerAdapter({
  provider: "anthropic",
  label: "Claude Code transcripts",
  canRead: (s) => s.kind === "local-transcripts",
  async read(s) {
    if (s.kind !== "local-transcripts")
      return { events: [], sources: [], warnings: [] };
    const data = await ingestClaudeCode({ root: s.root, days: s.days, project: s.project });
    return {
      events: data.events,
      sources: data.sources,
      warnings: data.warnings,
      compactions: data.compactions
    };
  }
});

// ../../packages/local/dist/providers/openai.js
registerAdapter({
  provider: "openai",
  label: "Codex transcripts",
  canRead: (s) => s.kind === "local-transcripts",
  async read(s) {
    if (s.kind !== "local-transcripts")
      return { events: [], sources: [], warnings: [] };
    const data = await ingestCodex({ root: s.root, days: s.days, project: s.project });
    return { events: data.events, sources: data.sources, warnings: data.warnings };
  }
});

// ../../packages/local/dist/providers/exports.js
registerAdapter({
  provider: "any",
  label: "SDK recorder",
  canRead: (s) => s.kind === "ledger",
  async read(s) {
    if (s.kind !== "ledger")
      return { events: [], sources: [], warnings: [] };
    const data = await readLedger({ days: s.days, project: s.project });
    return { events: data.events, sources: data.sources, warnings: data.warnings };
  }
});
registerAdapter({
  provider: "any",
  label: "Usage export",
  canRead: (s) => s.kind === "file",
  async read(s) {
    if (s.kind !== "file")
      return { events: [], sources: [], warnings: [] };
    const result = importUsageFile(s.path, { service: s.service });
    const warnings = [];
    if (result.skipped > 0) {
      warnings.push(`${s.path}: skipped ${result.skipped} row(s) with no model or token counts`);
    }
    return { events: result.events, sources: [s.path], warnings };
  }
});

// src/live-prompt.ts
function worthPrompting(f) {
  return f.savings.confidence !== "low";
}
function keyOf3(rec) {
  return `${rec.finding.rule}::${rec.trigger.route ?? rec.trigger.model}`;
}
function readKey() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isRaw);
    try {
      stdin.setRawMode?.(true);
    } catch {
    }
    stdin.resume();
    const done = (key) => {
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode?.(wasRaw);
      } catch {
      }
      stdin.pause();
      resolve(key);
    };
    const onData = (buf) => done(buf.toString("utf8"));
    stdin.on("data", onData);
  });
}
var CONFIDENCE_WORD = { high: "high confidence", medium: "likely", low: "possible" };
function line(out, label2, value, width = 52) {
  const lines = wrap(value, width);
  out.push(`  ${dim(label2.padEnd(15))} ${lines[0] ?? ""}`);
  for (const rest of lines.slice(1)) out.push(`  ${" ".repeat(15)} ${rest}`);
}
function renderCard(rec) {
  const f = rec.finding;
  const change = proposedChange(f);
  const out = [];
  const mins = Math.max(1, Math.round(rec.windowMs / 6e4));
  out.push("");
  out.push(
    `  ${yellow("\u26A1")} ${bold("optimAIzr")} ${dim("\xB7")} ${bold(rec.recommendation.action)} ${dim("\xB7")} ${CONFIDENCE_WORD[f.savings.confidence]}`
  );
  out.push("");
  line(out, "What happened", f.title);
  line(out, "Why it matters", f.why);
  if (change.from && change.to) {
    out.push(`  ${dim("Change".padEnd(15))} ${change.from} ${dim("->")} ${green(change.to)}`);
  } else {
    line(out, "Change", change.label);
  }
  out.push(
    `  ${dim("Saving".padEnd(15))} ${bold(green(usd(rec.observedUsd)))} ${dim(`could have been saved on ${f.affected.calls} call${f.affected.calls === 1 ? "" : "s"} in the last ${mins} min`)}`
  );
  const latest = rec.examples[0];
  if (latest) {
    const more = rec.sessions > 1 ? dim(` (+${rec.sessions - 1} more sessions)`) : "";
    out.push(
      `  ${dim("Latest".padEnd(15))} ${callSession(latest)} ${dim(projectName(latest.project))} ${callActivity(latest, 36)}${more}`
    );
  }
  out.push("");
  out.push(`  ${bold("[Y]")} Apply   ${bold("[N]")} Not now   ${bold("[D]")} Why?`);
  return out.join("\n");
}
function renderWhy(rec, jevEnabled) {
  const f = rec.finding;
  const s = f.savings;
  const out = [];
  const field = (label2, value) => {
    const lines = wrap(value, 52);
    out.push(`  ${dim(label2.padEnd(12))} ${lines[0] ?? ""}`);
    for (const line2 of lines.slice(1)) out.push(`  ${" ".repeat(12)} ${dim(line2)}`);
  };
  out.push("");
  out.push(`  ${bold("Why optimAIzr flagged this")}`);
  out.push("");
  field("Rule", `${f.rule} - a local rule, on ${rec.windowEvents} calls in the live window`);
  field("Basis", `${s.evidence.kind} - ${s.evidence.basis}`);
  field(
    "Affected",
    `${f.affected.calls} calls, ${(f.affected.share * 100).toFixed(0)}% of window spend`
  );
  field("Confidence", `${s.confidence} - ${s.confidenceBasis}`);
  out.push("");
  for (const line2 of wrap(s.calculation, 64)) out.push(`  ${dim(line2)}`);
  if (f.observations.length > 0) {
    out.push("");
    for (const o of f.observations.slice(0, 3)) out.push(`  ${dim("-")} ${o}`);
  }
  if (s.assumptions.length > 0) {
    out.push("");
    out.push(`  ${bold("Assuming")}`);
    for (const a of s.assumptions.slice(0, 3)) {
      const lines = wrap(a, 62);
      out.push(`  ${dim("-")} ${dim(lines[0] ?? "")}`);
      for (const line2 of lines.slice(1)) out.push(`    ${dim(line2)}`);
    }
  }
  out.push("");
  out.push(`  ${bold("Semantic judgment")}`);
  if (rec.judged) {
    const pct = (rec.judged.needsFrontierShare * 100).toFixed(0);
    out.push(
      `  ${blue("Jev")} ${dim("judged this traffic:")} ${pct}% ${dim(`likely it needs its current model (${rec.judged.sampled} calls judged).`)}`
    );
    out.push(`  ${dim("Jev agreed the work is mechanical, so the suggestion stands.")}`);
    out.push(`  ${dim("Jev saw route names and token counts only - never prompts or outputs.")}`);
  } else if (jevEnabled) {
    out.push(`  ${dim("Jev had no verdict for this traffic yet. This is a local rules-only")}`);
    out.push(`  ${dim("detection; Jev changes nothing unless it has an opinion.")}`);
  } else {
    out.push(`  ${dim("Not used. This is a local rules-only detection.")}`);
  }
  out.push("");
  out.push(`  ${dim("Next if you accept:")} ${nextCommandFor(f)}`);
  return out.join("\n");
}
function renderNow(now) {
  if (!now) return [];
  const [first = "", ...rest] = wrap(now, 60);
  return ["", `  ${bold("Now:")} ${first}`, ...rest.map((line2) => `       ${line2}`)];
}
function renderOutcome(outcome, dryRun) {
  const out = [];
  out.push("");
  switch (outcome.kind) {
    case "applied":
      out.push(`  ${green("Applied")} ${dim(`via ${outcome.via}`)}`);
      for (const line2 of wrap(outcome.detail, 66)) out.push(`  ${dim(line2)}`);
      for (const r of outcome.also ?? []) {
        out.push(
          r.applied ? `  ${green("Applied")} ${dim(`via ${r.via}`)}` : `  ${yellow("Not applied")} ${dim(`via ${r.via}`)}`
        );
        for (const line2 of wrap(r.detail, 66)) out.push(`  ${dim(line2)}`);
      }
      out.push(...renderNow(outcome.now));
      break;
    case "queued":
      if (outcome.declined) {
        out.push(`  ${yellow("Not applied")} ${dim("-")} ${dim(outcome.reason)}.`);
      } else {
        out.push(`  ${yellow("Not applied to that call")} ${dim("-")} ${dim(outcome.reason)}.`);
        for (const line2 of wrap(
          "optimaizr live watches the ledger, which is written after a response returns, so it reports on calls that have already been billed.",
          66
        )) {
          out.push(`  ${dim(line2)}`);
        }
      }
      out.push(...renderNow(outcome.now));
      out.push("");
      out.push(
        dryRun ? `  ${dim("Dry run: nothing was recorded.")} ${dim("Next would be:")} ${bold(outcome.next)}` : `  ${green("Recorded.")} ${dim("Next:")} ${bold(outcome.next)}`
      );
      break;
    case "failed":
      out.push(`  ${red("Could not apply")}`);
      for (const line2 of wrap(outcome.detail, 66)) out.push(`  ${dim(line2)}`);
      break;
  }
  return out.join("\n");
}
function createLivePrompt(opts) {
  const seen = /* @__PURE__ */ new Set();
  let chain = Promise.resolve();
  const read = opts.io?.read ?? readKey;
  const write = opts.io?.write ?? ((line2) => console.log(line2));
  async function asking(q) {
    opts.onAsk?.();
    try {
      await q();
    } finally {
      opts.onAnswered?.();
    }
  }
  async function yesNo(card, act) {
    write(card);
    for (; ; ) {
      write(`
  ${dim("[Y/N]")} `);
      const key = await read();
      const k = key.toLowerCase();
      if (key === "") {
        opts.onExit();
        return;
      }
      if (k === "y") {
        write(act());
        return;
      }
      if (k === "n" || key === "\r" || key === "\n") {
        write(`  ${dim("Not now. It won't be asked again this session.")}`);
        return;
      }
      write(`  ${dim("Press Y or N.")}`);
    }
  }
  async function ask(rec) {
    write(renderCard(rec));
    for (; ; ) {
      write(`
  ${dim("[Y/N/D]")} `);
      const key = await read();
      const k = key.toLowerCase();
      if (key === "") {
        opts.onExit();
        return;
      }
      if (k === "d") {
        write(renderWhy(rec, opts.jevEnabled));
        continue;
      }
      if (k === "y") {
        const outcome = accept(rec.finding, {
          ...opts.rewriters ? { rewriters: opts.rewriters } : {},
          ...opts.rewriter ? { rewriter: opts.rewriter } : {},
          traffic: rec.traffic,
          dryRun: opts.dryRun
        });
        write(renderOutcome(outcome, opts.dryRun));
        return;
      }
      if (k === "n" || key === "\r" || key === "\n") {
        write(`  ${dim("Continuing. This one won't be raised again this session.")}`);
        return;
      }
      write(`  ${dim("Press Y, N or D.")}`);
    }
  }
  return {
    offer(rec) {
      const key = keyOf3(rec);
      if (seen.has(key)) return;
      if (rec.withheld) {
        seen.add(key);
        write(opts.render(rec));
        return;
      }
      if (!opts.interactive || !worthPrompting(rec.finding)) {
        write(opts.render(rec));
        return;
      }
      seen.add(key);
      chain = chain.then(() => asking(() => ask(rec))).catch(() => void 0);
    },
    confirm(card, act) {
      if (!opts.interactive) {
        write(card);
        return;
      }
      chain = chain.then(() => asking(() => yesNo(card, act))).catch(() => void 0);
    },
    drain() {
      return chain;
    }
  };
}

// src/live-status.ts
var ACTIVE_MS = 15 * 6e4;
function emptyStatus(now = Date.now()) {
  return { startedAt: now, calls: 0, spendUsd: 0, sessions: /* @__PURE__ */ new Map(), found: /* @__PURE__ */ new Map() };
}
function recordCall(s, e, now = Date.now()) {
  s.calls++;
  s.spendUsd += e.cost.total;
  s.sessions.set(e.sessionId, now);
  s.last = { model: e.model, costUsd: e.cost.total, context: contextOf(e), at: now };
  s.checkedAt = now;
}
function ago(ms) {
  const sec = Math.max(0, Math.round(ms / 1e3));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  return min < 60 ? `${min}m ago` : `${Math.round(min / 60)}h ago`;
}
function cachePart(s, now) {
  const warm = s.cache?.warm(now) ?? [];
  const first = warm[0];
  if (!first) return null;
  if (first.expiresAt === null) {
    return dim(
      `codex ${tokens(first.context)} idle ${minutesLabel(now - Date.parse(first.event.ts))}`
    );
  }
  const left = first.expiresAt - now;
  const text = warm.length === 1 ? `cache ${tokens(first.context)} warm ${minutesLabel(left)}` : `${warm.length} warm caches, first expires in ${minutesLabel(left)}`;
  return left <= COUNTDOWN_MS ? yellow(text) : dim(text);
}
function renderStatus(s, now = Date.now(), width = 120) {
  const active = [...s.sessions.values()].filter((t) => now - t < ACTIVE_MS).length;
  const parts = [
    { text: `${blue("\u25C9")} optimAIzr live`, keep: 9 }
  ];
  if (s.calls === 0) {
    parts.push({ text: dim("watching for Claude Code, Codex and API calls..."), keep: 8 });
  } else {
    parts.push({ text: dim(`${active} active session${active === 1 ? "" : "s"}`), keep: 3 });
    parts.push({
      text: dim(`${s.calls} call${s.calls === 1 ? "" : "s"} \xB7 ${usd(s.spendUsd)} this run`),
      keep: 7
    });
    if (s.last) {
      parts.push({
        text: dim(
          `last ${modelLabel(s.last.model)} ${usd(s.last.costUsd)}, ${tokens(s.last.context)} context`
        ),
        keep: 5
      });
    }
    const cache = cachePart(s, now);
    if (cache) parts.push({ text: cache, keep: 6 });
    const found = [...s.found.values()].reduce((t, v) => t + v, 0);
    parts.push({
      text: s.found.size === 0 ? green("no issues") : yellow(`${s.found.size} found, ${usd(found)} avoidable`),
      keep: 8
    });
    if (s.checkedAt !== void 0) {
      parts.push({ text: dim(`checked ${ago(now - s.checkedAt)}`), keep: 4 });
    }
  }
  const line2 = () => parts.map((p) => p.text).join(dim(" \xB7 "));
  while (plain(line2()).length > width - 2) {
    const least = parts.reduce((a, p) => p.keep < a.keep ? p : a);
    if (least.keep >= 8) break;
    parts.splice(parts.indexOf(least), 1);
  }
  return clip2(line2(), width - 2);
}
var ESC3 = String.fromCharCode(27);
var plain = (x) => x.replace(new RegExp(`${ESC3}\\[[0-9;]*m`, "g"), "");
function clip2(text, max) {
  let out = "";
  let shown = 0;
  let inCode = false;
  for (const ch of text) {
    if (ch === ESC3) inCode = true;
    if (inCode) {
      out += ch;
      if (ch === "m") inCode = false;
      continue;
    }
    if (shown >= max) return `${out}${ESC3}[0m`;
    out += ch;
    shown++;
  }
  return out;
}
function renderRunSummary(s, now = Date.now()) {
  const mins = Math.max(1, Math.round((now - s.startedAt) / 6e4));
  const found = [...s.found.values()].reduce((t, v) => t + v, 0);
  const head = `  ${green("\u2713")} optimAIzr live ${dim(`\xB7 ${mins} min \xB7 ${s.calls} call${s.calls === 1 ? "" : "s"} \xB7 ${usd(s.spendUsd)} spent`)}`;
  if (s.found.size === 0) return `${head} ${dim("\xB7 nothing worth changing came up")}`;
  return `${head} ${dim("\xB7")} ${yellow(`${s.found.size} opportunit${s.found.size === 1 ? "y" : "ies"}, ${usd(found)} avoidable in this run`)}`;
}
var SILENT = {
  update: () => {
  },
  hold: () => {
  },
  release: () => {
  },
  attach: () => () => {
  },
  stop: () => {
  }
};
function createStatusLine(state, opts = { enabled: true }) {
  if (!opts.enabled || !process.stdout.isTTY) return SILENT;
  const now = opts.now ?? Date.now;
  let held = 0;
  let shown = false;
  let lastDraw = 0;
  let drawn = "";
  const write = (t) => process.stdout.write(t);
  const clear = () => {
    if (shown) write("\r\x1B[2K");
    shown = false;
  };
  const draw = () => {
    if (held > 0) return;
    const line2 = renderStatus(state, now(), process.stdout.columns || 120);
    if (shown && line2 === drawn) return;
    write(`\r\x1B[2K\x1B[?7l${line2}\x1B[?7h`);
    shown = true;
    drawn = line2;
    lastDraw = now();
  };
  const onResize = () => {
    clear();
    draw();
  };
  process.stdout.on("resize", onResize);
  const timer = setInterval(() => {
    if (held === 0) draw();
  }, 5e3);
  timer.unref();
  return {
    update() {
      if (now() - lastDraw >= 250) draw();
    },
    hold() {
      held++;
      clear();
    },
    release() {
      held = Math.max(0, held - 1);
      draw();
    },
    attach() {
      const original = console.log;
      console.log = (...args) => {
        clear();
        original(...args);
        draw();
      };
      draw();
      return () => {
        console.log = original;
      };
    },
    stop() {
      clearInterval(timer);
      process.stdout.off("resize", onResize);
      clear();
    }
  };
}

// src/version.ts
var VERSION = true ? "0.10.2" : "dev";

// src/update.ts
var DAY = 864e5;
var WHATS_NEW = {
  "0.9.0": [
    "Your Claude plan is detected, no --plan needed.",
    "Savings in exact dollars, split by how sure they are, plus the levers worth testing.",
    "live shows its work: a status line, context warnings, and Y to compact earlier.",
    "Detection is stricter, so figures are lower than 0.8 and hold up when checked."
  ]
};
function newer(a, b) {
  const parts = (v) => v.split("-")[0].split(".").map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}
function updatesEnabled(opts) {
  const off = opts.env.OPTIMAIZR_NO_UPDATE_CHECK;
  if (off && off !== "0" && off.toLowerCase() !== "false") return false;
  if (opts.env.CI) return false;
  return opts.isTTY && !opts.json && opts.configured !== false;
}
function updateLines(state, now, opts = {}) {
  const version = opts.version ?? VERSION;
  const out = [];
  const seen = state.seenVersion ?? (opts.usedBefore ? "0.0.0" : void 0);
  if (seen && seen !== version && newer(version, seen)) {
    const notes = WHATS_NEW[version];
    out.push(`  ${yellow("\u2728")} ${bold(`optimAIzr ${version}`)} ${dim("\xB7 what's new")}`);
    for (const line2 of notes ?? [`Updated from ${seen}.`]) {
      out.push(`     ${dim(line2)}`);
    }
    out.push(`     ${dim("Everything that changed:")} ${blue("optimaizr changelog")}`);
  }
  const due = !state.noticedAt || now - Date.parse(state.noticedAt) > DAY;
  if (state.latest && newer(state.latest, version) && due) {
    if (out.length) out.push("");
    out.push(
      `  ${yellow("\u2728")} ${bold(`optimAIzr ${state.latest} is available`)} ${dim(`\xB7 you have ${version}`)}`
    );
    out.push(
      `     ${blue("npm i -g optimaizr@latest")} ${dim("\xB7 what's in it: optimaizr changelog")}`
    );
  }
  return out;
}

// src/commands/changelog.ts
var CHANGELOG = true ? "# Changelog\n\n## 0.10.2\n\n- **How your compactions really went.** The compaction finding reads Claude\n  Code's own record of each compaction and says how many there were, how many\n  were automatic, how many landed mid-task, and how long you waited for the\n  summaries. It also prices compacting later, at 300K, 400K and 600K, next to\n  200K.\n- **`optimaizr apply context-compaction --at 400K`** sets a later point, from\n  100K to 1M, and `optimaizr undo context-compaction` puts back what was there.\n  Claude Code compacts a little before the point you set (around 167K with\n  200K), and the output now says so.\n- **Compact by hand when a piece of work is done.** Automatic compaction\n  usually lands mid-task, so the finding suggests\n  `/compact keep the API decisions` at a natural break instead.\n- **A shorter handoff note**: three lines (done, next, the file to open\n  first), under 80 words, in the mod and in the cache warning.\n- **A plan with no Claude Code usage** no longer headlines \"$0.00/mo, 0.0x\".\n  `optimaizr plan` names the folder it looked in instead.\n- **Small fixes.** \"from 1 days\" reads \"from 1 day\". Codex limit readings from\n  days ago show their date instead of passing for today. The status line in\n  `optimaizr live` no longer leaves copies of itself in panes narrower than\n  they report.\n- **Coming from 0.9?** 0.10.0 is the one to read: `optimaizr statusline on`\n  puts a cache countdown under Claude Code's prompt, and `optimaizr sessions`\n  shows where long conversations turn expensive. `optimaizr changelog 0.10.0`\n  has all of it.\n\n## 0.10.1\n\n- **A shorter README** that leads with what optimAIzr does and what it found,\n  with the last three releases in one line each. No code changes.\n- **Coming from 0.9?** 0.10.0 is the one to read: `optimaizr statusline on`\n  puts a cache countdown under Claude Code's prompt, and `optimaizr sessions`\n  shows where long conversations turn expensive. `optimaizr changelog 0.10.0`\n  has all of it.\n\n## 0.10.0\n\n**Where long sessions really lose money, measured, and a way out of them, from\nthe terminal you already have open.**\n\n- **`optimaizr statusline on`.** Claude Code's own status line, under the\n  prompt, shows the conversation's size, what each call pays to re-read it,\n  and how long its cache stays warm. In the last 15 minutes it counts down and\n  says what coming back after will cost; once the cache has gone it says what\n  the next message pays. Your 5-hour meter sits at the end. No mod needed. It\n  never replaces a status line you already have, and `optimaizr statusline\noff` takes it out. `optimaizr statusline` on its own says whether it is on\n  and shows what it would say for your latest conversation.\n- **`optimaizr live` counts down as well**, for Claude Code and Codex. The\n  status line at the bottom shows the warm cache that expires first, a\n  warning comes 5 minutes before a long conversation's cache expires (only\n  when coming back would cost 50 cents or more), and a call that came back to\n  an expired cache is shown with what it paid against a warm read. `--json`\n  emits both as `cache` events.\n- **`optimaizr --help` is grouped**: start here, change things, go deeper.\n- **`optimaizr sessions`** answers the questions people asked about the 0.9\n  numbers, from your own logs and with nothing estimated: how long sessions\n  run, the context size where re-reading becomes half of what a call costs,\n  whether the money sits in a few long sessions or many medium ones, and how\n  often you came back to a conversation after its cache expired. `--json` for\n  the numbers.\n- **Cold cache returns, a new rule (try tier).** Come back to a long\n  conversation after its cache expired and the first call writes all of it\n  again, at 2x the input rate on Claude Code's 1-hour cache. The rule counts\n  those returns from the cache writes they recorded and prices a fresh start\n  from a short handoff note against them, net of the note and the new\n  session's setup. Codex too: OpenAI caches on its own and sets no fixed\n  lifetime, so there a return is a mostly uncached call after 5 minutes or\n  more away, priced at the full input rate it paid.\n- **The compaction lever prices the reload at the rate your conversations\n  use.** After a compaction the conversation is written to the cache again;\n  that write is now priced at the 1-hour rate when that is what the\n  conversations use, not the 5-minute one, so the lever comes out lower and\n  closer to what a compaction costs.\n- **Re-reading is described at its real rate.** The profile and share card\n  say it is billed at the cache-read rate, the cheapest there is, and nothing\n  says \"a tenth\" any more: on Opus 5.5 a cache read is a twentieth of input.\n- **The mod counts down to the cache expiring.** Once a conversation carries\n  50K tokens or more, the band shows the last 15 minutes of its cache and what\n  coming back after will cost, with one toast 5 minutes before. Past 200K it\n  says what each request re-reads, once as a toast and then in the band.\n- **`/optimaizr handoff`.** Claude writes a short note (what changed, what was\n  decided, what is open, what to check first) from the warm cache, for cents.\n  `/clear`, and the next conversation in that project starts from it. A note\n  is used once, within 12 hours, and stays on your machine.\n\n## 0.9.0\n\n**optimAIzr knows your plan, counts only what holds up, and shows its work.**\n\n- **Your plan, detected.** `optimaizr profile` reads which Claude plan you are\n  signed in to (Pro, Max 5x or 20x, Team) from Claude Code's own account\n  details, so `--plan` is no longer needed. Only the plan fields are read. When\n  the tier isn't reported it says so and asks, it never guesses, and `--plan`\n  or the config still win. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are respected.\n- **Stricter detection.** Calls are grouped into tasks (a prompt and every\n  call it set off) and the rules judge the task. Fix-and-rerun debugging, files\n  being written, a subagent's own reads, re-reads after an edit or a\n  compaction, and model switches that would not pay back their cache reload\n  are no longer counted. Figures are lower than in 0.8 and hold up when\n  checked: on the author's own usage the headline went from $121/mo to $13/mo\n  of clear waste. The 0.8.1 note below quotes $89.56/mo for model-fit on a\n  month of real use; most of that was steps inside bigger tasks, and 0.9 puts\n  the same month at $1.74/mo.\n- **Savings in three tiers, in exact dollars.** Clear waste (fix it, nothing\n  to lose) is the headline. Likely savings that change what the model does\n  show as `+$X`. Trade-offs worth testing show as `up to $X` and are never\n  added in. `waste`, `recommend` and `profile` now agree on the total.\n- **Every recommendation says what happened, why it matters and what to do**,\n  and how sure it is: high confidence, likely or possible.\n- **Two levers, sized from your own usage**, for Claude Code and Codex.\n  Compact earlier: every call re-reads the conversation, which is usually the\n  biggest part of the bill, and compacting at 200K is replayed on your own\n  sessions, net of what the compactions cost. A smaller default model, for\n  work without heavy reasoning. `optimaizr apply context-compaction` sets\n  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` for Claude Code and\n  `model_auto_compact_token_limit` for Codex; `optimaizr undo\ncontext-compaction` puts back what was there.\n- **A new profile.** It leads with what your plan does at API prices, then the\n  savings found, the biggest win (on a plan, as more work per 5-hour window)\n  and where the money goes. The share card follows it.\n- **`live` shows its work.** A status line with calls, spend, the last call\n  and what it found; a notice when a conversation's context jumps or passes\n  200K, with what re-reading costs on that call; `Y` to compact earlier from\n  then on; cards that say what happened, the change and the money; and a\n  summary when you stop.\n- **Codex** gets tasks, blind-retry detection (a non-zero exit now counts as\n  a failure), both levers and its own compactions. A model now steps down to\n  its own smaller variant: GPT-5.4 to GPT-5.4 mini, not GPT-5 mini.\n- **The mod** writes Claude Code's real 5-hour and weekly meters into its\n  session file, so `profile` and `live` show them instead of a learned limit.\n- **Update awareness.** Once a day a background request asks the npm registry\n  for the latest version number (nothing about you or your usage is sent, and\n  no command waits for it), and a later run says when there is a newer one.\n  `optimaizr changelog` shows what changed. Off with\n  `OPTIMAIZR_NO_UPDATE_CHECK=1` or `\"updateCheck\": false` in the config.\n\n## 0.8.1\n\n- **`optimaizr live --auto`.** Confident model and effort findings about\n  Claude Code are applied through the mod without asking; everything else still\n  asks. Each automatic switch says so once, in a toast and a note, the band and\n  the pane mark it `(auto)`, and `p` in the HUD or `/optimaizr off` undoes it.\n  The payback check below still holds a long conversation back.\n- **A switch waits until it pays.** Switching a conversation mid-way means the\n  new model reloads it into its cache, and on a long session that can cost\n  more than the switch saves. The mod now weighs it: the reload's cost against\n  what an average request in this session saves, and it switches a\n  conversation under way only when that pays back within 10 requests. Until\n  then the band says `waiting` and why, such as `reload $0.38 pays back in\n~43 requests`. Subagents start with an empty cache, so they switch right\n  away, and so does a conversation idle for over an hour, whose cache has\n  expired.\n- **Opus steps down to Sonnet, not Haiku.** The model-fit finding moves simple\n  work one tier down within its provider: Opus to Sonnet 5.5 (half the price),\n  Sonnet to Haiku 4.5, GPT-5 to GPT-5 mini. Sonnet 5.5's 1M-token window also\n  takes the long-context calls Haiku's 200K window couldn't, so the finding\n  usually covers more traffic: on one month of real use, $89.56/mo instead of\n  $45.51.\n- **`/optimaizr hud`.** A heads-up display docked beside Claude: what it\n  is doing right now (`\u25CF on Sonnet 5.5`, `\u25CF waiting`, `\u25CF paused`), what the\n  switch saved, how much cheaper it ran and roughly what share of your\n  5-hour window that is, spend, burn rate per hour, cache\n  hits, both plan windows as gauges with when the 5-hour one runs out, a\n  coloured sparkline of the last turns with the priciest one named, and a\n  button (`p`) that pauses or resumes the switch.\n- **A meter you can read at a glance.** The band's meter turns from green to\n  yellow to red as the window fills, and a toast says when it passes 80% and\n  95%, with the time left at this pace. Another says when a session's savings\n  pass $0.50, $1, $2 and so on.\n- **Subagent savings priced right.** A subagent writes its cache from scratch\n  on either model, so its first request no longer counts as a reload.\n\n- **Fixes.** A model-fit finding over more than one model (Opus and Sonnet\n  traffic, each with its own step down) could no longer be applied with Y. It\n  can again, each model to its own target. The question card no longer repeats\n  `Change:` on every wrapped line, and `--auto` says why when it asks after all.\n\n## 0.8.0\n\n**optimAIzr inside Claude Code.** Claude Code 2.1.287 added mods, plugins that\nrun inside Claude Code itself, and optimAIzr now ships one. Install it from a\nClaude Code session:\n\n```\n/plugin marketplace add blendbunjaku/optimaizr\n/plugin install optimaizr@optimaizr\n```\n\n- **The numbers where you work.** While Claude works, the spinner shows what\n  the turn has cost so far and how full your 5-hour window is. The band above\n  the prompt shows the window, how long it lasts at this pace and when it\n  resets, read from Claude Code's own limit meter rather than estimated. Each\n  answer gets one dim line with its cost, its requests and how far the window\n  moved (the `turnLine` option turns it off). `/optimaizr` prints the\n  session's spend, both plan windows and any active switch.\n- **`Y` in `live` switches the running Claude Code session.** Claude Code reads\n  its model when a session starts, so until now `Y` could only change the next\n  one. With the mod loaded, an accepted swap reaches running sessions from\n  their next request, with no restart. It is as narrow as the finding: one\n  project, and only subagents or only the main conversation when that is what\n  the finding covered, and only when it covers at least 80% of that traffic's\n  spend. If the API refuses the new model, the request goes out on the\n  original and the session stays on it. The first switched request leaves a\n  note in the conversation, and the band keeps saying which model you are on.\n  For a harder task, `/optimaizr off` sends that session back to its own model\n  and `/optimaizr on` resumes; `optimaizr undo <rule>` removes the switch\n  everywhere within seconds. Without the mod, `Y` still writes\n  `~/.claude/settings.json` for your next session.\n- **See what a switch saved.** Each switched request is priced twice: what it\n  cost, and what the same tokens would have cost on the original model. A\n  switched turn's line leads with the difference (`saved $0.10 vs Opus 5.5 \xB7\nthis turn $0.10 on Sonnet 5.5 \xB7 \u2026`), the band keeps a running total and\n  `/optimaizr` adds it up for the session. The first request on the new model\n  writes the conversation to its cache, where the original model would have\n  read it, so it can cost more; its line says by how much, and why.\n- **Lower reasoning effort, live.** Accept a reasoning-effort finding in `live`\n  and sessions running the mod use less effort on that work from their next\n  request, on the same model. It only ever lowers effort, and\n  `/optimaizr off` goes back. Like a model switch, the first request at the\n  new effort reads the conversation once without the cache.\n- **A guard against retry loops.** When the same command fails twice in a row\n  with nothing changed in between, the mod holds the next identical attempt\n  once and asks Claude to change something first. Asked again, it goes\n  through. The `retryGuard` option turns it off.\n- **`optimaizr mod`** prints the install steps, which sessions are running the\n  mod, and any active switch. `--json` for scripts.\n- **Still fully local.** The mod reads the usage figures Claude Code already\n  shows you, the commands Claude runs (kept in memory for the retry guard) and\n  `~/.optimaizr/overrides.json`, and writes one small file per session to\n  `~/.optimaizr/mod/sessions`. It never reads your prompts or file contents and\n  makes no network calls; `claude plugin validate mods/optimaizr` lists every\n  call it makes.\n- **Findings say where they came from.** Each `live` finding lists the\n  sessions behind it and its latest calls: time, session id (marked `sub` for\n  a subagent), project, and what the call did, e.g. `Read .../src/app.ts` or\n  `Bash npm test`. `optimaizr show <rule>` prints the same under every row,\n  and `live --json` carries `sessions` and `examples`. With several agents\n  running at once, you can now tell which one a finding is about.\n- **`live` stays quiet about cents.** A finding must have cost $0.25 over the\n  window before it is announced (was $0.01). `--min-usd` still overrides it.\n- **Windows project names.** `show` now shortens `C:\\...\\repo` to `repo`.\n\n## 0.7.1\n\n- **New README and tagline.** The npm page leads with what optimAIzr does,\n  with real output for each step, and `optimaizr --help` and the package\n  description now read \"Spend fewer tokens on the same work.\" No behaviour\n  changes.\n\n## 0.7.0\n\n- **Claude Team plans.** `--plan team` (Standard seat, $25) and\n  `--plan team-premium` ($125) show your 5-hour sessions like Pro and Max,\n  priced per seat. `--plan enterprise` and `--plan free` explain what to use\n  instead: Enterprise bills usage at API rates, so `--budget` is its measure,\n  and Free doesn't include Claude Code.\n- **Every ChatGPT plan Codex reports, named and priced.** Pro 5x ($100) and\n  Pro 20x ($200) are told apart, Go is priced at $8, and Team shows under its\n  new name, Business. A plan newer than optimAIzr is shown as Codex names it,\n  without a price.\n- **Claude Sonnet 5.5.** Priced at $2/$10 per million tokens (cache reads\n  $0.20) and reported as its own model. Before, its calls were counted as\n  Sonnet 5.\n- **`optimaizr limit` points at your plan.** Its closing hint said\n  `--plan pro` for everyone; it now uses the plan you set.\n- **`verify`'s judge has room to answer.** Opus 5 thinks by default, and a\n  16-token ceiling could cut it off before its verdict, which scored as a tie.\n  The ceiling is now 1,024.\n- **Fixes.** The cost-spike finding pointed at a `why --day` flag that doesn't\n  exist (it now suggests `optimaizr show cost-spike`). A flag written\n  `--name=a=b` kept only `a`. `live` read recent history up to three times at\n  start and now reads it once.\n- **Open source.** The CLI, its analysis engine and the local host are now\n  developed in the open at\n  [github.com/blendbunjaku/optimaizr](https://github.com/blendbunjaku/optimaizr),\n  under the MIT license.\n\n## 0.6.1\n\n- **`Y` in `live` switches your app's next request.** Apps using `wrap()` pick\n  up an accepted model swap from their next call, with no restart.\n  `optimaizr undo <rule>` takes it back the same way, and `optimaizr undo`\n  lists what is active.\n- **Large Claude Code histories are read in full.** Past roughly 100,000\n  recorded responses, reading transcripts failed with \"Maximum call stack size\n  exceeded\" and reports showed Codex usage only. One unreadable transcript is\n  now skipped instead of taking the rest with it.\n- **A source that fails can't be missed.** If one can't be read, every command\n  says so at the top, in red.\n- **`optimaizr feedback`** prints where to report a bug, with the version line\n  to include.\n\n## 0.6.0\n\n- **5-hour sessions on Claude Pro and Max.** `--plan pro` (or `max5`, `max20`)\n  shows how much of the current session you've used, when it resets, and how\n  much of each session goes on waste. Anthropic doesn't publish the limit, so\n  run `optimaizr limit` when you hit it and it learns yours.\n- **ChatGPT plans, read straight from Codex.** Codex records OpenAI's own\n  meter, so `profile` shows your plan, how much of the 5-hour and weekly limits\n  you've used, and when each resets.\n- **Limit warnings in `live`.** Warns at 80% and 95% of your Codex limits and\n  your Claude session limit, and `live --budget 300` at 50, 80, 95 and 100% of\n  a monthly cap.\n- **Monthly budgets.** `--budget 300` names the day a monthly cap runs out at\n  this pace, and how many days the fixes buy back.\n- **`optimaizr card`.** Your last 30 days as an image to share. Totals only,\n  no project names.\n- **\"At this rate\" means now.** Monthly figures project your last 30 days\n  instead of averaging your whole history.\n\n## 0.5.0\n\n- **`optimaizr profile`.** One screen: what you spend, how much of it is waste,\n  and the single biggest opportunity, with the next command to run.\n- **Current models priced.** Claude Opus 5.5 and Fable 5.1, GPT-6 Astra, Sol\n  and Luna, and GPT-5.1 through 5.6. Before, some of these were costed at an\n  older model's rate or went unpriced.\n- **OpenAI cache writes.** GPT-5.6 and later bill cache writes at 1.25x input,\n  and past 272K input tokens the whole request moves to the long-context rate.\n  Both are now costed as OpenAI bills them.\n\n## 0.4.0\n\n- **`optimaizr live`.** Watches calls as they land and raises a fix the moment\n  a pattern crosses its threshold, using the same rules as the reports. Follows\n  Claude Code and Codex sessions as they are written, and the SDK ledger.\n- **Codex transcripts.** OpenAI agent spend is read from `~/.codex/sessions`\n  with no setup.\n- **Gemini, built but off.** Enable with `OPTIMAIZR_GEMINI=1` once you've\n  checked its rates.\n- **Self-contained reports.** The HTML report makes no network requests.\n" : "";
function changelogSections(text = CHANGELOG) {
  const out = [];
  for (const part of text.split(/^## /m).slice(1)) {
    const [head = "", ...rest] = part.split("\n");
    out.push({ version: head.trim(), body: rest.join("\n").trim() });
  }
  return out;
}

// src/index.ts
var index_default = { wrap: wrap2, withRoute, record };
export {
  BATCH_MULTIPLIER,
  CACHE_MULTIPLIER,
  DEFAULT_BAR,
  LIVE_DEFAULTS,
  MODELS,
  accept,
  applyCandidate,
  changelogSections,
  claudeProjectsRoot,
  claudeSettingsPath,
  claudeSettingsRewriter,
  codexSessionsRoot,
  costOf,
  costOnModel,
  createJevJudge,
  createLiveAnalyzer,
  createLivePrompt,
  createLiveSession,
  createStatusLine,
  index_default as default,
  defaultRedact,
  drain,
  emptyStatus,
  findWaste,
  ingestClaudeCode,
  inputRateOf,
  judgePair,
  ledgerPath,
  newer,
  nextCommandFor,
  optimaizrDir,
  overridesPath,
  priceFor,
  proposedChange,
  ratesFor,
  readLedger,
  readOverrides,
  readSamples,
  record,
  recordCall,
  removeOverrides,
  renderRunSummary,
  renderStatus,
  runCheck,
  sdkOverrideRewriter,
  summarize,
  tailCodex,
  tailLedger,
  tailTranscripts,
  tokens,
  updateLines,
  updatesEnabled,
  usd,
  verifyCandidate,
  withRoute,
  wrap2 as wrap
};
