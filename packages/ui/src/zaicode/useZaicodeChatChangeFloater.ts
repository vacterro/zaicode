import { useCallback, useEffect, useRef } from "react";
import { isZaicodeProductMode } from "@zcode/shared";
import {
  admitZaicodeChatBurst,
  useZaicodeChangeFloaters,
  zaicodeChangeDelta,
  zaicodeFloatersFor,
  type ZaicodeChangeCounts,
} from "./zaicodeChangeFloaters.js";
import { flashZaicodeChange, launchZaicodeFloaters, zaicodeChatLook } from "./zaicodeFloaterLayer.js";

/**
 * RPG change numbers inside the chat (SRC-062): "the agent changes files, it
 * lights up and plays". Every Edit row of an agent turn launches its own +N /
 * -N over its "+N -M" when the file changes, on the shared floater layer.
 *
 * Only a real change plays:
 * - an edit is live when it is still running, or when it entered the stream
 *   (`startedAt`) no longer ago than the operator's freshness window; an old
 *   chat opened later, or a row scrolled back into view, is silent;
 * - what an Edit row already played is remembered by tool id, so a row the
 *   virtual list unmounts and mounts again never plays twice.
 *
 * Several edits that land together play one after another (the stagger), in
 * the order they landed; a burst with both plays in the operator's order.
 */

const played = new Map<string, ZaicodeChangeCounts>();
const PLAYED_KEEP = 800;

function remember(toolId: string, counts: ZaicodeChangeCounts): void {
  played.delete(toolId);
  played.set(toolId, counts);
  if (played.size > PLAYED_KEEP) played.delete(played.keys().next().value!);
}

interface QueuedBurst {
  element: () => HTMLElement | null;
  heal: number;
  damage: number;
  editedAt: number | null;
}

const queue: QueuedBurst[] = [];
let draining = false;

function visibleOnScreen(element: HTMLElement | null): boolean {
  if (!element || !element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const view = element.ownerDocument.defaultView;
  const height = view?.innerHeight ?? 0;
  const width = view?.innerWidth ?? 0;
  return rect.bottom > 0 && rect.top < height && rect.right > 0 && rect.left < width;
}

function drain(): void {
  const next = queue.shift();
  if (!next) {
    draining = false;
    return;
  }
  draining = true;
  const prefs = useZaicodeChangeFloaters.getState();
  const element = next.element();
  const admitted = admitZaicodeChatBurst(next, prefs, {
    now: Date.now(),
    visible: visibleOnScreen(element),
    focused: typeof document === "undefined" ? true : document.hasFocus(),
  });
  const floaters = admitted ? zaicodeFloatersFor(next, prefs) : [];
  if (floaters.length === 0) {
    drain();
    return;
  }
  const lastStart = launchZaicodeFloaters(
    () => next.element()?.getBoundingClientRect() ?? null,
    floaters,
    prefs,
    zaicodeChatLook(prefs),
    {
      sound: prefs.chatSound,
      onStart: () => {
        if (prefs.chatFlashRow) flashZaicodeChange(next.element(), prefs.ignoreReducedMotion);
      },
    },
  );
  setTimeout(drain, lastStart + prefs.chatStaggerMs);
}

function enqueue(burst: QueuedBurst): void {
  const prefs = useZaicodeChangeFloaters.getState();
  queue.push(burst);
  while (queue.length > prefs.chatQueueMax) queue.shift();
  if (!draining) {
    draining = true;
    setTimeout(drain, prefs.chatDelayMs);
  }
}

export interface ZaicodeChatEditState {
  /** The edit is still running. */
  running: boolean;
  /** When the edit entered the stream (local ms), when known. */
  startedAt?: number;
}

/**
 * Tracks one Edit row's counts; returns the ref for the element that shows
 * "+N -M" (the numbers rise from it).
 */
export function useZaicodeChatChangeFloater(
  toolId: string,
  counts: ZaicodeChangeCounts,
  edit: ZaicodeChatEditState,
): (node: HTMLElement | null) => void {
  const element = useRef<HTMLElement | null>(null);
  const pending = useRef({ heal: 0, damage: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { added, removed } = counts;
  const { running, startedAt } = edit;

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    if (!isZaicodeProductMode() || !toolId) return;
    const prefs = useZaicodeChangeFloaters.getState();
    const now = Date.now();
    const fresh = running || (typeof startedAt === "number" && now - startedAt <= prefs.chatFreshSec * 1000);
    const before = played.get(toolId) ?? (fresh ? { added: 0, removed: 0 } : null);
    remember(toolId, { added, removed });
    // A row first seen stale (history, a reopened chat) only sets its baseline.
    if (!before) return;
    const delta = zaicodeChangeDelta(before, { added, removed });
    if (delta.heal === 0 && delta.damage === 0) return;
    pending.current = { heal: pending.current.heal + delta.heal, damage: pending.current.damage + delta.damage };
    if (timer.current) return;
    const flush = () => {
      timer.current = null;
      const burst = pending.current;
      pending.current = { heal: 0, damage: 0 };
      enqueue({ element: () => element.current, ...burst, editedAt: Date.now() });
    };
    // Counts that stream in pieces add up to one burst, like the Changes counter.
    if (prefs.mergeMs === 0) flush();
    else timer.current = setTimeout(flush, prefs.mergeMs);
  }, [toolId, added, removed, running, startedAt]);

  return useCallback((node: HTMLElement | null) => {
    element.current = node;
  }, []);
}

/** Test seam: forget what was played. */
export function resetZaicodeChatFloatersForTest(): void {
  played.clear();
  queue.length = 0;
  draining = false;
}
