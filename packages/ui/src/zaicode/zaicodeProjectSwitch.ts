import { create } from "zustand";
import {
  isZaicodeWorkspaceDisabled,
  normalizeZaicodeDisabledWorkspaces,
  setZaicodeWorkspaceDisabledIn,
} from "@zcode/shared";
import type { ZaicodeServices } from "./zaicodeServices.js";

/**
 * Project on / off (Shift+Click on a project in the sidebar). The queue
 * service owns the list (`zaicode_settings.disabled_workspaces`) because the
 * host dispatches jobs without the renderer; this store mirrors it so rows,
 * the Scheduler and SAIHOME can read it synchronously. A local copy makes the
 * dimmed rows appear before the service answers after a restart.
 */

const CACHE_KEY = "zaicode-disabled-projects-v1";

function readCache(): string[] {
  try {
    return normalizeZaicodeDisabledWorkspaces(localStorage.getItem(CACHE_KEY));
  } catch {
    return [];
  }
}

function writeCache(keys: readonly string[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(keys));
  } catch {
    // the service still has it
  }
}

interface ZaicodeProjectSwitchState {
  keys: string[];
}

export const useZaicodeDisabledProjects = create<ZaicodeProjectSwitchState>(() => ({ keys: readCache() }));

let services: ZaicodeServices | null = null;

function publish(keys: string[]): void {
  useZaicodeDisabledProjects.setState({ keys });
  writeCache(keys);
}

/** Adopts the service's list (called when the queue services become available). */
export function syncZaicodeDisabledProjects(next: ZaicodeServices | null): void {
  services = next;
  if (!next) return;
  void next.jobs
    .getDisabledWorkspaces()
    .then((keys) => publish(normalizeZaicodeDisabledWorkspaces(keys)))
    .catch(() => undefined);
}

export function isZaicodeProjectDisabled(workspaceKey: string | null | undefined): boolean {
  return isZaicodeWorkspaceDisabled(useZaicodeDisabledProjects.getState().keys, workspaceKey);
}

export function useZaicodeProjectDisabled(workspaceKey: string | null | undefined): boolean {
  return useZaicodeDisabledProjects((state) => isZaicodeWorkspaceDisabled(state.keys, workspaceKey));
}

/** Flips one project; the row changes at once, the service confirms (or the old list comes back). */
export async function setZaicodeProjectDisabled(workspaceKey: string, disabled: boolean): Promise<void> {
  const before = useZaicodeDisabledProjects.getState().keys;
  publish(setZaicodeWorkspaceDisabledIn(before, workspaceKey, disabled));
  if (!services) return;
  try {
    publish(normalizeZaicodeDisabledWorkspaces(await services.jobs.setWorkspaceDisabled(workspaceKey, disabled)));
  } catch {
    publish(before);
  }
}

export function toggleZaicodeProjectDisabled(workspaceKey: string): Promise<void> {
  return setZaicodeProjectDisabled(workspaceKey, !isZaicodeProjectDisabled(workspaceKey));
}
