/**
 * Reset credits (T-130, SRC-093): quota resets a subscription hands out that the owner can spend on demand.
 *
 * Codex grants them ("Full reset (Weekly + 5 hr)", "You've been granted one free rate limit reset"). Its app-server returns them
 * next to the windows in `account/rateLimits/read` and spends one with `account/rateLimitResetCredit/consume`; ZAICODE read the
 * windows and dropped the credits, so an account blocked by a spent week showed no way out. ZCode's Coding Plan has its own
 * (ZaicodeCodingPlanResets, read through ZCode's controller). Claude Code exposes no such thing (its CLI knows extra usage,
 * not reset credits), so there is nothing to read for it.
 *
 * Pure vocabulary and parsers, shared by the main process that reads and spends and the window that shows them. Reading never
 * spends: only `consume`, only on an explicit click, only after the window asked in words.
 */

export type ZaicodeResetCreditStatus = "available" | "redeeming" | "redeemed" | "unknown";

export interface ZaicodeResetCredit {
  /** Opaque backend id: passed back to spend exactly this credit. */
  id: string;
  title: string | null;
  description: string | null;
  /** Epoch ms. */
  grantedAt: number;
  /** Epoch ms, null = does not expire. */
  expiresAt: number | null;
  status: ZaicodeResetCreditStatus;
}

export interface ZaicodeResetCredits {
  /** What the vendor says can be spent now. */
  availableCount: number;
  /** The detail rows the vendor sent (it may cap them, so this can be shorter than the count); null = only the count is known. */
  credits: ZaicodeResetCredit[] | null;
}

const STATUSES: readonly ZaicodeResetCreditStatus[] = ["available", "redeeming", "redeemed", "unknown"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function epochMsFromSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : null;
}

/**
 * The `rateLimitResetCredits` block of an `account/rateLimits/read` result. null = the vendor sent none (unknown, not zero);
 * a block with a count of 0 is a real "nothing to spend".
 */
export function parseCodexResetCredits(result: unknown): ZaicodeResetCredits | null {
  const block = isRecord(result) ? result["rateLimitResetCredits"] : null;
  if (!isRecord(block)) return null;
  const count = block["availableCount"];
  const availableCount = typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const raw = block["credits"];
  if (!Array.isArray(raw)) return { availableCount, credits: null };
  const credits: ZaicodeResetCredit[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = typeof entry["id"] === "string" ? entry["id"].trim() : "";
    if (!id || id.length > 200 || credits.some((credit) => credit.id === id)) continue;
    const status = STATUSES.find((candidate) => candidate === entry["status"]) ?? "unknown";
    // A credit that was already spent is history, not something to offer.
    if (status === "redeemed") continue;
    credits.push({
      id,
      title: text(entry["title"], 120),
      description: text(entry["description"], 300),
      grantedAt: epochMsFromSeconds(entry["grantedAt"]) ?? 0,
      expiresAt: epochMsFromSeconds(entry["expiresAt"]),
      status,
    });
  }
  return { availableCount, credits };
}

/** How many credits can be spent at `now`: the vendor's count, less the detail rows that have run out. */
export function zaicodeResetCreditsUsable(credits: ZaicodeResetCredits | null | undefined, now: number): number {
  if (!credits || credits.availableCount <= 0) return 0;
  if (credits.credits === null) return credits.availableCount;
  const expired = credits.credits.filter((credit) => credit.expiresAt !== null && credit.expiresAt <= now).length;
  return Math.max(0, credits.availableCount - expired);
}

/** The soonest expiry among the credits that can still be spent, or null (none expires, or no detail). */
export function zaicodeNextResetCreditExpiry(credits: ZaicodeResetCredits | null | undefined, now: number): number | null {
  const expiries = (credits?.credits ?? []).flatMap((credit) => (credit.expiresAt !== null && credit.expiresAt > now && credit.status !== "redeeming" ? [credit.expiresAt] : []));
  return expiries.length > 0 ? Math.min(...expiries) : null;
}

/** The credit to spend when the person just says "use one": the one that runs out first, then the oldest. */
export function zaicodePickResetCredit(credits: ZaicodeResetCredits | null | undefined, now: number): ZaicodeResetCredit | null {
  const usable = (credits?.credits ?? []).filter((credit) => credit.status === "available" && (credit.expiresAt === null || credit.expiresAt > now));
  usable.sort((left, right) => (left.expiresAt ?? Number.MAX_SAFE_INTEGER) - (right.expiresAt ?? Number.MAX_SAFE_INTEGER) || left.grantedAt - right.grantedAt);
  return usable[0] ?? null;
}

// ---------------------------------------------------------------- spending

export type ZaicodeResetConsumeOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed" | "unavailable";

export interface ZaicodeResetConsumeResult {
  outcome: ZaicodeResetConsumeOutcome;
  /** One plain sentence for the person: what happened, and what to do when it did not work. */
  message: string;
}

/** The `outcome` of an `account/rateLimitResetCredit/consume` result; null when the answer has none we know. */
export function parseCodexConsumeOutcome(result: unknown): Exclude<ZaicodeResetConsumeOutcome, "unavailable"> | null {
  const outcome = isRecord(result) ? result["outcome"] : null;
  return outcome === "reset" || outcome === "nothingToReset" || outcome === "noCredit" || outcome === "alreadyRedeemed" ? outcome : null;
}

/** What each answer means, in words (the account's label goes first so a toast names whose reset it was). */
export function describeZaicodeResetOutcome(accountLabel: string, outcome: ZaicodeResetConsumeOutcome, detail?: string): string {
  switch (outcome) {
    case "reset":
      return `${accountLabel}: reset used. The spent windows are refilled.`;
    case "nothingToReset":
      return `${accountLabel}: nothing to reset right now (no window is spent), so the reset was kept.`;
    case "noCredit":
      return `${accountLabel}: no reset credit is left.`;
    case "alreadyRedeemed":
      return `${accountLabel}: this reset was already used a moment ago.`;
    default:
      return `${accountLabel}: the reset did not go through${detail ? ` (${detail})` : ""}. Nothing was spent.`;
  }
}
