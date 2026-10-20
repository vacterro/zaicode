import type { ZaicodeStatsTotals } from "@zcode/shared";

/**
 * REQ-012: usage attribution scopes. Global is the authoritative local row;
 * project and session slices only ever show what was actually recorded under
 * that key — a scope with no recorded events renders a zero row, never a
 * share carved out of the global total.
 */
export const ZAICODE_USAGE_SCOPES = ["global", "project", "session"] as const;
export type ZaicodeUsageScopeId = (typeof ZAICODE_USAGE_SCOPES)[number];

export const ZAICODE_USAGE_SCOPE_LABEL: Record<ZaicodeUsageScopeId, string> = {
  global: "Global",
  project: "Project",
  session: "Session",
};

export interface ZaicodeUsageScopeSelection {
  project: string | null;
  sessionId: string | null;
}

/**
 * Which recorded slice a scope tab reads. Returns null while the tab has no
 * selection yet, so the panel shows the picker instead of fetching.
 */
export function zaicodeScopeRequest(
  scope: ZaicodeUsageScopeId,
  selection: ZaicodeUsageScopeSelection,
): ZaicodeUsageScopeSelection | null {
  if (scope === "global") return { project: null, sessionId: null };
  if (scope === "project") return selection.project ? { project: selection.project, sessionId: null } : null;
  return selection.sessionId ? { project: selection.project, sessionId: selection.sessionId } : null;
}

/** A zero row means "no recorded events for this scope", not "usage is zero everywhere". */
export function zaicodeScopeIsEmpty(totals: ZaicodeStatsTotals): boolean {
  return totals.tokens === 0 && totals.requests === 0 && totals.turns === 0 && totals.jobsDone === 0 && totals.workerSessions === 0;
}

const whole = (value: number): string => value.toLocaleString(undefined, { maximumFractionDigits: 0 });

/** One-line scope summary; session keys stay short so long IDs do not break the row. */
export function zaicodeScopeSummary(totals: ZaicodeStatsTotals): string {
  return `${whole(totals.tokens)} tokens · ${whole(totals.requests)} requests · ${whole(totals.turns)} turns · ${totals.jobsDone} done`;
}

/** Session picker labels: short id plus the owning project when one is recorded. */
export function zaicodeScopeSessionLabel(sessionId: string, project: string | null): string {
  const short = sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId;
  return project ? `${short} · ${project}` : short;
}
