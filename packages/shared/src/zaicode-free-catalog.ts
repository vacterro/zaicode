/**
 * ZAICODE free-model catalog (SRC-035, T-46): the legitimate free tiers
 * SAIFREN is built from, and the pure rules that keep the SAIFREN pool in
 * 9router filled from them.
 *
 * Keyless providers publish an anonymous tier on purpose (their docs and
 * model lists mark it); ZAICODE uses exactly that and nothing that imitates
 * another client or works around a provider's restriction. Free-key
 * providers issue a free key without a card; ZAICODE only walks the operator
 * to the provider's own key page and stores the key in 9router.
 */

export interface ZaicodeFreeProvider {
  id: string;
  name: string;
  /** 9router node prefix: models appear as `<prefix>/<model>`. */
  prefix: string;
  /** OpenAI-compatible base URL (9router appends /chat/completions). */
  baseUrl: string;
  /** Public model list; answers without a key for keyless providers. */
  modelsUrl: string;
  /** Anonymous tier: works with no key at all. */
  keyless: boolean;
  /** Where the operator gets a free key (free-key providers). */
  keyUrl?: string;
  /** Provider's own page about its free tier / terms. */
  infoUrl: string;
  /** One line for people: what you get. */
  blurb: string;
  /** Models known to answer on the free tier, first = preferred. */
  starterModels: readonly string[];
}

/** Placeholder bearer for keyless providers; 9router always sends some key. */
export const ZAICODE_KEYLESS_API_KEY = "anonymous";

export const ZAICODE_FREE_PROVIDERS: readonly ZaicodeFreeProvider[] = [
  {
    id: "kilo",
    name: "Kilo Gateway (free)",
    prefix: "kilo",
    baseUrl: "https://api.kilo.ai/api/gateway",
    modelsUrl: "https://api.kilo.ai/api/gateway/models",
    keyless: true,
    keyUrl: "https://app.kilo.ai",
    infoUrl: "https://kilo.ai/docs",
    blurb: "Free models without an account (rate-limited per IP); a free key raises the limits.",
    starterModels: ["kilo-auto/free"],
  },
  {
    id: "pollinations",
    name: "Pollinations (free)",
    prefix: "pol",
    baseUrl: "https://text.pollinations.ai/openai",
    modelsUrl: "https://text.pollinations.ai/models",
    keyless: true,
    infoUrl: "https://pollinations.ai",
    blurb: "Anonymous tier of Pollinations' open text API.",
    starterModels: ["openai-fast"],
  },
  {
    id: "llm7",
    name: "LLM7 (free)",
    prefix: "llm7",
    baseUrl: "https://api.llm7.io/v1",
    modelsUrl: "https://api.llm7.io/v1/models",
    keyless: true,
    keyUrl: "https://token.llm7.io",
    infoUrl: "https://llm7.io",
    blurb: "Anonymous allowance on some models (checked ones only); a free token opens the rest.",
    starterModels: ["GLM-5.3-Flash", "codestral-latest"],
  },
  {
    id: "openrouter",
    name: "OpenRouter (free models)",
    prefix: "or",
    baseUrl: "https://openrouter.ai/api/v1",
    modelsUrl: "https://openrouter.ai/api/v1/models",
    keyless: false,
    keyUrl: "https://openrouter.ai/keys",
    infoUrl: "https://openrouter.ai/models?max_price=0",
    blurb: "Free key, no card: dozens of `:free` models from many labs.",
    starterModels: [],
  },
  {
    id: "gemini",
    name: "Google AI Studio (Gemini free tier)",
    prefix: "gem",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    keyless: false,
    keyUrl: "https://aistudio.google.com/apikey",
    infoUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    blurb: "Free key with a Google account: Gemini Flash models, very long context.",
    starterModels: [],
  },
  {
    id: "groq",
    name: "Groq (free tier)",
    prefix: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    modelsUrl: "https://api.groq.com/openai/v1/models",
    keyless: false,
    keyUrl: "https://console.groq.com/keys",
    infoUrl: "https://console.groq.com/docs/rate-limits",
    blurb: "Free key, no card: very fast open models.",
    starterModels: [],
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM (free tier)",
    prefix: "nim",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelsUrl: "https://integrate.api.nvidia.com/v1/models",
    keyless: false,
    keyUrl: "https://build.nvidia.com",
    infoUrl: "https://build.nvidia.com",
    blurb: "Free developer key: a large catalogue of open-weight models.",
    starterModels: [],
  },
  {
    id: "cerebras",
    name: "Cerebras (free tier)",
    prefix: "cbr",
    baseUrl: "https://api.cerebras.ai/v1",
    modelsUrl: "https://api.cerebras.ai/v1/models",
    keyless: false,
    keyUrl: "https://cloud.cerebras.ai",
    infoUrl: "https://inference-docs.cerebras.ai",
    blurb: "Free key, no card: fast open models.",
    starterModels: [],
  },
  {
    id: "mistral",
    name: "Mistral (free tier)",
    prefix: "mis",
    baseUrl: "https://api.mistral.ai/v1",
    modelsUrl: "https://api.mistral.ai/v1/models",
    keyless: false,
    keyUrl: "https://console.mistral.ai/api-keys",
    infoUrl: "https://docs.mistral.ai",
    blurb: "Free experiment plan key: Mistral and Codestral models.",
    starterModels: [],
  },
  {
    id: "opencode",
    name: "OpenCode Zen (free models)",
    prefix: "zen",
    baseUrl: "https://opencode.ai/zen/v1",
    modelsUrl: "https://opencode.ai/zen/v1/models",
    keyless: false,
    keyUrl: "https://opencode.ai/auth",
    infoUrl: "https://opencode.ai/docs/zen/",
    blurb: "Free OpenCode key: the rotating `-free` coding models of OpenCode Zen.",
    starterModels: [],
  },
];

export function findZaicodeFreeProvider(id: string): ZaicodeFreeProvider | undefined {
  return ZAICODE_FREE_PROVIDERS.find((provider) => provider.id === id);
}

const NON_CHAT = /whisper|tts|embed|bge-|stable-diffusion|guard|safety|lyria|image|vision-only|rerank|moderation|audio|speech/i;

function priceIsZero(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const number = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) && number === 0;
}

/**
 * Model ids a provider's own list marks as free, chat models only. Rules per
 * provider, each from the provider's published list format:
 * - Kilo / OpenRouter: `:free` suffix or zero prompt+completion price;
 * - Pollinations: `tier: "anonymous"`;
 * - OpenCode Zen: `-free` in the id;
 * - LLM7: none (its anonymous allowance covers only some models; the checked
 *   starter models are used, nothing is guessed);
 * - key-scoped free tiers (Gemini, Groq, NVIDIA, Cerebras, Mistral): every chat model the key lists.
 */
export function zaicodeFreeModelsFromListing(providerId: string, listing: unknown): string[] {
  const root = listing as { data?: unknown } | unknown[] | null;
  const rows = Array.isArray(root) ? root : Array.isArray((root as { data?: unknown } | null)?.data) ? ((root as { data: unknown[] }).data) : [];
  const ids: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : null;
    if (!id || NON_CHAT.test(id)) continue;
    const pricing = (record.pricing ?? {}) as Record<string, unknown>;
    let free: boolean;
    switch (providerId) {
      case "kilo":
      case "openrouter":
        free = id.endsWith(":free") || id.endsWith("/free") || (priceIsZero(pricing.prompt) && priceIsZero(pricing.completion));
        break;
      case "pollinations":
        free = record.tier === "anonymous";
        break;
      case "llm7":
        free = false;
        break;
      case "opencode":
        free = /-free\b/.test(id);
        break;
      default:
        free = true;
    }
    if (free && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** `<prefix>/<model>` as 9router addresses it. */
export function zaicodePoolModelId(provider: Pick<ZaicodeFreeProvider, "prefix">, modelId: string): string {
  return `${provider.prefix}/${modelId}`;
}

/** Models a scan found that the pool does not have yet (and were not removed by the operator). */
export function zaicodeNewFreeModels(
  found: readonly string[],
  pool: readonly string[],
  removedByOperator: readonly string[] = [],
): string[] {
  const have = new Set(pool);
  const removed = new Set(removedByOperator);
  return found.filter((id) => !have.has(id) && !removed.has(id));
}

export interface ZaicodeFreePoolPlanInput {
  /** 9router nodes: prefix + base URL. */
  nodes: readonly { id: string; prefix: string; baseUrl?: string | null }[];
  /** 9router connections: which node, active or not. */
  connections: readonly { id: string; provider: string; isActive?: boolean }[];
  /** Current SAIFREN models, or null when the pool does not exist. */
  pool: readonly string[] | null;
}

export type ZaicodeFreePoolStep =
  | { kind: "create-node"; provider: ZaicodeFreeProvider }
  | { kind: "create-connection"; provider: ZaicodeFreeProvider; nodeId: string | null }
  | { kind: "create-pool"; models: string[] }
  | { kind: "add-models"; models: string[] };

function sameUrl(left: string | null | undefined, right: string): boolean {
  return (left ?? "").replace(/\/+$/, "").toLowerCase() === right.replace(/\/+$/, "").toLowerCase();
}

/**
 * The idempotent plan that makes SAIFREN answer with no setup: every keyless
 * provider has a node and a connection, the pool exists, and it holds the
 * starter models (appended after the operator's own, never reordered or
 * removed). Running the plan twice does nothing the second time.
 */
export function planZaicodeFreePool(input: ZaicodeFreePoolPlanInput, providers: readonly ZaicodeFreeProvider[] = ZAICODE_FREE_PROVIDERS): ZaicodeFreePoolStep[] {
  const steps: ZaicodeFreePoolStep[] = [];
  const wanted: string[] = [];
  for (const provider of providers.filter((candidate) => candidate.keyless)) {
    const node = input.nodes.find((candidate) => candidate.prefix === provider.prefix || sameUrl(candidate.baseUrl, provider.baseUrl));
    if (!node) {
      steps.push({ kind: "create-node", provider });
      steps.push({ kind: "create-connection", provider, nodeId: null });
    } else if (!input.connections.some((connection) => connection.provider === node.id)) {
      steps.push({ kind: "create-connection", provider, nodeId: node.id });
    }
    const prefix = node?.prefix ?? provider.prefix;
    for (const model of provider.starterModels) wanted.push(`${prefix}/${model}`);
  }
  if (input.pool === null) {
    steps.push({ kind: "create-pool", models: wanted });
  } else {
    const missing = wanted.filter((model) => !input.pool!.includes(model));
    if (missing.length > 0) steps.push({ kind: "add-models", models: missing });
  }
  return steps;
}

/** Pool names ZAICODE provisions: SAIFREN = free, SAIOPP = the operator's own best. */
export const ZAICODE_FREE_POOL = "SAIFREN";
export const ZAICODE_OWN_POOL = "SAIOPP";
