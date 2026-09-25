/**
 * ZAICODE execution topology (T-42, SRC-033 analysis 3).
 *
 *   Project -> primary session, auxiliary sessions, workers, subscription chats
 *
 * Who runs what (a runtime identity: runtime_id, work_id, owner, role,
 * generation, engine, lease, health) is one record owned by the runtime that
 * started it. Where it is shown (panel, tab, own window, chip, sidebar, tray,
 * a sidebar slot) is a separate placement record owned by the UI. The two
 * never share a write path:
 *
 *   location != ownership, window != worker identity, slot != execution authority.
 *
 * Identity records are frozen and change only through a runtime transition
 * (exit, restart as the next generation); a placement patch that names an
 * identity field is refused, not merged.
 */

export type ZaicodeRuntimeRole = "primary" | "auxiliary" | "worker" | "subchat" | "fix" | "shell";
export type ZaicodeRuntimeHealth = "running" | "exited" | "failed";

export interface ZaicodeRuntimeLease {
  /** What holds the process alive: the ZAICODE window (PTY), the main process (headless CLI), the agent host. */
  readonly holder: string;
  readonly since: number;
}

export interface ZaicodeRuntimeIdentity {
  readonly runtimeId: string;
  /** The work it serves: a session id, a chat id, a queue job; null when none is known. */
  readonly workId: string | null;
  /** Execution authority: the subscription login or agent seat that runs it. */
  readonly owner: string | null;
  readonly role: ZaicodeRuntimeRole;
  /** 1 for the first run of this work in this place; +1 for every restart of it. */
  readonly generation: number;
  /** Engine family (claude, codex, a model id); null for a plain shell. */
  readonly engine: string | null;
  readonly projectPath: string;
  /** null once it ended. */
  readonly lease: ZaicodeRuntimeLease | null;
  readonly health: ZaicodeRuntimeHealth;
}

export const ZAICODE_RUNTIME_IDENTITY_KEYS = [
  "runtimeId",
  "workId",
  "owner",
  "role",
  "generation",
  "engine",
  "projectPath",
  "lease",
  "health",
] as const satisfies readonly (keyof ZaicodeRuntimeIdentity)[];

export function freezeZaicodeRuntimeIdentity(identity: ZaicodeRuntimeIdentity): ZaicodeRuntimeIdentity {
  return Object.freeze({ ...identity, lease: identity.lease ? Object.freeze({ ...identity.lease }) : null });
}

export type ZaicodeRuntimeTransition =
  | { type: "exited"; code: number; at: number }
  | { type: "restarted"; runtimeId: string; at: number; holder: string };

/** The only way an identity changes: its runtime reports an exit, or starts the next generation. */
export function transitionZaicodeRuntime(identity: ZaicodeRuntimeIdentity, event: ZaicodeRuntimeTransition): ZaicodeRuntimeIdentity {
  if (event.type === "exited") {
    return freezeZaicodeRuntimeIdentity({ ...identity, lease: null, health: event.code === 0 ? "exited" : "failed" });
  }
  return freezeZaicodeRuntimeIdentity({
    ...identity,
    runtimeId: event.runtimeId,
    generation: identity.generation + 1,
    lease: { holder: event.holder, since: event.at },
    health: "running",
  });
}

/**
 * The placement write path: only `allowed` keys may change. A patch naming any
 * other key -- an identity field above all -- throws, so layout code cannot
 * move ownership by accident.
 */
export function applyZaicodePlacementPatch<P extends object>(placement: P, patch: Partial<P>, allowed: readonly (keyof P)[]): P {
  const refused = Object.keys(patch).filter((key) => !allowed.includes(key as keyof P));
  if (refused.length > 0) throw new TypeError(`placement cannot change ${refused.join(", ")}`);
  return { ...placement, ...patch };
}

export interface ZaicodeProjectTopology {
  projectPath: string;
  /** The MAIN session's identity, when one is set; MAIN is a label, the session's owner is its agent runtime. */
  primary: ZaicodeRuntimeIdentity | null;
  auxiliary: ZaicodeRuntimeIdentity[];
  workers: ZaicodeRuntimeIdentity[];
  subchats: ZaicodeRuntimeIdentity[];
}

function sameProject(left: string, right: string): boolean {
  return left.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === right.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** One project's topology from the registry's identities; placement is not an input. */
export function zaicodeProjectTopology(identities: readonly ZaicodeRuntimeIdentity[], projectPath: string): ZaicodeProjectTopology {
  const mine = identities.filter((identity) => sameProject(identity.projectPath, projectPath));
  return {
    projectPath,
    primary: mine.find((identity) => identity.role === "primary") ?? null,
    auxiliary: mine.filter((identity) => identity.role === "auxiliary"),
    workers: mine.filter((identity) => identity.role === "worker" || identity.role === "fix" || identity.role === "shell"),
    subchats: mine.filter((identity) => identity.role === "subchat"),
  };
}
