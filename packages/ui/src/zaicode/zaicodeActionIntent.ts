import { create } from "zustand";
import type { ZaicodeModeAction } from "./zaicodeMainSession.js";

export type ActionIntentState =
  | "CREATED"
  | "ADMISSION_PENDING"
  | "ACCEPTED"
  | "QUEUED"
  | "DISPATCHED"
  | "RUNNING"
  | "COMPLETED"
  | "REJECTED"
  | "CANCELLED"
  | "UNKNOWN_OUTCOME";

export type ActionIntentDestination = "main" | "helper";

export interface ActionIntent {
  id: string;
  workspacePath: string;
  workspaceIdentity?: string;
  targetSessionId: string | null;
  destination: ActionIntentDestination;
  action: ZaicodeModeAction;
  command: string;
  generation: number;
  state: ActionIntentState;
  rejectionReason?: string;
  queuePosition?: number | null;
  createdAt: number;
  updatedAt: number;
}

let intentSequence = 0;

export function generateActionIntentId(): string {
  intentSequence += 1;
  return `action-intent-${Date.now()}-${intentSequence}`;
}

export function formatIntentFeedback(intent: ActionIntent): string {
  const label =
    intent.action?.role ??
    intent.action?.command?.toUpperCase() ??
    intent.command?.toUpperCase() ??
    "WORK";
  switch (intent.state) {
    case "CREATED":
    case "ADMISSION_PENDING":
      if (intent.destination === "helper") {
        return `SAI${label} helper starting...`;
      }
      return `Queuing ${label}...`;
    case "ACCEPTED":
    case "QUEUED":
      if (intent.queuePosition !== undefined && intent.queuePosition !== null) {
        return `${label} queued on MAIN (#${intent.queuePosition})`;
      }
      return `${label} queued on MAIN`;
    case "DISPATCHED":
    case "RUNNING":
      if (intent.destination === "helper") {
        return `SAI${label} running`;
      }
      return `${label} running`;
    case "COMPLETED":
      return `${label} completed`;
    case "REJECTED":
      return `${label} rejected${intent.rejectionReason ? `: ${intent.rejectionReason}` : ""}`;
    case "CANCELLED":
      return `${label} cancelled`;
    case "UNKNOWN_OUTCOME":
      return `${label} outcome unconfirmed`;
    default:
      return label;
  }
}

interface ActionIntentStoreState {
  intents: Record<string, ActionIntent>;
  activeIntentIds: string[];
  helperQueue: string[];
  currentHelperIntentId: string | null;
  generation: number;

  createIntent: (input: {
    workspacePath: string;
    workspaceIdentity?: string;
    targetSessionId?: string | null;
    destination: ActionIntentDestination;
    action: ZaicodeModeAction;
    command: string;
  }) => ActionIntent;

  updateIntent: (id: string, patch: Partial<ActionIntent>) => void;
  transitionState: (
    id: string,
    state: ActionIntentState,
    extra?: Partial<ActionIntent>,
  ) => ActionIntent | null;

  peekHelperQueue: () => ActionIntent | null;
  advanceHelperQueue: (completedIntentId?: string) => ActionIntent | null;
  clearHelperQueue: () => void;
  findActiveBySession: (sessionId: string) => ActionIntent[];
  reset: () => void;
}

export const useZaicodeActionIntents = create<ActionIntentStoreState>((set, get) => ({
  intents: {},
  activeIntentIds: [],
  helperQueue: [],
  currentHelperIntentId: null,
  generation: 1,

  createIntent: ({
    workspacePath,
    workspaceIdentity,
    targetSessionId = null,
    destination,
    action,
    command,
  }) => {
    const id = generateActionIntentId();
    const now = Date.now();
    const generation = get().generation;
    const intent: ActionIntent = {
      id,
      workspacePath,
      workspaceIdentity,
      targetSessionId,
      destination,
      action,
      command,
      generation,
      state: "CREATED",
      createdAt: now,
      updatedAt: now,
    };

    set((state) => ({
      intents: { ...state.intents, [id]: intent },
      activeIntentIds: [...state.activeIntentIds, id],
      helperQueue: destination === "helper" ? [...state.helperQueue, id] : state.helperQueue,
      currentHelperIntentId:
        destination === "helper" && !state.currentHelperIntentId
          ? id
          : state.currentHelperIntentId,
      generation: state.generation + 1,
    }));

    return intent;
  },

  updateIntent: (id, patch) => {
    set((state) => {
      const existing = state.intents[id];
      if (!existing) return state;
      const updated: ActionIntent = {
        ...existing,
        ...patch,
        updatedAt: Date.now(),
      };
      return {
        intents: { ...state.intents, [id]: updated },
      };
    });
  },

  transitionState: (id, nextState, extra) => {
    const existing = get().intents[id];
    if (!existing) return null;
    const now = Date.now();
    const updated: ActionIntent = {
      ...existing,
      ...extra,
      state: nextState,
      updatedAt: now,
    };

    const isTerminal =
      nextState === "COMPLETED" || nextState === "REJECTED" || nextState === "CANCELLED";

    set((state) => ({
      intents: { ...state.intents, [id]: updated },
      activeIntentIds: isTerminal
        ? state.activeIntentIds.filter((item) => item !== id)
        : state.activeIntentIds,
    }));

    return updated;
  },

  peekHelperQueue: () => {
    const state = get();
    const currentId = state.currentHelperIntentId ?? state.helperQueue[0];
    if (!currentId) return null;
    return state.intents[currentId] ?? null;
  },

  advanceHelperQueue: (completedIntentId) => {
    const state = get();
    const targetId = completedIntentId ?? state.currentHelperIntentId ?? state.helperQueue[0];
    if (!targetId) return null;

    const remainingQueue = state.helperQueue.filter((id) => id !== targetId);
    const nextId = remainingQueue[0] ?? null;

    set({
      helperQueue: remainingQueue,
      currentHelperIntentId: nextId,
    });

    return nextId ? state.intents[nextId] ?? null : null;
  },

  clearHelperQueue: () => {
    set({
      helperQueue: [],
      currentHelperIntentId: null,
    });
  },

  findActiveBySession: (sessionId) => {
    const state = get();
    return state.activeIntentIds
      .map((id) => state.intents[id])
      .filter((intent): intent is ActionIntent => intent?.targetSessionId === sessionId);
  },

  reset: () => {
    set({
      intents: {},
      activeIntentIds: [],
      helperQueue: [],
      currentHelperIntentId: null,
      generation: 1,
    });
  },
}));
