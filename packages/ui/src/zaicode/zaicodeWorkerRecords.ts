import { applyZaicodePlacementPatch } from "@zcode/shared";
import type { ZaicodeRect } from "./zaicodeWorkerLayout.js";
import type { ZaicodeWorkerPlacement } from "./zaicodeWorkerPrefs.js";

/**
 * Worker records (T-42, SRC-033 analysis 3: topology is not layout). A worker
 * is two records with two write paths:
 *
 * - identity -- who and what runs (engine, project, command, generation,
 *   exit). Frozen; replaced only by `exitWorkerRecord` when the process ends.
 * - place -- where it is shown (panel or own window, minimized, geometry,
 *   stacking) and the panel order. Written only by `placeWorkerRecord`, which
 *   refuses any identity key.
 *
 * `zaicodeWorkers.ts` keeps the panel state and publishes the merged view.
 */

export interface ZaicodeWorkerWindowState extends ZaicodeRect {
  maximized: boolean;
}

/** Who the worker is. Frozen; only its runtime changes it (exit). */
export interface ZaicodeWorkerIdentity {
  /** Also the terminal registry key. */
  readonly id: string;
  readonly kind: "worker" | "fix" | "shell";
  readonly accountId: string | null;
  readonly short: string;
  readonly label: string;
  readonly vendor: string | null;
  readonly projectPath: string;
  readonly projectName: string;
  /** Typed into the shell once it is ready. */
  readonly command: string;
  /** The prompt a subscription worker was started with (kept to start it again after a crash). */
  readonly prompt?: string;
  readonly startedAt: number;
  /** null while running. */
  readonly exitCode: number | null;
  readonly endedAt: number | null;
  /** 1 for the first run of this engine in this project; +1 for each duplicate or restart after a crash. */
  readonly generation: number;
}

/** Where the worker is shown. Layout code owns it; it never says who runs. */
export interface ZaicodeWorkerPlace {
  placement: ZaicodeWorkerPlacement;
  minimized: boolean;
  /** Own-window geometry (kept while docked, so floating again returns it there). */
  window: ZaicodeWorkerWindowState | null;
  /** Stacking order of own windows; higher = in front. */
  z: number;
}

export const ZAICODE_WORKER_PLACE_KEYS: readonly (keyof ZaicodeWorkerPlace)[] = ["placement", "minimized", "window", "z"];

/** What readers see: identity and place merged. */
export type ZaicodeWorker = ZaicodeWorkerIdentity & ZaicodeWorkerPlace;

export type ZaicodeNewWorker = Omit<ZaicodeWorkerIdentity, "generation">;

export interface ZaicodeWorkerRecord {
  readonly identity: ZaicodeWorkerIdentity;
  readonly place: ZaicodeWorkerPlace;
  readonly view: ZaicodeWorker;
}

/** Source of truth, in panel order (order is layout too). */
let records: readonly ZaicodeWorkerRecord[] = [];

export function zaicodeWorkerRecord(identity: ZaicodeWorkerIdentity, place: ZaicodeWorkerPlace): ZaicodeWorkerRecord {
  return { identity, place, view: { ...identity, ...place } };
}

export function readZaicodeWorkerRecords(): readonly ZaicodeWorkerRecord[] {
  return records;
}

/** Replaces the records; returns the merged view the store publishes. */
export function commitZaicodeWorkerRecords(next: readonly ZaicodeWorkerRecord[]): ZaicodeWorker[] {
  records = next;
  return next.map((entry) => entry.view);
}

/** A new frozen identity; its generation counts earlier runs of the same engine in the same project. */
export function newZaicodeWorkerIdentity(fields: ZaicodeNewWorker, generation?: number): ZaicodeWorkerIdentity {
  const path = fields.projectPath.toLowerCase();
  const earlier = records.filter(
    (entry) =>
      entry.identity.kind === fields.kind && entry.identity.accountId === fields.accountId && entry.identity.projectPath.toLowerCase() === path,
  ).length;
  return Object.freeze({ ...fields, generation: generation ?? earlier + 1 });
}

/** The layout write path: placement keys only (an identity key throws). */
export function placeZaicodeWorkerRecord(id: string, patch: Partial<ZaicodeWorkerPlace>): ZaicodeWorker[] {
  return commitZaicodeWorkerRecords(
    records.map((entry) =>
      entry.identity.id === id
        ? zaicodeWorkerRecord(entry.identity, applyZaicodePlacementPatch(entry.place, patch, ZAICODE_WORKER_PLACE_KEYS))
        : entry,
    ),
  );
}

/** The runtime write path: the worker's process reported its exit. */
export function exitZaicodeWorkerRecord(id: string, exitCode: number, endedAt: number): ZaicodeWorker[] {
  return commitZaicodeWorkerRecords(
    records.map((entry) =>
      entry.identity.id === id ? zaicodeWorkerRecord(Object.freeze({ ...entry.identity, exitCode, endedAt }), entry.place) : entry,
    ),
  );
}

/** The frozen identity records (the runtime registry reads these, never the merged view). */
export function readZaicodeWorkerIdentities(): readonly ZaicodeWorkerIdentity[] {
  return records.map((entry) => entry.identity);
}
