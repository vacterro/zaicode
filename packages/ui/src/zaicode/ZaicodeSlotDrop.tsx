import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { closestCenter, pointerWithin, useDroppable, type CollisionDetection } from "@dnd-kit/core";
import { cn } from "@/components/lib/utils.js";
import { ZAICODE_SLOT_GROUPS, isZaicodeSlotGroup, type ZaicodeSlotGroup } from "./zaicodeSidebarPrefs.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";

/**
 * Shift + drag a project and keep holding for two seconds: a SLOTS panel
 * opens over the project list with one target per slot (MAIN0..SIDE3, also
 * the empty, folded or hidden ones). Dropping on a target moves the project
 * into that slot. A plain drag keeps its old meaning (reorder; dropping on a
 * project of another slot moves it there).
 */

export const ZAICODE_SLOT_DROP_PREFIX = "zaicode-slot:";
export const ZAICODE_SLOT_DROP_HOLD_MS = 2000;

export function zaicodeSlotDropId(group: ZaicodeSlotGroup): string {
  return `${ZAICODE_SLOT_DROP_PREFIX}${group}`;
}

/** The slot a drop target id names, or null for an ordinary (project) target. */
export function readZaicodeSlotDropTarget(id: unknown): ZaicodeSlotGroup | null {
  const text = String(id ?? "");
  if (!text.startsWith(ZAICODE_SLOT_DROP_PREFIX)) return null;
  const group = text.slice(ZAICODE_SLOT_DROP_PREFIX.length);
  return isZaicodeSlotGroup(group) ? group : null;
}

/**
 * Armed: the pointer picks a slot target when it is inside one, otherwise the
 * usual nearest project. Not armed: slot targets do not exist for collisions.
 */
export function createZaicodeSlotDropCollision(isArmed: () => boolean): CollisionDetection {
  return (args) => {
    const slotTargets = args.droppableContainers.filter((container) => readZaicodeSlotDropTarget(container.id) !== null);
    if (isArmed() && slotTargets.length > 0) {
      const hits = pointerWithin({ ...args, droppableContainers: slotTargets });
      if (hits.length > 0) return hits;
    }
    return closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter((container) => readZaicodeSlotDropTarget(container.id) === null),
    });
  };
}

/**
 * Tracks the Shift key during one project drag and arms slot drop after the
 * hold time. `dragging` goes true at drag start (with the Shift state of the
 * pointer that started it) and false at drop / cancel.
 */
export function useZaicodeSlotDropArming(dragging: boolean, shiftAtStart: boolean): {
  armed: boolean;
  armedRef: MutableRefObject<boolean>;
} {
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  useEffect(() => {
    armedRef.current = false;
    setArmed(false);
    if (!dragging) return;
    let shift = shiftAtStart;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Shift") shift = event.type === "keydown";
    };
    const onPointer = (event: PointerEvent) => {
      shift = event.shiftKey;
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("pointermove", onPointer, true);
    const timer = window.setTimeout(() => {
      if (!shift) return;
      armedRef.current = true;
      setArmed(true);
      playZaicodeSound("ui.toggle");
    }, ZAICODE_SLOT_DROP_HOLD_MS);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("pointermove", onPointer, true);
    };
  }, [dragging, shiftAtStart]);
  return { armed, armedRef };
}

function SlotTarget({ group, current }: { group: ZaicodeSlotGroup; current: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: zaicodeSlotDropId(group) });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex h-7 items-center justify-center border text-ui-xs tracking-wide",
        isOver
          ? "border-[var(--zaicode-highlight,var(--color-warning))] bg-selected text-foreground"
          : "border-border bg-background text-foreground-subtle",
        current && !isOver && "text-foreground-subtlest",
      )}
      data-zaicode-slot-drop={group}
    >
      {group}
      {current ? " ·now" : ""}
    </div>
  );
}

/** The SLOTS panel shown while slot drop is armed (render inside the project DndContext). */
export function ZaicodeSlotDropPanel({ currentGroup }: { currentGroup: ZaicodeSlotGroup | null }) {
  return (
    <div
      className="sticky top-0 z-20 mx-2 mb-1 border border-[var(--zaicode-highlight,var(--color-border-hover))] bg-surface p-1"
      role="group"
      aria-label="Drop the project into a slot"
      data-zaicode-slot-drop-panel
    >
      <div className="pb-1 text-center text-ui-xs text-foreground-subtle">Drop into slot</div>
      <div className="grid grid-cols-3 gap-1">
        {ZAICODE_SLOT_GROUPS.map((group) => (
          <SlotTarget key={group} group={group} current={group === currentGroup} />
        ))}
      </div>
    </div>
  );
}
