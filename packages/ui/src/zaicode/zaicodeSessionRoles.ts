import { create } from "zustand";

/**
 * Which kind of worker a session is: MAIN (the project's iron slot, tracked in
 * zaicodeMainSession), a subSaipen helper (WIKI, TRANSL, TEST, AUDIT, HUNT,
 * CLEAN, CREW) or a plain side session. The role is recorded when the helper
 * is launched — arm on click, claim when the fresh session gets its id — so
 * the icon survives the session being renamed to "PHASE SCOUT T-…". Sessions
 * started before this existed fall back to a strict title match (the title a
 * session is born with is its first prompt, e.g. "saiwiki").
 */
export const ZAICODE_SESSION_ROLES = ["WIKI", "TRANSL", "TEST", "AUDIT", "HUNT", "CLEAN", "CREW"] as const;
export type ZaicodeSessionRole = (typeof ZAICODE_SESSION_ROLES)[number];

export const ZAICODE_ROLE_META: Record<ZaicodeSessionRole, { title: string; color: string }> = {
  WIKI: { title: "Wikier (saiwiki)", color: "#6aa5e8" },
  TRANSL: { title: "Translator (saitranslate)", color: "#52c28a" },
  TEST: { title: "Tester (saitest)", color: "#b58be0" },
  AUDIT: { title: "Auditor (saipen markhunt)", color: "#e0b04a" },
  HUNT: { title: "Hunter (saihunt)", color: "#e0665a" },
  CLEAN: { title: "Cleaner (saipen clean)", color: "#4fc0b5" },
  CREW: { title: "Crew (saipen crew)", color: "#e0884a" },
};

const STORAGE_KEY = "zaicode-session-roles-v1";
const MAX_ROLES = 2000;

function load(): Record<string, ZaicodeSessionRole> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    const roles: Record<string, ZaicodeSessionRole> = {};
    for (const [sessionId, role] of Object.entries(raw)) {
      if ((ZAICODE_SESSION_ROLES as readonly string[]).includes(role as string)) {
        roles[sessionId] = role as ZaicodeSessionRole;
      }
    }
    return roles;
  } catch {
    return {};
  }
}

interface ZaicodeSessionRoleState {
  bySession: Record<string, ZaicodeSessionRole>;
  armed: Record<string, ZaicodeSessionRole>;
  arm: (workspaceKey: string, role: ZaicodeSessionRole) => void;
  claimIfArmed: (workspaceKey: string, sessionId: string) => void;
  setRole: (sessionId: string, role: ZaicodeSessionRole | null) => void;
}

export const useZaicodeSessionRoles = create<ZaicodeSessionRoleState>((set, get) => ({
  bySession: typeof localStorage === "undefined" ? {} : load(),
  armed: {},
  arm: (workspaceKey, role) => set({ armed: { ...get().armed, [workspaceKey]: role } }),
  claimIfArmed: (workspaceKey, sessionId) => {
    const role = get().armed[workspaceKey];
    if (!role) return;
    const armed = { ...get().armed };
    delete armed[workspaceKey];
    set({ armed });
    get().setRole(sessionId, role);
  },
  setRole: (sessionId, role) => {
    const bySession = { ...get().bySession };
    if (role) bySession[sessionId] = role;
    else delete bySession[sessionId];
    const keys = Object.keys(bySession);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ROLES))) delete bySession[key];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(bySession));
    } catch {
      // this window keeps it
    }
    set({ bySession });
  },
}));

const TITLE_PATTERNS: readonly [RegExp, ZaicodeSessionRole][] = [
  [/^\s*\/?(?:saipen\s+)?saiwiki\b/i, "WIKI"],
  [/^\s*\/?(?:saipen\s+)?saitranslate\b/i, "TRANSL"],
  [/^\s*\/?(?:saipen\s+)?saitest\b/i, "TEST"],
  [/^\s*\/?(?:saipen\s+)?(?:saihunt|hunt)\b/i, "HUNT"],
  [/^\s*\/?(?:aa|saipen\s+markhunt|markhunt)\b/i, "AUDIT"],
  [/^\s*\/?saipen\s+clean\b/i, "CLEAN"],
  [/^\s*\/?(?:saipen\s+crew|sc)\b/i, "CREW"],
];

/** Role from the title a session was born with (its first prompt), strictly at the start. */
export function zaicodeRoleFromTitle(title: string): ZaicodeSessionRole | null {
  for (const [pattern, role] of TITLE_PATTERNS) if (pattern.test(title)) return role;
  return null;
}

export function zaicodeRoleForCommand(command: string): ZaicodeSessionRole | null {
  return zaicodeRoleFromTitle(command);
}

export function useZaicodeSessionRole(sessionId: string, title: string): ZaicodeSessionRole | null {
  const stored = useZaicodeSessionRoles((state) => state.bySession[sessionId] ?? null);
  return stored ?? zaicodeRoleFromTitle(title);
}
