/**
 * T-224 / SRC-154:R003 — one persisted policy for the right SAIPEN/task side
 * pane that Ctrl+Alt+B toggles.
 *
 * Visibility used to be a renderer module-level Map (lib/taskSidePaneMemory.ts):
 * it survived an in-app project switch and nothing else. Closing the app threw
 * the operator's choice away, and there was no way to say "keep it as I left it
 * in every project" at all — the pane always came back with the previous
 * session's answer.
 *
 * This module owns the choice as DATA, with no DOM and no store import, so the
 * whole policy is testable directly:
 *
 *  - `everywhere`: ONE global answer. Leave the pane open and every project and
 *    every session shows it open; close it and they all stay closed.
 *  - `perOwner`:   the answer is remembered per owner. The owner is the session
 *    when the pane belongs to one, else the project/workspace — the canonical
 *    identity the side pane already uses (`sidePaneOwnerKey`). Project A with
 *    three independently restorable sessions therefore keeps three answers, and
 *    returning to A restores A's without an intermediate toggle.
 *
 * Ctrl+Alt+B keeps toggling the current effective pane. That toggle writes into
 * the scope the policy selected, and switching policy never deletes the other
 * scope's remembered values, so everywhere -> perOwner -> everywhere is lossless.
 */

import { sidePaneOwnerKey } from "@/lib/workspaceSidePane.js";

export type ZaicodeSidePaneVisibilityMode = "everywhere" | "perOwner";

export const ZAICODE_SIDE_PANE_VISIBILITY_MODES: readonly ZaicodeSidePaneVisibilityMode[] = [
  "everywhere",
  "perOwner",
];

/** Wording lives with the model so the settings UI and the tests cannot drift. */
export const ZAICODE_SIDE_PANE_VISIBILITY_LABELS: Readonly<
  Record<ZaicodeSidePaneVisibilityMode, { label: string; hint: string }>
> = {
  everywhere: {
    label: "One answer everywhere",
    hint: "Leave the pane open and it stays open in every project and session; close it and it stays closed.",
  },
  perOwner: {
    label: "Remember per project and session",
    hint: "Each project and session keeps its own open/closed answer and gets it back when you return.",
  },
};

export interface ZaicodeSidePaneVisibilityPrefs {
  mode: ZaicodeSidePaneVisibilityMode;
  /**
   * The `everywhere` answer. `null` means "nothing chosen yet", which is NOT
   * the same as `false`: a fresh profile must still be able to show a pane that
   * has real content, and only an explicit close may force it shut.
   */
  everywhere: boolean | null;
  /** Owner key -> answer, for `perOwner`. Kept while `everywhere` is active. */
  byOwner: Record<string, boolean>;
}

export const ZAICODE_SIDE_PANE_VISIBILITY_DEFAULT: ZaicodeSidePaneVisibilityPrefs = {
  mode: "everywhere",
  everywhere: null,
  byOwner: {},
};

/** The owner key a draft pane uses; mirrors `sidePaneOwnerKey(null)`. */
export const ZAICODE_SIDE_PANE_DRAFT_OWNER_KEY = sidePaneOwnerKey(null);

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function flagMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, boolean> = {};
  for (const [key, answer] of Object.entries(value as Record<string, unknown>)) {
    if (key.trim() && typeof answer === "boolean") out[key] = answer;
  }
  return out;
}

/**
 * The per-owner map is operator data, not a leak: a deleted project or session
 * must not pin its answer forever, and the flat settings store keeps no owner
 * registry to garbage-collect against. The cap is the cleanup: the map never
 * holds more than the most recent answers, so dead owners age out on their own.
 */
export const ZAICODE_SIDE_PANE_VISIBILITY_MAX_OWNERS = 200;

function capOwnerMap(byOwner: Record<string, boolean>): Record<string, boolean> {
  const keys = Object.keys(byOwner);
  if (keys.length <= ZAICODE_SIDE_PANE_VISIBILITY_MAX_OWNERS) return byOwner;
  const kept: Record<string, boolean> = {};
  for (const key of keys.slice(keys.length - ZAICODE_SIDE_PANE_VISIBILITY_MAX_OWNERS)) {
    const answer = byOwner[key];
    if (typeof answer === "boolean") kept[key] = answer;
  }
  return kept;
}

/**
 * Drops remembered answers for owners that no longer exist. The caller passes
 * the live set when it has one (a project list, a session list); without it
 * the cap above is the cleanup. Either way the mode and the surviving answers
 * are untouched.
 */
export function pruneZaicodeSidePaneVisibility(
  prefs: ZaicodeSidePaneVisibilityPrefs,
  liveOwnerKeys: ReadonlySet<string>,
): Partial<ZaicodeSidePaneVisibilityPrefs> {
  const byOwner: Record<string, boolean> = {};
  for (const [key, answer] of Object.entries(prefs.byOwner)) {
    if (liveOwnerKeys.has(key)) byOwner[key] = answer;
  }
  return { byOwner };
}

/** Stored preferences are user-writable, so anything else falls back. */
export function normalizeZaicodeSidePaneVisibility(
  raw: unknown,
): ZaicodeSidePaneVisibilityPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    mode: r.mode === "perOwner" ? "perOwner" : "everywhere",
    everywhere: flag(r.everywhere),
    byOwner: capOwnerMap(flagMap(r.byOwner)),
  };
}

/**
 * The canonical owner of the pane: the session it belongs to when there is one,
 * otherwise the project/workspace. `sidePaneOwnerKey` is the product's existing
 * answer for a session and it deliberately keeps `__draft__` for "no session",
 * so a draft pane in one project never answers for another project's draft.
 * A named workspace is folded in only for the sessionless case, which is the
 * pane whose owner really is the project.
 */
export function sidePaneVisibilityOwnerKey(owner: {
  sessionId?: string | null;
  workspaceKey?: string | null;
}): string {
  const sessionId = owner.sessionId?.trim();
  if (sessionId) return sidePaneOwnerKey(sessionId);
  const workspaceKey = owner.workspaceKey?.trim();
  if (workspaceKey) return `${ZAICODE_SIDE_PANE_DRAFT_OWNER_KEY}@${workspaceKey}`;
  return ZAICODE_SIDE_PANE_DRAFT_OWNER_KEY;
}

/**
 * The answer the pane must show right now.
 *
 * `defaultOpen` is what the pane would do with no preference at all (it has
 * content, so it shows). A remembered answer always wins; an unremembered owner
 * falls through to the `everywhere` answer and then to `defaultOpen`. Under
 * `everywhere` a remembered per-owner value is deliberately NOT consulted —
 * that is the whole point of the mode — but it is kept in the map so switching
 * back restores it.
 */
export function resolveZaicodeSidePaneVisibility(
  prefs: ZaicodeSidePaneVisibilityPrefs,
  ownerKey: string,
  defaultOpen: boolean,
): boolean {
  if (prefs.mode === "everywhere") return prefs.everywhere ?? defaultOpen;
  const remembered = prefs.byOwner[ownerKey];
  return typeof remembered === "boolean" ? remembered : (prefs.everywhere ?? defaultOpen);
}

/**
 * Writes one absolute answer into the scope the policy selected. The toggle
 * below is defined through this, and the app's reveal paths (opening a tab
 * shows the pane) use it directly: the stored answer always describes the pane
 * as it is, never a stale inherited one.
 */
export function setZaicodeSidePaneVisibility(
  prefs: ZaicodeSidePaneVisibilityPrefs,
  ownerKey: string,
  visible: boolean,
): Partial<ZaicodeSidePaneVisibilityPrefs> {
  if (prefs.mode === "everywhere") return { everywhere: visible };
  return { byOwner: { ...prefs.byOwner, [ownerKey]: visible } };
}

/**
 * The patch Ctrl+Alt+B writes. It edits the scope the policy selected and
 * touches nothing else, so the other scope's remembered values survive.
 * `defaultOpen` is folded into the written value: after a toggle the effective
 * answer is exactly `!current`, never a stale inherited one.
 */
export function toggleZaicodeSidePaneVisibility(
  prefs: ZaicodeSidePaneVisibilityPrefs,
  ownerKey: string,
  defaultOpen: boolean,
): Partial<ZaicodeSidePaneVisibilityPrefs> {
  return setZaicodeSidePaneVisibility(
    prefs,
    ownerKey,
    !resolveZaicodeSidePaneVisibility(prefs, ownerKey, defaultOpen),
  );
}

/**
 * The persisted answer as a collapsed flag, or undefined when the policy has
 * nothing to say for this owner. Every read site in the app falls back to the
 * in-memory answer and then to the content default, so an explicit operator
 * choice always wins and a fresh owner still opens a pane that has content.
 */
export function persistedSidePaneCollapsedFor(
  prefs: ZaicodeSidePaneVisibilityPrefs,
  ownerKey: string,
): boolean | undefined {
  if (prefs.mode === "everywhere") {
    return prefs.everywhere === null ? undefined : !prefs.everywhere;
  }
  const remembered = prefs.byOwner[ownerKey];
  if (typeof remembered === "boolean") return !remembered;
  return prefs.everywhere === null ? undefined : !prefs.everywhere;
}

/** Explicit scope names, so the settings UI never shows a bare "default". */
export function zaicodeSidePaneVisibilityScopeLabel(
  prefs: ZaicodeSidePaneVisibilityPrefs,
  ownerKey: string,
): string {
  if (prefs.mode === "everywhere") return "Everywhere";
  return prefs.byOwner[ownerKey] === undefined ? "Not set for this one yet" : "This project/session";
}

/** Forgets every remembered answer, on every owner, keeping the mode. */
export function clearZaicodeSidePaneVisibilityMemory(): Partial<ZaicodeSidePaneVisibilityPrefs> {
  return { everywhere: null, byOwner: {} };
}
