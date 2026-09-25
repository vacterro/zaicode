/**
 * Projects the operator switched off (Shift+Click on the project in the
 * sidebar). A disabled project stays listed and openable by hand, but no
 * automatic agent works in it: the queue does not auto-dispatch its jobs and
 * the Scheduler skips it when it resolves targets. Stored by workspace key
 * (`workspaceIdentity || workspacePath`) in the ZAICODE settings table.
 */

export const ZAICODE_DISABLED_WORKSPACES_SETTING_KEY = "disabled_workspaces";
/** A hard ceiling so a corrupted value cannot grow without bound. */
const MAX_DISABLED = 512;

export function normalizeZaicodeDisabledWorkspaces(raw: unknown): string[] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const keys = value.filter((key): key is string => typeof key === "string" && key.trim().length > 0);
  return [...new Set(keys)].slice(0, MAX_DISABLED);
}

export function setZaicodeWorkspaceDisabledIn(
  list: readonly string[],
  workspaceKey: string,
  disabled: boolean,
): string[] {
  const key = workspaceKey.trim();
  if (!key) return [...list];
  const rest = list.filter((entry) => entry !== key);
  return disabled ? [...rest, key].slice(-MAX_DISABLED) : rest;
}

/** Case-insensitive path match (Windows paths differ in drive-letter case between sources). */
export function isZaicodeWorkspaceDisabled(list: readonly string[], workspaceKey: string | null | undefined): boolean {
  if (!workspaceKey) return false;
  const normalize = (key: string) => key.trim().replaceAll("\\", "/").toLowerCase();
  const wanted = normalize(workspaceKey);
  return list.some((entry) => normalize(entry) === wanted);
}
