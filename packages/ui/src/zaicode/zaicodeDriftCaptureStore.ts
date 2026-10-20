import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  summarizeProjectTotals,
  type DriftEvidenceState,
  type DriftProjectTotals,
  type DriftReceiptLike,
} from "./zaicodeDriftCaptureContract.js";

export type DriftCaptureMarker = DriftEvidenceState;

export interface DriftCaptureReceipt {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  batchId: string;
  capturedAt: string;
  messages: number;
  characters: number;
  sha256: string;
  watermarkUpdatedAt?: number;
  outputPath: string;
  metadataPath?: string;
  fileSize?: number;
  /** Filesystem reconciliation result; absent on receipts written before T-393. */
  verification?: DriftEvidenceState;
  verifiedAt?: string;
  captureFailed?: boolean;
  lastError?: string;
  /**
   * The session left the active list. The capture itself is untouched: the
   * evidence stays on disk and the receipt stays in the store, so a later
   * review pack still covers the archived session.
   */
  retired?: boolean;
}

export interface DriftActiveBatch {
  batchId: string;
  ownerId: string;
  vaultRoot: string;
  startedAt: string;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  status: "CAPTURING" | "VERIFYING" | "COMMITTED" | "FAILED";
  leaseExpiresAt: number;
}

export interface DriftCaptureSettings {
  enabled: boolean;
  storageRoot: string;
  includeHistorical: boolean;
  includeHelperSessions: boolean;
  includeDisabledProjects: boolean;
  includeProtocolContext: boolean;
  captureAttachmentsByReference: boolean;
  exportBinaryAttachments: boolean;
  skipUnchanged: boolean;
  forceRecapture: boolean;
  concurrency: number;
  maxStorageWarningBytes: number;
  exportBundleFormat: "folder" | "zip";
  exportSplitPartBytes: number;
  notifyOnComplete: boolean;
  confirmDeleteEvidence: boolean;
}

const DEFAULT_SETTINGS: DriftCaptureSettings = {
  enabled: true,
  storageRoot: "",
  includeHistorical: true,
  includeHelperSessions: true,
  includeDisabledProjects: true,
  includeProtocolContext: true,
  captureAttachmentsByReference: true,
  exportBinaryAttachments: false,
  skipUnchanged: true,
  forceRecapture: false,
  concurrency: 3,
  maxStorageWarningBytes: 5 * 1024 * 1024 * 1024,
  exportBundleFormat: "folder",
  exportSplitPartBytes: 512 * 1024 * 1024,
  notifyOnComplete: true,
  confirmDeleteEvidence: true,
};

export function driftReceiptKey(
  sessionId: string,
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  return `${workspaceIdentity ?? ""}::${workspacePath.toLowerCase()}::${sessionId}`;
}

interface State {
  settings: DriftCaptureSettings;
  receipts: Record<string, DriftCaptureReceipt>;
  capturingSessionIds: string[];
  activeBatch: DriftActiveBatch | null;
  lastBatchId: string | null;
  lastCaptureAt: string | null;
  updateSettings: (patch: Partial<DriftCaptureSettings>) => void;
  markCapturing: (sessionId: string) => void;
  clearCapturing: (sessionId: string) => void;
  recordReceipt: (receipt: DriftCaptureReceipt) => void;
  recordCaptureFailure: (input: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    batchId: string;
    error: string;
    outputPath?: string;
  }) => void;
  recordVerification: (
    sessionId: string,
    workspacePath: string,
    workspaceIdentity: string | undefined,
    verification: DriftEvidenceState,
    details?: { fileSize?: number; verifiedAt?: string },
  ) => void;
  removeReceipt: (sessionId: string, workspacePath: string, workspaceIdentity?: string) => void;
  /**
   * Retire the live marker of a session that left the active list.
   *
   * The receipt and the evidence on disk are kept: the archive stays reviewable
   * and still shows up in the project totals. A failed retirement must not
   * call this, or the operator loses the pointer to evidence that exists.
   */
  retireMarker: (sessionId: string, workspacePath: string, workspaceIdentity?: string) => void;
  /** Bring a retired session back into the active list with its marker intact. */
  restoreMarker: (sessionId: string, workspacePath: string, workspaceIdentity?: string) => void;
  getReceipt: (
    sessionId: string,
    workspacePath: string,
    workspaceIdentity?: string,
  ) => DriftCaptureReceipt | undefined;
  markerFor: (
    sessionId: string,
    workspacePath: string,
    workspaceIdentity: string | undefined,
    sessionUpdatedAt?: number,
  ) => DriftCaptureMarker;
  setActiveBatch: (batch: DriftActiveBatch) => void;
  updateActiveBatch: (batchId: string, patch: Partial<DriftActiveBatch>) => void;
  clearActiveBatch: (batchId: string) => void;
  listProjectTotals: () => DriftProjectTotals[];
}

function normalizeReceipt(receipt: DriftCaptureReceipt): DriftCaptureReceipt {
  // Older builds stored "saved" without ever stat-ing the file. Mark those
  // unverified instead of pretending they are intact.
  return receipt.verification ? receipt : { ...receipt, verification: "UNVERIFIED" };
}

export const useDriftCaptureStore = create<State>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      receipts: {},
      capturingSessionIds: [],
      activeBatch: null,
      lastBatchId: null,
      lastCaptureAt: null,
      updateSettings: (patch) => set((state) => ({ settings: { ...state.settings, ...patch } })),
      markCapturing: (sessionId) =>
        set((state) => ({
          capturingSessionIds: state.capturingSessionIds.includes(sessionId)
            ? state.capturingSessionIds
            : [...state.capturingSessionIds, sessionId],
        })),
      clearCapturing: (sessionId) =>
        set((state) => ({
          capturingSessionIds: state.capturingSessionIds.filter((id) => id !== sessionId),
        })),
      recordReceipt: (receipt) =>
        set((state) => ({
          receipts: {
            ...state.receipts,
            [driftReceiptKey(receipt.sessionId, receipt.workspacePath, receipt.workspaceIdentity)]:
              normalizeReceipt(receipt),
          },
          lastBatchId: receipt.batchId,
          lastCaptureAt: receipt.capturedAt,
        })),
      recordCaptureFailure: (input) =>
        set((state) => {
          const key = driftReceiptKey(input.sessionId, input.workspacePath, input.workspaceIdentity);
          const previous = state.receipts[key];
          return {
            receipts: {
              ...state.receipts,
              [key]: {
                ...(previous ?? {
                  sessionId: input.sessionId,
                  workspacePath: input.workspacePath,
                  workspaceIdentity: input.workspaceIdentity,
                  batchId: input.batchId,
                  capturedAt: new Date().toISOString(),
                  messages: 0,
                  characters: 0,
                  sha256: "",
                  outputPath: input.outputPath ?? "",
                }),
                batchId: input.batchId,
                captureFailed: true,
                lastError: input.error,
              },
            },
            lastBatchId: input.batchId,
          };
        }),
      recordVerification: (sessionId, workspacePath, workspaceIdentity, verification, details) =>
        set((state) => {
          const key = driftReceiptKey(sessionId, workspacePath, workspaceIdentity);
          const receipt = state.receipts[key];
          if (!receipt) return state;
          return {
            receipts: {
              ...state.receipts,
              [key]: {
                ...receipt,
                verification,
                captureFailed: verification === "CAPTURE_FAILED",
                verifiedAt: details?.verifiedAt ?? new Date().toISOString(),
                fileSize: details?.fileSize ?? receipt.fileSize,
              },
            },
          };
        }),
      removeReceipt: (sessionId, workspacePath, workspaceIdentity) =>
        set((state) => {
          const next = { ...state.receipts };
          delete next[driftReceiptKey(sessionId, workspacePath, workspaceIdentity)];
          return { receipts: next };
        }),
      retireMarker: (sessionId, workspacePath, workspaceIdentity) =>
        set((state) => {
          const key = driftReceiptKey(sessionId, workspacePath, workspaceIdentity);
          const receipt = state.receipts[key];
          if (!receipt || receipt.retired) return state;
          return {
            receipts: { ...state.receipts, [key]: { ...receipt, retired: true } },
          };
        }),
      restoreMarker: (sessionId, workspacePath, workspaceIdentity) =>
        set((state) => {
          const key = driftReceiptKey(sessionId, workspacePath, workspaceIdentity);
          const receipt = state.receipts[key];
          if (!receipt?.retired) return state;
          return {
            receipts: { ...state.receipts, [key]: { ...receipt, retired: false } },
          };
        }),
      getReceipt: (sessionId, workspacePath, workspaceIdentity) =>
        get().receipts[driftReceiptKey(sessionId, workspacePath, workspaceIdentity)],
      markerFor: (sessionId, workspacePath, workspaceIdentity, sessionUpdatedAt) => {
        if (get().capturingSessionIds.includes(sessionId)) return "CAPTURING";
        const receipt = get().receipts[driftReceiptKey(sessionId, workspacePath, workspaceIdentity)];
        if (!receipt) return "NOT_CAPTURED";
        // A retired session left the active list: its live marker is gone, but
        // the receipt and the evidence stay, so the archive remains reviewable.
        if (receipt.retired) return "NOT_CAPTURED";
        if (receipt.captureFailed) return "CAPTURE_FAILED";
        if (receipt.verification === "UNVERIFIED" || !receipt.verification) return "UNVERIFIED";
        if (receipt.verification === "FILE_MISSING" || receipt.verification === "INTEGRITY_FAILED")
          return receipt.verification;
        if (
          sessionUpdatedAt !== undefined &&
          receipt.watermarkUpdatedAt !== undefined &&
          sessionUpdatedAt > receipt.watermarkUpdatedAt
        )
          return "SAVED_WITH_NEW_ACTIVITY";
        return receipt.verification;
      },
      setActiveBatch: (batch) => set({ activeBatch: batch }),
      updateActiveBatch: (batchId, patch) =>
        set((state) => {
          if (!state.activeBatch || state.activeBatch.batchId !== batchId) return state;
          return { activeBatch: { ...state.activeBatch, ...patch } };
        }),
      clearActiveBatch: (batchId) =>
        set((state) =>
          state.activeBatch?.batchId === batchId ? { activeBatch: null } : state,
        ),
      listProjectTotals: () =>
        summarizeProjectTotals(Object.values(get().receipts) as DriftReceiptLike[]),
    }),
    {
      name: "zaicode-drift-capture",
      version: 2,
      migrate: (persisted) => {
        const state = persisted as Partial<State> | undefined;
        if (!state?.receipts) return persisted as State;
        const receipts: Record<string, DriftCaptureReceipt> = {};
        for (const [key, receipt] of Object.entries(state.receipts)) {
          receipts[key] = normalizeReceipt(receipt);
        }
        return { ...state, receipts } as State;
      },
    },
  ),
);

/** Pure selector helper for components that already subscribe to receipts. */
export function computeDriftProjectTotals(
  receipts: Record<string, DriftCaptureReceipt>,
): DriftProjectTotals[] {
  return summarizeProjectTotals(Object.values(receipts) as DriftReceiptLike[]);
}
