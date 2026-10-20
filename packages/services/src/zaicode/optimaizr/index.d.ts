/**
 * Model catalogue and cost maths. Prices live only here, and they're dated: a
 * call is costed at the rate card in force on its day, so a later price change
 * doesn't rewrite history. Users can add or override models in
 * `~/.optimaizr/models.json` or the `models` key of `optimaizr.config.json`.
 */
export type Tier = "frontier" | "balanced" | "fast";
export type Capability = "tools" | "vision" | "reasoning" | "batch" | "caching" | "structured-output";
/** A price that was in effect over a date range. */
export interface RateCard {
	/** Inclusive ISO date this rate took effect. */
	from: string;
	/** Inclusive ISO date it stopped applying. Absent means "still current". */
	until?: string;
	inputPerM: number;
	outputPerM: number;
	/**
	 * Explicit cached-input rate. When absent, the provider's cache-read
	 * multiplier is applied to `inputPerM`.
	 */
	cachedInputPerM?: number;
	/**
	 * Explicit cache-write rate for every TTL. When absent, the provider's write
	 * multipliers apply. (OpenAI writes are free before GPT-5.6 and 1.25x input
	 * from it, which is per model, so it lives here.)
	 */
	cacheWritePerM?: number;
	/**
	 * Rates that replace the ones above once a call's prompt passes
	 * `aboveTokens`. Gemini Pro roughly doubles past its long-context threshold.
	 */
	longContext?: {
		aboveTokens: number;
		inputPerM: number;
		outputPerM: number;
		cachedInputPerM?: number;
		cacheWritePerM?: number;
	};
	/** Why this card exists, e.g. "introductory pricing". */
	label?: string;
}
export interface ModelPrice {
	id: string;
	label: string;
	provider: string;
	tier: Tier;
	/** Chronological rate cards. The last card with no `until` is current. */
	rates: RateCard[];
	contextTokens: number;
	maxOutputTokens: number;
	capabilities: Capability[];
	/** Fast-mode premium pricing, where the model supports `speed: "fast"`. */
	fast?: {
		inputPerM: number;
		outputPerM: number;
	};
	/** Short note used by `optimaizr guide` when recommending a route. */
	bestFor: string;
}
/**
 * How each provider prices cache traffic, as multipliers on the input rate.
 * A model may override any of these with an explicit rate.
 */
export interface ProviderCachePolicy {
	read: number;
	write5m: number;
	write1h: number;
	/** Discount applied to asynchronous batch traffic. */
	batch: number;
	/**
	 * True when the reported input count already includes cache reads (OpenAI's
	 * `prompt_tokens` does, Anthropic's `input_tokens` doesn't). `normalizeUsage`
	 * subtracts them so "input" means the same thing for every vendor.
	 */
	inputIncludesCacheReads?: boolean;
}
/** Anthropic's cache multipliers, kept as a named export for readability. */
export declare const CACHE_MULTIPLIER: ProviderCachePolicy;
export declare const BATCH_MULTIPLIER: number;
/** The live catalogue, built-ins plus anything registered at runtime. */
export declare const MODELS: ModelPrice[];
/**
 * Resolve a model id to its price card. Handles the date-suffixed ids every
 * provider emits, the platform prefixes used on Bedrock and Vertex, and the
 * `vendor/model` form gateways such as OpenRouter and LiteLLM pass through.
 */
export declare function priceFor(modelId: string | undefined | null): ModelPrice | null;
export interface UsageLike {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_creation?: {
		ephemeral_5m_input_tokens?: number;
		ephemeral_1h_input_tokens?: number;
	};
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
	};
	completion_tokens_details?: {
		reasoning_tokens?: number;
	};
	input_tokens_details?: {
		cached_tokens?: number;
		cache_write_tokens?: number;
	};
	output_tokens_details?: {
		reasoning_tokens?: number;
		thinking_tokens?: number;
	};
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	cachedContentTokenCount?: number;
	thoughtsTokenCount?: number;
	totalTokenCount?: number;
	server_tool_use?: {
		web_search_requests?: number;
		/** Free of charge; read only so the shape is documented. */
		web_fetch_requests?: number;
	};
}
export interface CostBreakdown {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Per-request server-tool charges (web search is $10 per 1,000). No token count includes them. */
	serverTools: number;
	total: number;
	/** True when the model id was not in the catalogue and cost is 0. */
	unpriced: boolean;
}
export interface CostOptions {
	/** When the call happened, which decides the rate card. */
	at?: Date | string;
	/** `"fast"` bills at fast-mode rates on models that support it. */
	speed?: string | null;
	/** Batch traffic bills at the provider's batch discount. */
	batch?: boolean;
	/**
	 * Prompt size (input + cache reads), which picks the band of a tiered card.
	 * When omitted, the cheaper band is used.
	 */
	promptTokens?: number;
}
export interface EffectiveRates {
	inputPerM: number;
	outputPerM: number;
	cachedInputPerM: number;
	cacheWrite5mPerM: number;
	cacheWrite1hPerM: number;
	/** The card these came from, so callers can explain the number. */
	card: RateCard;
}
/** Fully resolved per-million rates for a model at a point in time. */
export declare function ratesFor(price: ModelPrice, opts?: CostOptions): EffectiveRates;
/** Cost of one API call, from usage in whatever shape its SDK returned. */
export declare function costOf(usage: UsageLike | null | undefined, modelId: string | null | undefined, opts?: CostOptions): CostBreakdown;
/** What the same token profile would have cost on a different model. */
export declare function costOnModel(usage: UsageLike, targetModelId: string, opts?: CostOptions): CostBreakdown;
export declare function usd(n: number): string;
export declare function tokens(n: number): string;
/**
 * The domain model. Every provider adapter produces `UsageEvent`s, and
 * everything downstream (analysis, recommendations, reports) reads only these
 * types, so nothing above this file knows how a provider formats its usage.
 */
/**
 * How a number came to exist, shown on every figure:
 * - `measured`: read directly from provider-reported usage.
 * - `inferred`: derived from measured data by a stated rule.
 * - `estimated`: a projection that rests on assumptions.
 */
export type EvidenceClass = "measured" | "inferred" | "estimated";
export interface Evidence {
	kind: EvidenceClass;
	/** One line on where the number came from. */
	basis: string;
}
/** One rolling usage window on a subscription, as the provider reports it. */
export interface RateLimitWindow {
	/** 0-100, the provider's own figure. */
	usedPercent: number;
	/** 300 is the five-hour window, 10080 the weekly one. */
	windowMinutes: number;
	/** ISO time the window resets. */
	resetsAt: string;
}
export interface RateLimitSnapshot {
	/** The plan as the provider names it: "plus", "pro", "free", "team"... */
	planType: string | null;
	/** Primary first. */
	windows: RateLimitWindow[];
}
/** One model call, normalised across providers. */
export interface UsageEvent {
	/** Stable id. The provider's message/request id where one exists. */
	id: string;
	/** Which adapter produced this. */
	source: "sdk" | "claude-code" | "codex" | "import";
	provider: string;
	/** ISO 8601. */
	ts: string;
	model: string;
	/** Groups related calls: a session, a trace, a conversation. */
	sessionId: string;
	/** Repo path for agents, or the service name passed to `wrap()`. */
	project: string;
	/** Call-site label, e.g. `summarise-ticket`. Drives per-route advice. */
	route?: string;
	/** Coarse workload class for the drill-down. Derived, not reported. */
	category?: WorkloadCategory;
	/**
	 * The user prompt this call answered, for agent transcripts. Calls sharing it
	 * are one task (see `analyze/tasks.ts`). Absent for SDK and imported calls,
	 * which are independent requests.
	 */
	turnId?: string;
	/** Compactions before this call in its session: a re-read after one is not a repeat. */
	contextEpoch?: number;
	/** What the whole task this call belongs to was doing. Derived, not reported. */
	taskKind?: TaskKind;
	inputTokens: number;
	outputTokens: number;
	thinkingTokens: number;
	cacheReadTokens: number;
	cacheWrite5mTokens: number;
	cacheWrite1hTokens: number;
	/** Server-side web searches, billed per request ($10 per 1,000), not per token. */
	webSearches?: number;
	/**
	 * The plan's own limit meter, as the provider reported it with this call.
	 * Codex writes one on every `token_count`, so ChatGPT plans need no `--plan`.
	 */
	rateLimits?: RateLimitSnapshot;
	/** Wall-clock latency in ms. Absent for transcript-derived calls. */
	latencyMs?: number;
	stopReason?: string | null;
	effort?: string | null;
	speed?: string | null;
	serviceTier?: string | null;
	batch?: boolean;
	isSubagent?: boolean;
	tools: ToolCall[];
	/** Size of the system prompt in characters, when known. */
	systemChars?: number;
	/** Number of tool definitions sent on the request. */
	toolDefCount?: number;
	/** Hash of the cacheable prefix, to spot cache-defeating churn. */
	prefixHash?: string;
	cost: CostCalculation;
}
/** Older name for `UsageEvent`. */
export type CallEvent = UsageEvent;
/**
 * What a whole task (one prompt and every call it set off) was doing, from its
 * shape: calls, files edited, failures, output, reasoning. Never from prompt text.
 * - `quick-edit`: a short task that edited one or two files.
 * - `lookup`: a short task that only read, searched or ran read-only commands.
 * - `conversation`: an answer with no tools at all.
 * - `multi-step`: many calls, several files, or substantial output.
 * - `debugging`: repeated failures along the way.
 * - `reasoning`: real thinking tokens were spent.
 */
export type TaskKind = "quick-edit" | "lookup" | "conversation" | "multi-step" | "debugging" | "reasoning";
/** What a call was doing, inferred from token counts and tool use (not intent). */
export type WorkloadCategory = "reasoning" | "tool-orchestration" | "generation" | "mechanical" | "unknown";
export interface ToolCall {
	id: string;
	name: string;
	/** Normalised signature used to detect repeats, e.g. `Read:/path/to/file`. */
	signature: string;
	/** Characters returned by the tool, when the result was captured. */
	resultChars?: number;
	/** What the result cost: estimated from length for text, from pixel size for images. */
	resultTokens?: number;
	imageCount?: number;
	isError?: boolean;
	/** The file a file tool read or changed, so an edit can retire earlier reads of it. */
	target?: string;
}
/** The money a call cost, broken out by what drove it. */
export type CostCalculation = CostBreakdown;
export type Category = "model-selection" | "context-bloat" | "caching" | "reasoning" | "retries" | "concentration" | "anomaly" | "pricing";
/** How much a fix could change model behaviour. */
export type Impact = "none" | "low" | "medium" | "high";
/**
 * What kind of move a finding asks for, which decides whether it counts in the
 * headline:
 * - `fix`: clear waste; removing it leaves the work as it was. The headline.
 * - `try`: likely fine, but it changes what the model does.
 * - `test`: a trade-off sized from your own usage (compact earlier, a smaller
 *   default model). Shown as "up to", never added to anything.
 */
export type FindingTier = "fix" | "try" | "test";
/**
 * How much to trust a finding's dollar figure. Ordinal on purpose: nothing
 * calibrates it, so a percentage would claim precision we don't have.
 * - `high`: recorded tokens, a large sample, and a fix that keeps token counts.
 * - `medium`: measured, but a thin sample or a fix that changes the output.
 * - `low`: modelled rather than measured, or too few calls.
 */
export type ConfidenceLevel = "low" | "medium" | "high";
/** A projected saving, with everything needed to check it. Never a guarantee. */
export interface SavingsEstimate {
	/** Observed cost of the affected traffic over the analysed window. */
	currentUsd: number;
	/** Estimated cost of that same traffic after the change. */
	optimizedUsd: number;
	/** currentUsd - optimizedUsd, over the window. */
	windowUsd: number;
	monthlyUsd: number;
	annualUsd: number;
	/** Days `windowUsd` was observed over, so findings can be combined and re-projected. */
	windowDays: number;
	/**
	 * Days `windowUsd` is divided by for a daily rate. Usually `windowDays`; see
	 * `projectionDays` for when the recent pace differs.
	 */
	projectionDays?: number;
	/** How far the dollar figure can be trusted. Ordinal, never a percentage. */
	confidence: ConfidenceLevel;
	/** Why the confidence is what it is. */
	confidenceBasis: string;
	/** Every assumption the estimate rests on, in plain language. */
	assumptions: string[];
	/** How the number was computed, so it can be checked. */
	calculation: string;
	evidence: Evidence;
}
/** What traffic an opportunity touches. */
export interface AffectedTraffic {
	calls: number;
	models: string[];
	projects: string[];
	routes: string[];
	/** Affected spend as a share of total spend in the window. */
	share: number;
	/** Ids of the priciest affected calls, for drill-down. */
	sampleEventIds: string[];
}
/** A detected inefficiency. Produced by the rules engine. */
export interface OptimizationFinding {
	rule: string;
	category: Category;
	title: string;
	/** What is happening and why it costs money. */
	detail: string;
	/** Why it matters, in one sentence: what makes this cost money. */
	why: string;
	tier: FindingTier;
	savings: SavingsEstimate;
	affected: AffectedTraffic;
	/** Expected effect on output quality if the fix is applied. */
	impact: Impact;
	severity: "high" | "medium" | "low";
	/** `safe` fixes are pure waste removal; others must clear the quality bar. */
	risk: "safe" | "needs-verification";
	/**
	 * How the quality question can be settled, derived once in `build()` from
	 * `risk` and `candidate`. `risk` alone isn't enough: `oversized-input`
	 * changes output but has no request rewrite a replay could run.
	 */
	verification: VerificationMode;
	/** A real cost you absorb (like a rate change), not waste. Never in headline savings. */
	advisory?: boolean;
	/** Concrete instances, most expensive first. */
	observations: string[];
	/** What to change. */
	fix: string;
	/** The exact events this finding counted. Every finding has one, candidate or not. */
	affects: (e: UsageEvent) => boolean;
	/**
	 * `savings.windowUsd` split across the counted events by cost, keyed by event
	 * id. Findings overlap, so totals are combined per event (`recoverableWindow`)
	 * rather than summed. A Map, so it stays out of JSON output.
	 */
	claimByEvent: ReadonlyMap<string, number>;
	candidate?: VerifyCandidate;
}
/**
 * How a finding's effect on output quality can be established:
 * - `not-required`: the fix can't change output (e.g. dropping a duplicate read).
 * - `replay`: a request rewrite, provable on recorded traffic via `candidate`.
 * - `manual`: can change output but can't be replayed; the user must sign off.
 */
export type VerificationMode = "not-required" | "replay" | "manual";
export interface VerifyCandidate {
	kind: "swap-model" | "trim-prompt" | "enable-cache" | "lower-effort";
	from?: string;
	to?: string;
	/**
	 * The target for a given model when a finding spans providers (Anthropic
	 * traffic needs an Anthropic target). Falls back to `to`.
	 */
	targetFor?: (modelId: string) => string | undefined;
	matches: (e: UsageEvent) => boolean;
	description: string;
}
/** A finding turned into a proposed change, with the state of that decision. */
export interface Recommendation {
	id: string;
	/** The finding this came from. */
	rule: string;
	category: Category;
	/** Imperative, e.g. "Switch eligible requests from Sonnet 5 to Haiku 4.5". */
	action: string;
	/** One sentence answering "why is this being suggested to me?". Same as `why`. */
	rationale: string;
	tier: FindingTier;
	/** What happened, in the user's own numbers. */
	happened: string;
	/** Why it matters. */
	why: string;
	/** What to do about it, in full. */
	fix: string;
	savings: SavingsEstimate;
	affected: AffectedTraffic;
	impact: Impact;
	risk: OptimizationFinding["risk"];
	/** How this recommendation's quality question can be settled. */
	verification: VerificationMode;
	/** What a user can do with it right now. */
	actions: RecommendationAction[];
	status: RecommendationStatus;
}
export type RecommendationAction = "view-affected" | "simulate" | "verify" | "apply";
export type RecommendationStatus = "new" | "viewed" | "simulated" | "verified" | "rejected" | "applied";
export interface Window {
	from: string;
	to: string;
	days: number;
}
/** A compaction the agent ran in a main conversation, as its transcript records it. */
export interface CompactionRecord {
	source: string;
	ts: string;
	sessionId: string;
	project: string;
	/** "auto" when the agent hit its window, "manual" for /compact. */
	trigger: string;
	/** Context before and after, by the agent's own count. */
	preTokens: number;
	postTokens?: number;
	/** How long the summary took, which the user waits through. */
	durationMs?: number;
	/** The reply before it was about to call a tool: the work was still going. */
	midTask: boolean;
}
export interface Dataset {
	events: UsageEvent[];
	window: Window;
	sources: string[];
	warnings: string[];
	/**
	 * Sources that could not be read at all (`"<adapter label>: <error>"`). Each
	 * one means missing data, so it must be shown where it can't be missed.
	 */
	failures?: string[];
	/** Real compactions, where the source records them (Claude Code does). */
	compactions?: CompactionRecord[];
}
export interface Bucket {
	key: string;
	calls: number;
	cost: CostBreakdown;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Cache writes at the 5-minute TTL, billed at 1.25x the input rate. */
	cacheWrite5mTokens: number;
	/** Cache writes at the 1-hour TTL, billed at 2x the input rate. */
	cacheWrite1hTokens: number;
	thinkingTokens: number;
}
/**
 * Which calendar day buckets use. UTC by default so two machines agree; it's
 * also the usual reason a daily figure differs from another tool's, so the
 * report always prints the zone it used.
 */
export type DayTimeZone = "UTC" | "local" | (string & {});
export interface SummaryOptions {
	/** `"UTC"` (default), `"local"`, or an IANA zone such as `"Europe/Berlin"`. */
	timeZone?: DayTimeZone;
}
/** A single call singled out for being unusually expensive or large. */
export interface TopCall {
	id: string;
	ts: string;
	model: string;
	provider: string;
	project: string;
	route?: string;
	costUsd: number;
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	latencyMs?: number;
}
export interface Summary {
	calls: number;
	totalCost: number;
	/** `totalCost` broken out by what drove it, including per-request tools. */
	cost: CostBreakdown;
	window: Dataset["window"];
	perDay: number;
	perMonth: number;
	/** Where `perDay` and `perMonth` came from: the whole window, or its last 30 days. */
	pace: "window" | "last-30-days";
	inputTokens: number;
	outputTokens: number;
	thinkingTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Cache writes at the 5-minute TTL, billed at 1.25x the input rate. */
	cacheWrite5mTokens: number;
	/** Cache writes at the 1-hour TTL, billed at 2x the input rate. */
	cacheWrite1hTokens: number;
	/** Server-side web searches, billed per request rather than per token. */
	webSearches: number;
	/** The IANA zone the `byDay` buckets were cut in. */
	dayTimeZone: string;
	/**
	 * The first and last day in `dayTimeZone`. `window.from`/`.to` are UTC
	 * timestamps, so slicing them would name days no bucket has.
	 */
	windowDays: {
		from: string;
		to: string;
	};
	/** Share of billable input tokens served from cache. 1.0 is perfect. */
	cacheHitRate: number;
	/** Share of output spend that went on thinking tokens. */
	thinkingShare: number;
	/** Total tokens across every direction, the headline volume figure. */
	totalTokens: number;
	/** Mean tokens per call, which shows whether context is creeping. */
	avgTokensPerCall: number;
	avgCostPerCall: number;
	byModel: Bucket[];
	byProvider: Bucket[];
	byDay: Bucket[];
	byProject: Bucket[];
	bySession: Bucket[];
	byRoute: Bucket[];
	/** Most expensive individual calls. */
	topByCost: TopCall[];
	/** Largest individual calls by token count. */
	topByTokens: TopCall[];
	/** Latency percentiles in ms, for calls that recorded them. */
	latency: {
		p50: number;
		p95: number;
		count: number;
	} | null;
}
/** The model's effective input rate at the time of the call, $/M tokens. */
export declare function inputRateOf(e: CallEvent): number;
export declare function summarize(data: Dataset, opts?: SummaryOptions): Summary;
/**
 * Findings only. Detector failures are added to `data.warnings`, which every
 * host already shows. Use `analyze` to get the errors as data.
 */
export declare function findWaste(data: Dataset): OptimizationFinding[];
export interface ColdResume {
	event: UsageEvent;
	/** The call before it in the same conversation, the last one with a warm cache. */
	previous: UsageEvent;
	gapMinutes: number;
	/** The cache lifetime the conversation was written with; null where the provider decides. */
	ttlMinutes: 5 | 60 | null;
	rewriteTokens: number;
	/** What the rewrite cost. */
	rewriteUsd: number;
	/** What reading the same tokens from a warm cache would have cost. */
	warmUsd: number;
}
/**
 * What accepting a recommendation does. By the time `live` can show one, the
 * call it describes has already been billed, so only the next request can
 * change: an app using `wrap()` or a Claude Code session running the optimAIzr
 * mod picks up overrides on its next request, while Codex (and Claude Code
 * without the mod) reads its model at session start.
 *
 * `accept()` returns `applied` only when a rewriter really took the change,
 * `queued` when the decision was recorded and the user got the command that
 * applies it, or `failed` when a rewriter tried and couldn't.
 */
/** One slice of the traffic a finding covers, in the terms a rewriter matches requests on. */
export interface TrafficSlice {
	source: UsageEvent["source"];
	project: string;
	route?: string;
	model: string;
	calls: number;
	/** Claude Code only: subagent calls (true) or the main conversation (false). */
	subagent?: boolean;
	/** Affected spend over all spend in the same slice, so a rewriter can tell a narrow finding. */
	share?: number;
}
/** Where a finding's affected calls came from. `live` knows; a batch report may not. */
export interface Traffic {
	slices: TrafficSlice[];
	/**
	 * Affected spend as a share of each source's own spend. `affected.share` is
	 * against all spend, which undercounts a Claude Code finding when a busy SDK
	 * app shares the window.
	 */
	shareBySource: Partial<Record<UsageEvent["source"], number>>;
}
/** A proposed change, in the terms a prompt needs to render it. */
export interface ProposedChange {
	kind: VerifyCandidate["kind"] | "manual";
	/** Imperative one-liner, e.g. "Switch to Haiku 4.5". */
	label: string;
	/** Display labels for a model swap, when that is what this is. */
	from?: string;
	to?: string;
	/** The target model id, for a rewriter that needs the real thing. */
	toModelId?: string;
	/** Which traffic the change is for, when the host knows. */
	traffic?: Traffic;
}
export declare function proposedChange(f: OptimizationFinding, traffic?: Traffic): ProposedChange;
export interface InstallResult {
	ok: boolean;
	detail: string;
	/**
	 * `ok: false` because the rewriter judged the change wrong for this traffic,
	 * not because anything broke. The decision is still recorded, the same as
	 * when no rewriter applies at all.
	 */
	declined?: boolean;
	/** Something the user can do by hand to have the change take effect right now. */
	now?: string;
}
/**
 * Something that can alter an outbound request, or the config the next one is
 * built from. Typed by `ProposedChange`, not by model, so other kinds of change
 * need no new plumbing.
 */
export interface RequestRewriter {
	/** How this rewriter reaches requests, for display: "sdk wrapper", say. */
	readonly kind: string;
	supports(change: ProposedChange, finding: OptimizationFinding): boolean;
	/** Install the change. Must not throw; report failure in the result. */
	install(change: ProposedChange, finding: OptimizationFinding): InstallResult;
}
/** What one rewriter did, beside the one an `applied` outcome leads with. */
export interface RewriterResult {
	via: string;
	applied: boolean;
	detail: string;
}
export type ApplyOutcome = 
/** A rewriter really took the change. Only ever returned when one exists. */
{
	kind: "applied";
	via: string;
	detail: string;
	/** A manual step that makes it take effect sooner than the rewriter can. */
	now?: string;
	/** Every other rewriter that was tried, applied or not. */
	also?: RewriterResult[];
}
/**
 * Recorded, not applied. `reason` says why, `next` is the command that does.
 * `declined` when a rewriter could have acted and chose not to.
 */
 | {
	kind: "queued";
	reason: string;
	next: string;
	declined?: boolean;
	now?: string;
} | {
	kind: "failed";
	detail: string;
};
/** The command that actually settles this finding, given how it can be verified. */
export declare function nextCommandFor(f: OptimizationFinding): string;
export interface AcceptOptions {
	/** Every pre-request integration wired up. Each one that supports the change is tried. */
	rewriters?: RequestRewriter[];
	/** A single rewriter; shorthand for `rewriters: [r]`. */
	rewriter?: RequestRewriter;
	/** Where the affected calls came from, so each rewriter acts only on its own. */
	traffic?: Traffic;
	/** Change nothing at all (`--dry-run`). */
	dryRun?: boolean;
}
/**
 * Accept a live recommendation. Records `viewed`, never `applied`: `applied` is
 * what `apply` writes after verification, and the verify/apply gate relies on it.
 */
export declare function accept(f: OptimizationFinding, opts?: AcceptOptions): ApplyOutcome;
/**
 * Live analysis: the same rules as the batch commands, re-run over a rolling
 * window as calls arrive, announcing a finding when it first crosses its
 * threshold. Rules are population statistics (some need 20 or 50 calls), so
 * "live" can't mean analysing one call at a time.
 *
 * Rules with a longer horizon (`pricingChange`, `costSpike`) never fire live.
 * Savings are reported as observed over the window, never projected to a
 * month: minutes of traffic can't be annualised. No network or disk access;
 * the clock is injected.
 */
/** Sensible defaults, exported so a host can show them in `--help`. */
export declare const LIVE_DEFAULTS: {
	/** Calls held in memory. Enough for the 50-event rules to reach quorum. */
	readonly maxEvents: 500;
	/** Floor on re-analysis, so a burst of calls cannot spin the rule engine. */
	readonly minIntervalMs: 2000;
	/** Also re-analyse after this many calls, however fast they arrive. */
	readonly everyNEvents: 25;
	/** Don't announce trivia. Cents over a few minutes read as noise, not advice. */
	readonly minUsd: 0.25;
	/** Affected calls quoted under a finding, so it can be traced to an agent. */
	readonly examples: 3;
	/** Re-announce a standing finding only once its cost has grown this much. */
	readonly regrowth: 2;
	/** Above this probability, the judge's "needs a big model" wins. */
	readonly frontierThreshold: 0.6;
};
/**
 * A semantic opinion the rules can't form. `isMechanical()` judges from call
 * shape alone, so a judge that looked at the work can veto its false positives.
 * Synchronous on purpose (a cache lookup, filled in the background);
 * `undefined` means no opinion, which must always be safe.
 */
export type FrontierJudge = (event: UsageEvent) => number | undefined;
export interface LiveOptions {
	maxEvents?: number;
	minIntervalMs?: number;
	everyNEvents?: number;
	minUsd?: number;
	regrowth?: number;
	frontierThreshold?: number;
	/** Optional semantic veto. Absent means fully local, rules-only. */
	judge?: FrontierJudge;
	/** Injectable clock, so tests don't have to sleep. */
	now?: () => number;
}
/** A finding that just crossed its threshold, with the call that pushed it over. */
export interface LiveRecommendation {
	/** The existing recommendation, built by the existing engine. */
	recommendation: Recommendation;
	finding: OptimizationFinding;
	/** Savings observed over the live window, never projected forward. */
	observedUsd: number;
	/** True span of the window this was observed over, so the figure can be read in context. */
	windowMs: number;
	windowEvents: number;
	/** The call whose arrival tipped the rule over its threshold. */
	trigger: {
		id: string;
		model: string;
		route?: string | undefined;
		ts: string;
	};
	/** Distinct sessions among the affected calls; parallel agents each have their own. */
	sessions: number;
	/** The most recent affected calls, newest first, so a finding names its source. */
	examples: UsageEvent[];
	/**
	 * Where the affected calls came from (sources, services, routes, models), so
	 * accepting a finding changes only that traffic.
	 */
	traffic: Traffic;
	/** Set when a standing finding is re-announced because its cost grew. */
	repeatOf?: number;
	/** Set when the judge had an opinion on this finding's affected traffic. */
	judged?: {
		needsFrontierShare: number;
		sampled: number;
	};
	/**
	 * Set when the judge vetoed this finding: it's reported, not proposed, so the
	 * user can see the veto. A host must never prompt on one.
	 */
	withheld?: {
		by: string;
		needsFrontierShare: number;
		sampled: number;
	};
}
export interface LiveAnalyzer {
	/**
	 * Record a call and return anything newly worth saying. Returns rather than
	 * calling back, so the caller owns all output.
	 */
	push(event: UsageEvent): LiveRecommendation[];
	/** Force a re-analysis regardless of the interval (used on shutdown). */
	flush(): LiveRecommendation[];
	/** The current window, for a host that wants to render context. */
	window(): readonly UsageEvent[];
	/** Forget everything, including what has already been announced. */
	reset(): void;
}
export declare function createLiveAnalyzer(opts?: LiveOptions): LiveAnalyzer;
export interface CacheState {
	/** The conversation's last call. */
	event: UsageEvent;
	context: number;
	/** When the cache is gone, in ms; null where the provider decides (Codex). */
	expiresAt: number | null;
	/** Reading the conversation from a warm cache, on one call. */
	readUsd: number;
	/** Paying for all of it again once the cache is gone. */
	rewriteUsd: number;
}
declare function createCacheWatch(opts?: {
	warnMs?: number;
	warnUsd?: number;
	minContext?: number;
}): {
	/** Fold in a call. Returns the cold return it was, if it was one. */
	push(e: UsageEvent): ColdResume | null;
	/** Long conversations whose cache expires within the warning window, each once. */
	expiring(now: number): CacheState[];
	/**
	 * Long conversations that are still warm, soonest to expire first. Codex
	 * ones, whose expiry nobody knows, follow while idle under an hour.
	 */
	warm(now: number): CacheState[];
	/** The most recent conversation, whatever its size: what a status line shows. */
	latest(): CacheState | null;
};
export type CacheWatch = ReturnType<typeof createCacheWatch>;
export interface IngestOptions {
	/** Defaults to `~/.claude/projects`. */
	root?: string;
	/** Only include calls from the last N days. */
	days?: number;
	/** Substring match against the project path. */
	project?: string;
}
export declare function ingestClaudeCode(opts?: IngestOptions): Promise<Dataset>;
/**
 * The quality bar a change must clear before it's applied. `verify` replays
 * your own traffic under the change and measures the output two ways:
 * deterministic checks (JSON parses, same tool called, length budget), where
 * any regression fails the candidate; and a pairwise judge, shown both answers
 * twice with positions swapped, where a side must win both orders to win.
 */
export type Check = {
	type: "json-parses";
	label?: string;
} | {
	type: "contains";
	value: string;
	label?: string;
} | {
	type: "matches";
	pattern: string;
	flags?: string;
	label?: string;
} | {
	type: "max-chars";
	value: number;
	label?: string;
} | {
	type: "min-chars";
	value: number;
	label?: string;
} | {
	type: "tool-name-matches";
	label?: string;
} | {
	type: "no-refusal";
	label?: string;
};
export interface JudgeConfig {
	/** Should be at least as capable as the baseline model. */
	model: string;
	/** What "better" means for this route, in your words. */
	criteria: string;
	/**
	 * Minimum acceptable win rate for the candidate, where 0.5 is parity.
	 * Default 0.45: marginally worse is fine, materially worse is not.
	 */
	minWinRate?: number;
}
export interface QualityBar {
	checks: Check[];
	judge?: JudgeConfig;
	/** How many recorded calls to replay. Default 40. */
	sampleSize?: number;
}
export declare const DEFAULT_BAR: QualityBar;
/** Run one check against one response. `baseline` supplies the reference tool calls. */
export declare function runCheck(check: Check, content: unknown, baseline: unknown): boolean;
export interface CheckResult {
	label: string;
	baselinePassed: number;
	candidatePassed: number;
	total: number;
	/** True when the candidate passes at least as often as the baseline. */
	ok: boolean;
}
export type JudgeVerdict = "candidate" | "baseline" | "tie";
/**
 * What the judging cost, priced from the usage each judge call reported. Calls
 * with no usage or an unknown model are counted in `unpriced` rather than
 * guessed, so `usd` is then a floor.
 */
export interface JudgeCost {
	/** Measured cost of judge calls, from reported usage at the rate in force. */
	usd: number;
	/** Judge calls that were priced. */
	priced: number;
	/** Judge calls whose cost is unknown and therefore missing from `usd`. */
	unpriced: number;
}
export interface JudgePairResult {
	verdict: JudgeVerdict;
	cost: JudgeCost;
}
/**
 * Judge one pair, shown twice with positions swapped; a side must win both
 * orders to take the pair, otherwise it's a tie. `client` is the SDK for the
 * judge model's provider.
 */
export declare function judgePair(client: any, cfg: JudgeConfig, prompt: string, baseline: string, candidate: string): Promise<JudgePairResult>;
/**
 * Append-only JSONL store for recorded calls. No daemon, database or network,
 * and every write is best-effort: the recorder must never fail a request.
 */
export declare function optimaizrDir(): string;
export declare function ledgerPath(): string;
/** Force a drain (used by the CLI and by tests). */
export declare function drain(): Promise<void>;
export interface ReadOptions {
	days?: number;
	project?: string;
	route?: string;
}
/** Read recorded SDK events back out of the ledger. */
export declare function readLedger(opts?: ReadOptions): Promise<Dataset>;
/**
 * Sampled request/response pairs, used only by `optimaizr verify` to replay
 * your traffic. Prompts are sensitive, so capture is opt-in, sampled, redacted
 * and local-only. Nothing here is uploaded.
 */
export interface Sample {
	id: string;
	ts: string;
	route?: string;
	model: string;
	/** The request as sent, minus anything redaction removed. */
	request: Record<string, unknown>;
	/**
	 * The response your app received: the baseline to beat, in its vendor's own
	 * shape (the quality checks read all of them).
	 */
	response: {
		content: unknown;
		stop_reason?: string | null;
		usage?: Record<string, unknown>;
	};
}
export interface CaptureOptions {
	/** 0 disables capture; 0.05 samples one call in twenty. Default 0. */
	rate?: number;
	/** Cap on stored samples per route. Oldest are kept; newest dropped. */
	maxPerRoute?: number;
	/**
	 * Redaction applied to every string before storage. Defaults to masking
	 * emails, bearer tokens, API keys and long digit runs.
	 */
	redact?: (text: string) => string;
}
export declare function defaultRedact(text: string): string;
export declare function readSamples(filter?: {
	route?: string;
	limit?: number;
}): Promise<Sample[]>;
/**
 * One-line integration, whichever vendor you call:
 *
 * ```ts
 * const claude = optimaizr.wrap(new Anthropic(), { service: "checkout-api" });
 * const openai = optimaizr.wrap(new OpenAI(), { service: "checkout-api" });
 * ```
 *
 * Every call keeps its normal signature and return value. The wrapper measures
 * latency, records token usage and cost, and fingerprints the cacheable prefix.
 * Both clients write to the same ledger in the same shape, which is what makes
 * the resulting spend directly comparable.
 *
 * Design rule: **the recorder must never break the caller.** Every hook is
 * wrapped in try/catch, recording is asynchronous and best-effort, and any
 * failure inside optimAIzr is swallowed rather than propagated.
 *
 * The one change it makes to a request is a model override the user accepted
 * in `optimaizr live` (see overrides.ts), and that obeys the same rule: if the
 * provider rejects the new model, the original request is sent instead.
 */
export interface WrapOptions {
	/** Label for this application or service. Defaults to the process name. */
	service?: string;
	/** Default route label for calls that don't set one. */
	route?: string;
	/** Set false to disable recording without removing the wrapper. */
	enabled?: boolean;
	/** Called for every recorded event, in addition to the local ledger. */
	onEvent?: (event: CallEvent) => void;
	/**
	 * Opt-in prompt capture, needed by `optimaizr verify` to replay your traffic.
	 * Samples a fraction of calls, redacts before writing, never leaves the
	 * machine. `capture: { rate: 0.02 }` records one call in fifty.
	 */
	capture?: CaptureOptions;
	/**
	 * Apply model overrides accepted in `optimaizr live`. On by default: an
	 * override only exists because someone pressed Y. Set false, or
	 * OPTIMAIZR_OVERRIDES=0, to send every request exactly as written.
	 */
	overrides?: boolean;
}
/** Tag every call made inside `fn` with a route label. */
export declare function withRoute<T>(route: string, fn: () => T): T;
/**
 * Wrap an Anthropic or OpenAI client. Returns the same client, instrumented.
 * If anything about the client is unexpected, the original is returned
 * unchanged rather than throwing.
 */
export declare function wrap<T extends object>(client: T, options?: WrapOptions): T;
/**
 * Record a call made outside a supported SDK (another language, raw HTTP, a
 * gateway). `usage` is accepted in any vendor's shape.
 */
export declare function record(input: {
	model: string;
	usage: any;
	latencyMs?: number;
	route?: string;
	service?: string;
	sessionId?: string;
}): void;
export interface NoulQuestion {
	type: "noul";
	instructions: string;
	criteria?: {
		true: string;
		false: string;
	};
}
export interface SystemOneRequest {
	state: string[];
	model: string;
	questions: Record<string, NoulQuestion>;
}
export interface JevOptions {
	/** Defaults to `TYPESAFE_API_KEY`. With no key the judge is inert. */
	apiKey?: string;
	model?: string;
	endpoint?: string;
	timeoutMs?: number;
	/** Minimum gap between refreshes. Profiles change slowly; no need to rush. */
	refreshIntervalMs?: number;
	/** Calls a route must accumulate before it is worth asking about. */
	minCalls?: number;
	/** Build the request and hand it to `onRequest` without sending it. */
	dryRun?: boolean;
	/** Observability hooks. Never throw from these. */
	onRequest?: (body: SystemOneRequest) => void;
	onError?: (err: Error) => void;
	onVerdict?: (route: string, needsFrontier: number) => void;
}
export interface JevJudge {
	/** Record a call. Cheap, synchronous, never blocks the caller. */
	observe(event: UsageEvent): void;
	/** The sync lookup handed to the live analyzer. */
	judge: FrontierJudge;
	/** Exactly what would be sent right now, for inspection. */
	describeEgress(): SystemOneRequest | null;
	/** Ask Jev about any routes that qualify. Safe to call often; self-throttles. */
	refresh(): Promise<void>;
	/** Verdicts held so far, route -> probability it needs a frontier model. */
	verdicts(): ReadonlyMap<string, number>;
}
export declare function createJevJudge(opts?: JevOptions): JevJudge;
/**
 * The host side of live analysis. Two ways in: pass `onEvent` to `wrap()` to
 * get recommendations inside the running app, or use `tailLedger()` so
 * `optimaizr live` can watch an app from another terminal. Both feed the same
 * analyzer and the same rules as the batch commands.
 */
export interface LiveSessionOptions {
	/** Called once per newly actionable finding. */
	onRecommendation: (rec: LiveRecommendation) => void;
	/** Tuning for the rolling window. See `LIVE_DEFAULTS`. */
	analyzer?: Omit<LiveOptions, "judge">;
	/**
	 * Opt in to the Jev second opinion. Without it, the session never touches
	 * the network. With it, only route metadata is sent (see `jev.ts`).
	 */
	jev?: JevOptions;
}
export interface LiveSession {
	/** Hand this to `wrap({ onEvent })`, or drive it from `tailLedger`. */
	onEvent: (event: CallEvent) => void;
	/** Analyse whatever is buffered, regardless of the interval. */
	flush: () => LiveRecommendation[];
	/** Present only when Jev was opted into, for egress inspection. */
	jev?: JevJudge;
}
export declare function createLiveSession(opts: LiveSessionOptions): LiveSession;
export interface TailOptions {
	/** Replay this many existing events before following. Default 0. */
	backfill?: number;
	/** Poll interval in ms. Default 500. */
	intervalMs?: number;
	/** Path override, for tests. */
	path?: string;
	/**
	 * Hold the event loop open. Off by default so a library watching a file never
	 * keeps its host from exiting; `optimaizr live` turns it on.
	 */
	keepAlive?: boolean;
}
/**
 * Follow the ledger as it grows. Polls the file size and reads only new bytes,
 * holding back a partial last line (the writer flushes in batches). Polling
 * instead of `fs.watch`, whose behaviour differs across platforms.
 */
export declare function tailLedger(onEvent: (event: CallEvent) => void, opts?: TailOptions): {
	stop: () => void;
};
/** Where Claude Code keeps its session transcripts. */
export declare function claudeProjectsRoot(): string;
/** Where Codex keeps its session rollouts. */
export declare function codexSessionsRoot(): string;
export interface TranscriptTailOptions {
	/** Defaults to the vendor's own root. */
	roots?: string[];
	/** Poll interval in ms. Default 1000. */
	intervalMs?: number;
	/**
	 * How long a Claude Code response must sit untouched before it counts as
	 * finished (it's written across several records, the last carrying usage).
	 * Codex marks its own billable moment and ignores this. Default 2s.
	 */
	quietMs?: number;
	/** Read existing files from the beginning rather than from their end. */
	backfill?: number | boolean;
	keepAlive?: boolean;
}
/**
 * Follow Claude Code transcripts as a session writes them, so `live` works
 * without `wrap()`. Parse state is kept per file between polls, and it's the
 * same parser `scan` uses, so live and batch numbers agree.
 */
export declare function tailTranscripts(onEvent: (event: CallEvent) => void, opts?: TranscriptTailOptions): {
	stop: () => void;
	flush: () => void;
};
/**
 * Follow Codex rollouts as a session writes them. Codex writes a `token_count`
 * line when a call completes, so events are emitted immediately with nothing
 * to settle.
 */
export declare function tailCodex(onEvent: (event: CallEvent) => void, opts?: TranscriptTailOptions): {
	stop: () => void;
	flush: () => void;
};
/**
 * Applying a recommendation to Claude Code without the optimAIzr mod. `live`
 * runs in a separate process and the call is already billed, so the lever is
 * the `model` in `~/.claude/settings.json`. Claude Code reads it at session
 * start, so the change covers later sessions, and the outcome hands over the
 * `/model` command that switches the running one.
 */
export declare function claudeSettingsPath(): string;
export interface ClaudeSettingsRewriterOptions {
	/** Override the settings path, for tests. */
	settingsPath?: string;
	/** Minimum affected share before a global change is offered. */
	minShare?: number;
	/** Stand aside when this is true, e.g. while the optimAIzr mod switches sessions itself. */
	unless?: () => boolean;
}
export declare function claudeSettingsRewriter(opts?: ClaudeSettingsRewriterOptions): RequestRewriter;
/**
 * Model overrides applied before a request is sent, so accepting a live
 * recommendation reaches a running app (`wrap()`) or Claude Code session (the
 * optimAIzr mod) with no restart. Each entry is as narrow as its finding: one
 * service or project, one route (or none), one source model.
 */
export interface ModelOverride {
	/** The finding that produced it, so `optimaizr undo <rule>` can find it. */
	rule: string;
	/** Who applies it: absent for `wrap()`, `claude-code` for the optimAIzr mod. */
	source?: "claude-code";
	/** `service` as the app passed it to `wrap()`, or Claude Code's working directory. */
	project: string;
	/** Exact route; absent means calls made without one. */
	route?: string;
	/** Claude Code only: subagents (true), the main conversation (false), or both (absent). */
	subagent?: boolean;
	from: string;
	to: string;
	/** Claude Code only: an effort switch, the same model asked to think less. */
	effort?: string;
	/** Applied by `live --auto`, with no one pressing Y. */
	auto?: boolean;
	/** ISO 8601, when it was accepted. */
	at: string;
}
export declare function overridesPath(): string;
export declare function readOverrides(file?: string): ModelOverride[];
/** Remove every override a rule installed. Returns what was removed. */
export declare function removeOverrides(rule: string, file?: string): ModelOverride[];
export interface SdkOverrideRewriterOptions {
	/** Override the file, for tests. */
	file?: string;
	now?: () => Date;
}
/**
 * Apply a model swap to apps using `wrap()` from their next request. SDK
 * traffic only: Claude Code's entries are written by `claudeModRewriter`.
 */
export declare function sdkOverrideRewriter(opts?: SdkOverrideRewriterOptions): RequestRewriter;
/**
 * Shadow replay: re-run recorded traffic under a proposed change and compare.
 * Only the candidate is re-run; the baseline response and usage are already
 * recorded, which is the truer reference and half the cost.
 */
export interface VerifyResult {
	description: string;
	samples: number;
	baselineCostPerCall: number;
	candidateCostPerCall: number;
	/** Measured saving per call, from real replay usage. */
	savingPerCall: number;
	/** Projected monthly saving at the observed call volume. */
	monthlySaving: number;
	checks: CheckResult[];
	judge: {
		wins: number;
		losses: number;
		ties: number;
		winRate: number;
	} | null;
	verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
	reasons: string[];
	/**
	 * Cost of running the verification itself, measured from the usage the
	 * replay and judge calls reported. A floor rather than a total whenever
	 * `unpricedCalls` is above zero.
	 */
	verificationCost: number;
	/**
	 * Verification calls the catalogue couldn't price (unknown model, or no usage
	 * reported). They're missing from `verificationCost`, not counted as free.
	 */
	unpricedCalls: number;
}
/**
 * Rewrite a recorded request to express the candidate change, in the dialect it
 * arrived in, so replay measures the change and nothing else.
 */
export declare function applyCandidate(request: Record<string, any>, candidate: VerifyCandidate): Record<string, any>;
export interface VerifyOptions {
	/**
	 * The SDK to replay with. A single client covers traffic from one vendor;
	 * pass `clients` instead when the captured traffic spans two.
	 */
	client?: any;
	/**
	 * One client per provider id, e.g. `{ anthropic, openai }`. Samples (and the
	 * judge) go back to their own vendor; a sample with no client is skipped.
	 */
	clients?: Record<string, any>;
	candidate: VerifyCandidate;
	bar?: QualityBar;
	route?: string;
	/** Monthly call volume for this route, used to project the saving. */
	monthlyCalls?: number;
	concurrency?: number;
	onProgress?: (done: number, total: number) => void;
}
export declare function verifyCandidate(opts: VerifyOptions): Promise<VerifyResult>;
/**
 * The interactive half of `optimaizr live`. It must never overstate what Y did
 * (the call on screen is already billed; `accept()` says `queued` when nothing
 * took the change), must not nag (low-confidence findings are printed, not
 * prompted, and each rule/route is raised once per session), and must
 * serialise prompts while events keep arriving.
 */
export interface PromptOptions {
	/** False for --json, a non-TTY, or --no-prompt: print instead of asking. */
	interactive: boolean;
	/** Was --jev passed? Changes what the "Why?" screen can claim. */
	jevEnabled: boolean;
	/** --dry-run: change nothing, record nothing. */
	dryRun: boolean;
	/** The pre-request integrations Y can use. Each acts only on its own traffic. */
	rewriters?: RequestRewriter[];
	/** A single rewriter; shorthand for `rewriters: [r]`. */
	rewriter?: RequestRewriter;
	/** How to print a recommendation when not prompting. */
	render: (rec: LiveRecommendation) => string;
	/** Called on Ctrl-C from inside a prompt. */
	onExit: () => void;
	/**
	 * Terminal I/O, injectable so the Y / N / D paths can be driven in tests
	 * without a pty. Defaults to a real keypress read and `console.log`.
	 */
	io?: {
		read: () => Promise<string>;
		write: (line: string) => void;
	};
	/** Around every question, so a status line can step aside while one is open. */
	onAsk?: () => void;
	onAnswered?: () => void;
}
export interface LivePrompt {
	/** Queue a recommendation for display. Never rejects. */
	offer: (rec: LiveRecommendation) => void;
	/**
	 * Ask a yes/no question in turn with the recommendations, run `act` on Y and
	 * print what it returns. Printed without asking when not interactive.
	 */
	confirm: (card: string, act: () => string) => void;
	/** Resolves once every queued prompt has been answered. */
	drain: () => Promise<void>;
}
export declare function createLivePrompt(opts: PromptOptions): LivePrompt;
export interface StatusState {
	startedAt: number;
	calls: number;
	spendUsd: number;
	/** Session id -> last call time. */
	sessions: Map<string, number>;
	last?: {
		model: string;
		costUsd: number;
		context: number;
		at: number;
	};
	checkedAt?: number;
	/** Findings shown this run, by rule, with what each could have saved. */
	found: Map<string, number>;
	/** Long conversations and how long their cache stays warm. */
	cache?: CacheWatch;
}
export declare function emptyStatus(now?: number): StatusState;
/** Fold one call into the state. */
export declare function recordCall(s: StatusState, e: UsageEvent, now?: number): void;
/** The line itself, without colour codes counted against the width. */
export declare function renderStatus(s: StatusState, now?: number, width?: number): string;
/** One line on stopping: what the run saw, what it found. */
export declare function renderRunSummary(s: StatusState, now?: number): string;
export interface StatusLine {
	update(): void;
	/** Step aside while a question is on screen. */
	hold(): void;
	release(): void;
	/** Wrap console.log so ordinary output never collides with the line. */
	attach(): () => void;
	stop(): void;
}
export declare function createStatusLine(state: StatusState, opts?: {
	enabled: boolean;
	now?: () => number;
}): StatusLine;
export interface UpdateState {
	checkedAt?: string;
	latest?: string;
	/** The last version that ran here, so an upgrade can say what's new once. */
	seenVersion?: string;
	noticedAt?: string;
}
/** True when `a` is a later release than `b` (x.y.z, pre-release tags ignored). */
export declare function newer(a: string, b: string): boolean;
/** Off in CI, for --json, when output isn't a terminal, or when switched off. */
export declare function updatesEnabled(opts: {
	env: NodeJS.ProcessEnv;
	isTTY: boolean;
	json: boolean;
	configured?: boolean;
}): boolean;
/**
 * What to print after a command: what's new after an upgrade, then a newer
 * release. `usedBefore` covers upgrades from versions that kept no record.
 */
export declare function updateLines(state: UpdateState, now: number, opts?: {
	version?: string;
	usedBefore?: boolean;
}): string[];
/** Each `## x.y.z` section of the changelog, newest first. */
export declare function changelogSections(text?: string): Array<{
	version: string;
	body: string;
}>;
declare const _default: {
	wrap: typeof wrap;
	withRoute: typeof withRoute;
	record: typeof record;
};

export {
	_default as default,
};

export {};
