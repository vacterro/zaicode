import { useEffect } from "react";
import { create } from "zustand";
import type { ZaicodeUpdateComponent, ZaicodeUpdateComponentId, ZaicodeUpdatesState } from "@zcode/shared";
import { playZaicodeSound } from "./zaicodeSoundBus.js";

/**
 * T-134: the renderer's view of ZAICODE updates (the workspace, the app,
 * SAIPEN and SAIMAIL, each on its own). The desktop main process does the
 * work (zaicodeUpdatesHost.ts runs install\Update-ZAICODE.ps1); this keeps
 * its state, forwards the buttons and gives the moments a voice: something
 * new on GitHub, a part updated, an update that stopped.
 */

interface UpdatesBridge {
  getZaicodeUpdates?(): Promise<ZaicodeUpdatesState>;
  checkZaicodeUpdates?(): Promise<ZaicodeUpdatesState>;
  applyZaicodeUpdates?(components: ZaicodeUpdateComponentId[]): Promise<ZaicodeUpdatesState>;
  setZaicodeUpdateAuto?(component: ZaicodeUpdateComponentId, enabled: boolean): Promise<ZaicodeUpdatesState>;
  onZaicodeUpdatesChanged?(callback: (state: ZaicodeUpdatesState) => void): () => void;
}

function bridge(): UpdatesBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const value = (window as unknown as { zcode?: UpdatesBridge }).zcode;
  return value?.getZaicodeUpdates ? value : undefined;
}

export function zaicodeUpdatesAvailable(): boolean {
  return Boolean(bridge());
}

interface ZaicodeUpdatesStore {
  state: ZaicodeUpdatesState | null;
  error: string | null;
  set: (state: ZaicodeUpdatesState) => void;
}

export const useZaicodeUpdates = create<ZaicodeUpdatesStore>((set) => ({
  state: null,
  error: null,
  set: (state) => set({ state, error: null }),
}));

/** Which sound a new state deserves against the previous one (pure; null = none). */
export function zaicodeUpdateCue(
  previous: readonly ZaicodeUpdateComponent[],
  next: readonly ZaicodeUpdateComponent[],
): "update.failed" | "update.applied" | "update.available" | null {
  const before = new Map(previous.map((entry) => [entry.id, entry]));
  const changed = next.filter((entry) => {
    const old = before.get(entry.id);
    return !old || old.status !== entry.status || old.remote !== entry.remote;
  });
  if (changed.some((entry) => entry.status === "failed")) return "update.failed";
  if (changed.some((entry) => entry.status === "updated")) return "update.applied";
  if (changed.some((entry) => entry.status === "available")) return "update.available";
  return null;
}

function accept(next: ZaicodeUpdatesState): void {
  const previous = useZaicodeUpdates.getState().state;
  // The first answer after the start only fills the view: a part that was already waiting is no news.
  if (previous && !next.busy) {
    const cue = zaicodeUpdateCue(previous.components, next.components);
    if (cue) playZaicodeSound(cue);
  }
  useZaicodeUpdates.getState().set(next);
}

async function run(call: (value: UpdatesBridge) => Promise<ZaicodeUpdatesState> | undefined): Promise<void> {
  const value = bridge();
  if (!value) return;
  try {
    const next = await call(value);
    if (next) accept(next);
  } catch (error) {
    useZaicodeUpdates.setState({ error: error instanceof Error ? error.message : String(error) });
  }
}

export const checkZaicodeUpdates = () => run((value) => value.checkZaicodeUpdates?.());
export const applyZaicodeUpdates = (components: ZaicodeUpdateComponentId[]) => run((value) => value.applyZaicodeUpdates?.(components));
export const setZaicodeUpdateAuto = (component: ZaicodeUpdateComponentId, enabled: boolean) =>
  run((value) => value.setZaicodeUpdateAuto?.(component, enabled));

let subscribed = false;

/** Mount once (ZAICODE runtime): the first state, then every change the main process reports. */
export function useZaicodeUpdatesBridge(): void {
  useEffect(() => {
    const value = bridge();
    if (!value || subscribed) return;
    subscribed = true;
    void run((current) => current.getZaicodeUpdates?.());
    const stop = value.onZaicodeUpdatesChanged?.((state) => accept(state));
    return () => {
      stop?.();
      subscribed = false;
    };
  }, []);
}
