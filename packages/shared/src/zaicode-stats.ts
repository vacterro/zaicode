/* eslint-disable max-lines -- one owner module: the statistics contract, calendar arithmetic and every documented formula live together so a formula and its test never drift apart. */
/**
 * SAIHOME local statistics (T-56): the event contract, calendar arithmetic
 * and every derived number, as pure functions.
 *
 * Storage keeps events (zaicode_stats_events); the service sums them per
 * quarter hour in SQL (every real-world UTC offset is a multiple of 15 min,
 * so a quarter hour never straddles a local midnight) and this module turns
 * those buckets into local days with Intl in the operator's IANA zone. DST,
 * a zone change and month/year rollover therefore never need special cases:
 * each bucket gets the local date its own instant had.
 *
 * Truth rules: a token count exists only where the source measured it
 * (model requests from the agent store); CLI worker sessions report no
 * tokens and stay "unmeasured", never zero. Every ratio returns null when
 * its denominator is zero ("not enough data").
 */

export const ZAICODE_STATS_BUCKET_MS = 15 * 60_000;

export type ZaicodeStatsKind = "model.request" | "turn" | "job.finished" | "worker.session";

/** Events the renderer may record itself (it owns the CLI worker terminals). */
export interface ZaicodeStatsWorkerSession {
  /** Stable id: the worker id (one session per worker). */
  id: string;
  startedAt: number;
  endedAt: number;
  project: string | null;
  /** Engine short name (A1, C2, AG, ...). */
  engine: string | null;
  exitCode: number | null;
}

/** One line of SAIHOME's recent-activity list (queue runs and worker sessions). */
export interface ZaicodeStatsActivity {
  id: string;
  kind: "job.finished" | "worker.session";
  at: number;
  durationMs: number | null;
  project: string | null;
  /** Queue job id or worker engine, for the drill-down. */
  jobId: string | null;
  engine: string | null;
  result: string | null;
  failure: string | null;
  recovered: boolean;
}

/** One quarter hour of summed events (what the SQL returns). */
export interface ZaicodeStatsBucket {
  /** floor(at / ZAICODE_STATS_BUCKET_MS) */
  q: number;
  requests: number;
  failedRequests: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  modelMs: number;
  turns: number;
  jobsDone: number;
  jobsFailed: number;
  jobsCancelled: number;
  jobsRecovered: number;
  jobMs: number;
  workerSessions: number;
  workerMs: number;
}

export interface ZaicodeStatsTotals {
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  requests: number;
  failedRequests: number;
  turns: number;
  jobsDone: number;
  jobsFailed: number;
  jobsCancelled: number;
  jobsRecovered: number;
  /** Model generation time (sum of request durations). */
  modelMs: number;
  /** Autonomous runtime: queue runs + CLI worker sessions. */
  agentMs: number;
  workerSessions: number;
  workerMs: number;
  /** Any recorded event at all. */
  events: number;
}

export type ZaicodeStatsPeriod = "today" | "yesterday" | "last7" | "week" | "last30" | "month" | "all";
export const ZAICODE_STATS_PERIODS: readonly ZaicodeStatsPeriod[] = ["today", "yesterday", "last7", "week", "last30", "month", "all"];

export type ZaicodeStreakMeasure = "activity" | "tokens" | "tasks" | "runs" | "runtime";
export const ZAICODE_STREAK_MEASURES: readonly ZaicodeStreakMeasure[] = ["activity", "tokens", "tasks", "runs", "runtime"];

export interface ZaicodeStatsDay {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  totals: ZaicodeStatsTotals;
}

export interface ZaicodeStatsRankRow {
  key: string;
  tokens: number;
  requests: number;
}

/** Per-model / per-project / per-local-hour sums (SQL gives UTC quarter hours for the hour table). */
export interface ZaicodeStatsBreakdownInput {
  models: readonly { provider: string; model: string; tokens: number; requests: number }[];
  projects: readonly { project: string; tokens: number; requests: number; events: number }[];
  longestRunMs: number | null;
}

export interface ZaicodeStatsCoverage {
  /** Model time whose tokens were measured. */
  measuredMs: number;
  /** CLI worker time: no token counts exist for it. */
  unmeasuredMs: number;
  /** measuredMs / (measuredMs + unmeasuredMs); null without any runtime. */
  share: number | null;
}

export interface ZaicodeStatsDerived {
  /** today.tokens / yesterday.tokens */
  tokensTodayVsYesterday: number | null;
  /** last7.tokens / (the 7 days before) */
  tokensWeekVsPreviousWeek: number | null;
  /** jobsDone / (jobsDone + jobsFailed), all time */
  jobSuccessRate: number | null;
  /** failedRequests / requests, all time */
  requestFailureRate: number | null;
  /** cacheRead / (input + cacheRead + cacheWrite), all time */
  cacheShare: number | null;
  /** jobsDone / (tokens / 1e6), all time */
  jobsPerMillionTokens: number | null;
  /** jobMs / jobs finished (done + failed + cancelled), all time */
  averageJobMs: number | null;
  /** jobsRecovered: finished OK as a retry of a failed / blocked run */
  recoveredRuns: number;
  /** Local hour (0-23) with the most model requests, all time. */
  peakHour: number | null;
  /** Date with the most tokens, all time. */
  busiestDay: { date: string; tokens: number } | null;
  mostUsedModel: ZaicodeStatsRankRow | null;
  mostActiveProject: ZaicodeStatsRankRow | null;
  longestRunMs: number | null;
}

export interface ZaicodeHomeStats {
  generatedAt: number;
  timeZone: string;
  weekStartsOn: number;
  today: string;
  periods: Record<ZaicodeStatsPeriod, ZaicodeStatsTotals>;
  /** Oldest first, ending today; `gridDays` long. */
  days: ZaicodeStatsDay[];
  streak: { measure: ZaicodeStreakMeasure; current: number; longest: number; activeDays: number };
  coverage: ZaicodeStatsCoverage;
  derived: ZaicodeStatsDerived;
  models: ZaicodeStatsRankRow[];
  projects: ZaicodeStatsRankRow[];
  firstEventAt: number | null;
  lastEventAt: number | null;
  /** Stored events (all sources). */
  eventCount: number;
  /** Per source: when it was last read, and whether it could be read. */
  sources: ZaicodeStatsSourceState[];
}

export interface ZaicodeStatsSourceState {
  source: "agent-db" | "queue" | "workers";
  label: string;
  state: "fresh" | "stale" | "unavailable";
  readAt: number | null;
  detail: string;
}

export interface ZaicodeHomeStatsRequest {
  timeZone: string;
  /** 0 = Sunday, 1 = Monday (default). */
  weekStartsOn?: number;
  streakMeasure?: ZaicodeStreakMeasure;
  /** Days in the activity grid (default 182, max 371). */
  gridDays?: number;
  /** Test hook; the service passes Date.now(). */
  now?: number;
}

export function emptyZaicodeStatsTotals(): ZaicodeStatsTotals {
  return {
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    requests: 0,
    failedRequests: 0,
    turns: 0,
    jobsDone: 0,
    jobsFailed: 0,
    jobsCancelled: 0,
    jobsRecovered: 0,
    modelMs: 0,
    agentMs: 0,
    workerSessions: 0,
    workerMs: 0,
    events: 0,
  };
}

function addBucket(totals: ZaicodeStatsTotals, bucket: ZaicodeStatsBucket): void {
  totals.tokens += bucket.tokens;
  totals.input += bucket.input;
  totals.output += bucket.output;
  totals.cacheRead += bucket.cacheRead;
  totals.cacheWrite += bucket.cacheWrite;
  totals.reasoning += bucket.reasoning;
  totals.requests += bucket.requests;
  totals.failedRequests += bucket.failedRequests;
  totals.turns += bucket.turns;
  totals.jobsDone += bucket.jobsDone;
  totals.jobsFailed += bucket.jobsFailed;
  totals.jobsCancelled += bucket.jobsCancelled;
  totals.jobsRecovered += bucket.jobsRecovered;
  totals.modelMs += bucket.modelMs;
  totals.agentMs += bucket.jobMs + bucket.workerMs;
  totals.workerSessions += bucket.workerSessions;
  totals.workerMs += bucket.workerMs;
  totals.events += bucket.requests + bucket.turns + bucket.jobsDone + bucket.jobsFailed + bucket.jobsCancelled + bucket.workerSessions;
}

function addTotals(target: ZaicodeStatsTotals, source: ZaicodeStatsTotals): void {
  for (const key of Object.keys(target) as (keyof ZaicodeStatsTotals)[]) target[key] += source[key];
}

// ---------------------------------------------------------------------------
// Calendar arithmetic (local dates as YYYY-MM-DD keys)
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** A zone Intl accepts, else the system zone, else UTC. */
export function resolveZaicodeTimeZone(timeZone: string | null | undefined): string {
  const candidates = [timeZone, safeSystemZone(), "UTC"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: candidate });
      return candidate;
    } catch {
      // try the next one
    }
  }
  return "UTC";
}

function safeSystemZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

/** Local date key and hour of an instant in `timeZone`. */
export function zaicodeLocalDayHour(at: number, timeZone: string): { date: string; hour: number } {
  const parts = formatterFor(timeZone).formatToParts(new Date(at));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const hour = Number(value("hour")) % 24;
  return { date: `${value("year")}-${value("month")}-${value("day")}`, hour };
}

function dayNumber(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

function dateOfNumber(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/** Calendar step on a date key (DST-free: pure date arithmetic). */
export function shiftZaicodeDate(date: string, days: number): string {
  return dateOfNumber(dayNumber(date) + days);
}

/** Weekday of a date key, 0 = Sunday. */
export function zaicodeWeekday(date: string): number {
  return (((dayNumber(date) + 4) % 7) + 7) % 7;
}

/** First day of the week that contains `date`. */
export function zaicodeWeekStart(date: string, weekStartsOn: number): string {
  const back = (zaicodeWeekday(date) - weekStartsOn + 7) % 7;
  return shiftZaicodeDate(date, -back);
}

/** Inclusive date range [from, to] of each period, relative to `today`. `all` has no range. */
export function zaicodePeriodRange(period: ZaicodeStatsPeriod, today: string, weekStartsOn: number): [string, string] | null {
  switch (period) {
    case "today":
      return [today, today];
    case "yesterday": {
      const yesterday = shiftZaicodeDate(today, -1);
      return [yesterday, yesterday];
    }
    case "last7":
      return [shiftZaicodeDate(today, -6), today];
    case "week":
      return [zaicodeWeekStart(today, weekStartsOn), today];
    case "last30":
      return [shiftZaicodeDate(today, -29), today];
    case "month":
      return [`${today.slice(0, 7)}-01`, today];
    case "all":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Local days from quarter-hour buckets, plus requests per local hour. */
export function zaicodeStatsDays(
  buckets: readonly ZaicodeStatsBucket[],
  timeZone: string,
): { byDate: Map<string, ZaicodeStatsTotals>; requestsByHour: number[] } {
  const byDate = new Map<string, ZaicodeStatsTotals>();
  const requestsByHour = Array.from({ length: 24 }, () => 0);
  for (const bucket of buckets) {
    const { date, hour } = zaicodeLocalDayHour(bucket.q * ZAICODE_STATS_BUCKET_MS, timeZone);
    let totals = byDate.get(date);
    if (!totals) {
      totals = emptyZaicodeStatsTotals();
      byDate.set(date, totals);
    }
    addBucket(totals, bucket);
    requestsByHour[hour] = (requestsByHour[hour] ?? 0) + bucket.requests;
  }
  return { byDate, requestsByHour };
}

export function zaicodeStreakValue(totals: ZaicodeStatsTotals, measure: ZaicodeStreakMeasure): number {
  switch (measure) {
    case "tokens":
      return totals.tokens;
    case "tasks":
      return totals.jobsDone;
    case "runs":
      return totals.turns + totals.jobsDone + totals.jobsFailed + totals.workerSessions;
    case "runtime":
      return totals.agentMs + totals.modelMs;
    case "activity":
      return totals.events;
  }
}

/**
 * Current streak: consecutive active days ending today, or ending yesterday
 * while today has nothing yet (the day is not over). Longest: the longest run
 * of consecutive active dates anywhere in history.
 */
export function zaicodeStreaks(activeDates: readonly string[], today: string): { current: number; longest: number } {
  const days = [...new Set(activeDates)].map(dayNumber).sort((left, right) => left - right);
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of days) {
    run = previous !== null && day === previous + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  const set = new Set(days);
  let cursor = dayNumber(today);
  if (!set.has(cursor)) cursor -= 1;
  let current = 0;
  while (set.has(cursor)) {
    current += 1;
    cursor -= 1;
  }
  return { current, longest };
}

/** Grid intensity 0-4: 0 = nothing, then quarters of the busiest day in view. */
export function zaicodeIntensity(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0;
  const share = value / max;
  if (share > 0.75) return 4;
  if (share > 0.5) return 3;
  if (share > 0.25) return 2;
  return 1;
}

const ratio = (numerator: number, denominator: number): number | null => (denominator > 0 ? numerator / denominator : null);

export function assembleZaicodeHomeStats(input: {
  buckets: readonly ZaicodeStatsBucket[];
  breakdown: ZaicodeStatsBreakdownInput;
  request: ZaicodeHomeStatsRequest;
  eventCount: number;
  firstEventAt: number | null;
  lastEventAt: number | null;
  sources: ZaicodeStatsSourceState[];
  now: number;
}): ZaicodeHomeStats {
  const timeZone = resolveZaicodeTimeZone(input.request.timeZone);
  const weekStartsOn = input.request.weekStartsOn === 0 ? 0 : 1;
  const measure = ZAICODE_STREAK_MEASURES.includes(input.request.streakMeasure as ZaicodeStreakMeasure)
    ? (input.request.streakMeasure as ZaicodeStreakMeasure)
    : "activity";
  const gridDays = Math.max(7, Math.min(371, Math.trunc(input.request.gridDays ?? 182)));
  const today = zaicodeLocalDayHour(input.now, timeZone).date;
  const { byDate, requestsByHour } = zaicodeStatsDays(input.buckets, timeZone);

  const periods = Object.fromEntries(ZAICODE_STATS_PERIODS.map((period) => [period, emptyZaicodeStatsTotals()])) as Record<
    ZaicodeStatsPeriod,
    ZaicodeStatsTotals
  >;
  const previousWeek = emptyZaicodeStatsTotals();
  const previousFrom = shiftZaicodeDate(today, -13);
  const previousTo = shiftZaicodeDate(today, -7);
  const ranges = ZAICODE_STATS_PERIODS.map((period) => [period, zaicodePeriodRange(period, today, weekStartsOn)] as const);
  let busiestDay: ZaicodeStatsDerived["busiestDay"] = null;
  for (const [date, totals] of byDate) {
    for (const [period, range] of ranges) {
      if (!range || (date >= range[0] && date <= range[1])) addTotals(periods[period], totals);
    }
    if (date >= previousFrom && date <= previousTo) addTotals(previousWeek, totals);
    if (totals.tokens > 0 && (!busiestDay || totals.tokens > busiestDay.tokens)) busiestDay = { date, tokens: totals.tokens };
  }

  const days: ZaicodeStatsDay[] = [];
  for (let offset = gridDays - 1; offset >= 0; offset -= 1) {
    const date = shiftZaicodeDate(today, -offset);
    days.push({ date, totals: byDate.get(date) ?? emptyZaicodeStatsTotals() });
  }
  const activeDates = [...byDate].filter(([, totals]) => zaicodeStreakValue(totals, measure) > 0).map(([date]) => date);
  const streak = { measure, ...zaicodeStreaks(activeDates, today), activeDays: activeDates.length };

  const all = periods.all;
  const measuredMs = all.modelMs;
  const unmeasuredMs = all.workerMs;
  const peak = Math.max(...requestsByHour);
  const models = input.breakdown.models
    .map((row) => ({ key: row.model ? `${row.provider} / ${row.model}` : row.provider, tokens: row.tokens, requests: row.requests }))
    .sort((left, right) => right.tokens - left.tokens || right.requests - left.requests);
  const projects = input.breakdown.projects
    .map((row) => ({ key: row.project, tokens: row.tokens, requests: row.requests }))
    .sort((left, right) => right.tokens - left.tokens || right.requests - left.requests);
  const jobsFinished = all.jobsDone + all.jobsFailed + all.jobsCancelled;

  return {
    generatedAt: input.now,
    timeZone,
    weekStartsOn,
    today,
    periods,
    days,
    streak,
    coverage: { measuredMs, unmeasuredMs, share: ratio(measuredMs, measuredMs + unmeasuredMs) },
    derived: {
      tokensTodayVsYesterday: ratio(periods.today.tokens, periods.yesterday.tokens),
      tokensWeekVsPreviousWeek: ratio(periods.last7.tokens, previousWeek.tokens),
      jobSuccessRate: ratio(all.jobsDone, all.jobsDone + all.jobsFailed),
      requestFailureRate: ratio(all.failedRequests, all.requests),
      cacheShare: ratio(all.cacheRead, all.input + all.cacheRead + all.cacheWrite),
      jobsPerMillionTokens: all.tokens > 0 ? all.jobsDone / (all.tokens / 1_000_000) : null,
      averageJobMs: jobsFinished > 0 ? input.buckets.reduce((sum, bucket) => sum + bucket.jobMs, 0) / jobsFinished : null,
      recoveredRuns: all.jobsRecovered,
      peakHour: peak > 0 ? requestsByHour.indexOf(peak) : null,
      busiestDay,
      mostUsedModel: models[0] ?? null,
      mostActiveProject: projects[0] ?? null,
      longestRunMs: input.breakdown.longestRunMs,
    },
    models: models.slice(0, 8),
    projects: projects.slice(0, 12),
    firstEventAt: input.firstEventAt,
    lastEventAt: input.lastEventAt,
    eventCount: input.eventCount,
    sources: input.sources,
  };
}

/** "2.8M", "940k", "1.2B": compact counts for tiles (exact value goes in the tooltip). */
export function formatZaicodeCompactCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(value));
}
