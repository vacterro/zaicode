import { zaicodeMainIsValid } from "./zaicodeProjectClick.js";
import { zaicodeMainKeyForm, zaicodeMainSessionIdOf } from "./zaicodeMainSession.js";
import type { ZaicodeSessionRole } from "./zaicodeSessionRoles.js";
import { isZaicodeHelperRole } from "./zaicodeSessionRoles.js";

/**
 * One-way bulk MAIN assignment across every registered project (SRC-290).
 *
 * SET ALL, never TOGGLE ALL: a project that already has a valid MAIN keeps it,
 * a project without one receives its most recently active eligible ordinary
 * session, and a project with no eligible session at all is left pending --
 * never given a fabricated MAIN id, and never started.
 *
 * The decision is a pure plan over the project/session read-model, so the
 * counts the operator reads are the same ones the mutation executes.
 */

export interface ZaicodeMainBulkCandidate {
  sessionId: string;
  title: string;
  updatedAt?: number | null;
  /** Persistent subSaipen role: a helper must never be promoted by recency. */
  role?: ZaicodeSessionRole | null;
}

export interface ZaicodeMainBulkProject {
  /** Workspace key (`workspaceIdentity || workspacePath`). */
  key: string;
  name: string;
  /** A switched-off project is checked but never written to. */
  disabled?: boolean;
  sessions: readonly ZaicodeMainBulkCandidate[];
}

export type ZaicodeMainBulkOutcome =
  | { kind: "assigned"; key: string; name: string; sessionId: string; title: string }
  | { kind: "unchanged"; key: string; name: string }
  | { kind: "pending"; key: string; name: string }
  | { kind: "skipped"; key: string; name: string };

export interface ZaicodeMainBulkPlan {
  outcomes: ZaicodeMainBulkOutcome[];
  assigned: number;
  unchanged: number;
  pending: number;
  skipped: number;
}

/**
 * The most recently active session that may become MAIN, or null when none
 * qualifies. A helper session is not a candidate even with the newest
 * timestamp, and an unresolved identity never is one.
 */
export function selectZaicodeMainBulkCandidate(
  sessions: readonly ZaicodeMainBulkCandidate[],
): ZaicodeMainBulkCandidate | null {
  let best: ZaicodeMainBulkCandidate | null = null;
  for (const session of sessions) {
    if (!session.sessionId) continue;
    if (isZaicodeHelperRole(session.role ?? null)) continue;
    if (!best || (session.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = session;
  }
  return best;
}

export function planZaicodeMainBulkAssign(input: {
  projects: readonly ZaicodeMainBulkProject[];
  byWorkspace: Readonly<Record<string, string>>;
}): ZaicodeMainBulkPlan {
  const outcomes: ZaicodeMainBulkOutcome[] = [];
  const seen = new Set<string>();
  let assigned = 0;
  let unchanged = 0;
  let pending = 0;
  let skipped = 0;
  for (const project of input.projects) {
    // Two spellings of one project path are one project and one MAIN entry.
    const keyForm = zaicodeMainKeyForm(project.key);
    if (seen.has(keyForm)) continue;
    seen.add(keyForm);
    const sessionIds = project.sessions.map((session) => session.sessionId);
    if (project.disabled) {
      outcomes.push({ kind: "skipped", key: project.key, name: project.name });
      skipped += 1;
      continue;
    }
    const existing = zaicodeMainSessionIdOf(input.byWorkspace, project.key);
    if (zaicodeMainIsValid(existing, sessionIds)) {
      outcomes.push({ kind: "unchanged", key: project.key, name: project.name });
      unchanged += 1;
      continue;
    }
    const candidate = selectZaicodeMainBulkCandidate(project.sessions);
    if (candidate) {
      outcomes.push({
        kind: "assigned",
        key: project.key,
        name: project.name,
        sessionId: candidate.sessionId,
        title: candidate.title,
      });
      assigned += 1;
      continue;
    }
    outcomes.push({ kind: "pending", key: project.key, name: project.name });
    pending += 1;
  }
  return { outcomes, assigned, unchanged, pending, skipped };
}

export interface ZaicodeMainBulkApplyStore {
  byWorkspace: Readonly<Record<string, string>>;
  /** Live read: a captured snapshot cannot see an edit made after this command. */
  currentMain: (workspaceKey: string) => string | null;
  setMain: (workspaceKey: string, sessionId: string) => void;
  clearMain: (workspaceKey: string) => void;
  /** One coordinated mutation over the whole map; false when writing was refused. */
  setMainBulk: (entries: readonly { workspaceKey: string; sessionId: string }[]) => boolean;
  arm: (workspaceKey: string) => void;
  disarm: (workspaceKey: string) => void;
}

export interface ZaicodeMainBulkResult {
  plan: ZaicodeMainBulkPlan;
  /** False when the durable write was refused (quota, locked storage). */
  persisted: boolean;
  /** Restores only what this operation wrote, and never overwrites a newer edit. */
  undo: () => void;
}

/**
 * Executes the plan as one coordinated mutation: one map build, one durable
 * write, and a snapshot precise enough that Undo cannot roll back an operator
 * edit made after the fact. No session is created, started or stopped here.
 */
export function applyZaicodeMainBulkAssign(
  projects: readonly ZaicodeMainBulkProject[],
  store: ZaicodeMainBulkApplyStore,
): ZaicodeMainBulkResult {
  const plan = planZaicodeMainBulkAssign({ projects, byWorkspace: store.byWorkspace });
  const entries = plan.outcomes
    .filter((outcome) => outcome.kind === "assigned")
    .map((outcome) => ({ workspaceKey: outcome.key, sessionId: outcome.sessionId }));
  const previous = new Map<string, string | null>();
  for (const entry of entries) {
    // Read through the resolver: the stored spelling may differ from the project's.
    previous.set(entry.workspaceKey, zaicodeMainSessionIdOf(store.byWorkspace, entry.workspaceKey));
  }
  const written = new Map(entries.map((entry) => [entry.workspaceKey, entry.sessionId]));
  const pendingKeys = plan.outcomes
    .filter((outcome) => outcome.kind === "pending")
    .map((outcome) => outcome.key);
  const persisted = entries.length > 0 ? store.setMainBulk(entries) : true;
  for (const key of pendingKeys) store.arm(key);
  return {
    plan,
    persisted,
    undo: () => {
      for (const [key, value] of previous) {
        // A later operator edit to this project is theirs; leave it alone.
        if (store.currentMain(key) !== written.get(key)) continue;
        if (value === null) store.clearMain(key);
        else store.setMain(key, value);
      }
      for (const key of pendingKeys) store.disarm(key);
    },
  };
}
