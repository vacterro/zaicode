import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PlanState } from "@zcode/shared/zcode-protocol-v4";
import type { ZaicodeJob } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { toggleZaicodeTodoDock } from "./ZaicodeTodoDock.js";
import { useZaicodeSaipen } from "@/zaicode/zaicodeSaipen.js";
import {
  ZAICODE_TODO_CELL_CLASS,
  ZAICODE_TODO_STATUS_LABEL,
  useZaicodeTodoProgress,
  type ZaicodeTodoItem,
} from "@/zaicode/zaicodeTodoProgress.js";
import { playZaicodeSound } from "@/zaicode/zaicodeSoundBus.js";

type PlanItem = PlanState["items"][number];

interface HoverState {
  index: number;
  rect: DOMRect;
}

/**
 * Evenly sized todo cells with an instant, palette-styled tooltip (no delay,
 * no native title). The tooltip is portalled so sidebars/overflow never clip it.
 */
export function ZaicodeTodoCells({
  items,
  className,
  cellClassName,
}: {
  items: readonly ZaicodeTodoItem[];
  className?: string;
  cellClassName?: string;
}) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const done = items.filter((item) => item.status === "completed").length;
  const hovered = hover ? items[hover.index] : undefined;

  return (
    <>
      <ol className={cn("flex min-w-0 gap-px", className)} onMouseLeave={() => setHover(null)}>
        {items.map((item, index) => (
          <li
            key={index}
            onMouseEnter={(event) =>
              setHover({ index, rect: event.currentTarget.getBoundingClientRect() })
            }
            className={cn(
              "min-w-0 flex-1 border",
              ZAICODE_TODO_CELL_CLASS[item.status],
              hover?.index === index &&
                "outline outline-1 outline-[var(--zaicode-highlight,var(--color-foreground))]",
              cellClassName,
            )}
          />
        ))}
      </ol>
      {hover && hovered
        ? createPortal(
            <div
              role="tooltip"
              className="pointer-events-none fixed z-[200] max-w-80 border border-[var(--zaicode-highlight,var(--color-border))] bg-tooltip px-2 py-1.5 text-ui-xs text-tooltip-foreground shadow-md"
              style={{
                left: Math.max(
                  8,
                  Math.min(hover.rect.left + hover.rect.width / 2 - 160, window.innerWidth - 328),
                ),
                bottom: window.innerHeight - hover.rect.top + 6,
              }}
            >
              <div className="mb-0.5 flex items-center gap-2 tabular-nums">
                <span
                  className={cn(
                    "inline-block size-2 border",
                    ZAICODE_TODO_CELL_CLASS[hovered.status],
                  )}
                />
                <strong className="font-normal">
                  {hover.index + 1}/{items.length} · {ZAICODE_TODO_STATUS_LABEL[hovered.status]}
                </strong>
                <span className="ml-auto text-tooltip-tag-foreground">
                  {done}/{items.length} done
                </span>
              </div>
              <div className="whitespace-pre-wrap break-words">{hovered.content}</div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * ZAICODE todo gauge above the composer: one block per TodoWrite item across
 * the chat column width. Also publishes the items so the sidebar row mirrors it.
 */
export function ZaicodeTodoGauge({
  items,
  sessionId,
}: {
  items: readonly PlanItem[];
  sessionId?: string | null;
}) {
  const publish = useZaicodeTodoProgress((state) => state.publish);
  useEffect(() => {
    if (sessionId) publish(sessionId, items);
  }, [publish, sessionId, items]);

  const anchorRef = useRef<HTMLDivElement | null>(null);
  const doneCount = items.filter((item) => item.status === "completed").length;
  const lastDoneRef = useRef<{ sessionId: string | null | undefined; done: number } | null>(null);
  useEffect(() => {
    const last = lastDoneRef.current;
    if (last && last.sessionId === sessionId && doneCount > last.done) playZaicodeSound("todo.tick");
    lastDoneRef.current = { sessionId, done: doneCount };
  }, [doneCount, sessionId]);
  if (items.length === 0) return null;
  const done = doneCount;

  return (
    <div
      ref={anchorRef}
      className="relative z-10 mb-1.5 flex w-full min-w-0 shrink-0 items-center gap-2 bg-background text-ui-xs"
      data-zaicode-todo-gauge
    >
      <ZaicodeTodoColumn items={items} anchorRef={anchorRef} />
      <div
        className="min-w-0 flex-1"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={items.length}
        aria-valuenow={done}
        aria-label={`Todo ${done}/${items.length}`}
      >
        <ZaicodeTodoCells items={items} className="h-2.5" />
      </div>
      <button
        type="button"
        className="shrink-0 whitespace-nowrap border border-border bg-card px-1 tabular-nums text-foreground-subtle hover:text-foreground focus-visible:text-foreground"
        aria-label={`Open todo board: ${done}/${items.length} done`}
        title="Show / hide the todo list"
        onClick={toggleZaicodeTodoDock}
      >
        <strong className="font-normal text-foreground">{done}</strong>/{items.length}
      </button>
    </div>
  );
}

/**
 * Thin mirror of a session's todo gauge for sidebar rows. `liveItems` comes
 * from the sessions-index summary (authoritative, live for background
 * sessions); the persisted store is only a fallback until it arrives.
 */
export function ZaicodeTodoMiniGauge({
  sessionId,
  liveItems,
}: {
  sessionId: string;
  liveItems?: readonly ZaicodeTodoItem[];
}) {
  const stored = useZaicodeTodoProgress((state) => state.bySession[sessionId]);
  const publish = useZaicodeTodoProgress((state) => state.publish);
  useEffect(() => {
    if (liveItems) publish(sessionId, liveItems);
  }, [liveItems, publish, sessionId]);
  const items = liveItems ?? stored;
  if (!items || items.length === 0) return null;
  return (
    <ZaicodeTodoCells
      items={items}
      className="pointer-events-auto h-[3px] w-full"
      cellClassName="border-0"
    />
  );
}

/**
 * Dynamic todometer displayed directly above the queue in ZAICODE workspace.
 * Resolves todo items from the selected job, active running job, recent sessions,
 * or SAIPEN board tickets, ensuring the todometer remains permanently visible.
 */
export function ZaicodeQueueTodometer({
  jobs,
  selectedJobId,
  workspacePath,
}: {
  jobs: readonly ZaicodeJob[];
  selectedJobId: string | null;
  workspacePath?: string;
}) {
  const bySession = useZaicodeTodoProgress((state) => state.bySession);
  const saipen = useZaicodeSaipen(workspacePath ?? "");

  let items: readonly ZaicodeTodoItem[] = [];

  // 1. Try selected job session
  if (selectedJobId) {
    const selectedJob = jobs.find((j) => j.id === selectedJobId);
    if (selectedJob?.sessionId && bySession[selectedJob.sessionId]?.length) {
      items = bySession[selectedJob.sessionId]!;
    }
  }

  // 2. Try active / running job
  if (items.length === 0) {
    const runningJob = jobs.find(
      (j) => (j.status === "running" || j.status === "waiting") && j.sessionId && bySession[j.sessionId]?.length,
    );
    if (runningJob?.sessionId && bySession[runningJob.sessionId]?.length) {
      items = bySession[runningJob.sessionId]!;
    }
  }

  // 3. Try any recent session with items
  if (items.length === 0) {
    const sessionWithItems = Object.entries(bySession).reverse().find(([_, sessionTodos]) => sessionTodos.length > 0);
    if (sessionWithItems) {
      items = sessionWithItems[1];
    }
  }

  // 4. Try SAIPEN tickets projection
  if (items.length === 0 && saipen && saipen.counts) {
    const totalSaipen = saipen.counts.done + saipen.counts.doing + saipen.counts.todo;
    if (totalSaipen > 0) {
      const synthetic: ZaicodeTodoItem[] = [];
      for (let i = 0; i < saipen.counts.done; i++) {
        synthetic.push({
          status: "completed",
          content: `Completed SAIPEN ticket (${i + 1}/${saipen.counts.done})`,
        });
      }
      if (saipen.counts.doing > 0) {
        synthetic.push({
          status: "inProgress",
          content: saipen.doing ? `${saipen.doing.id}: ${saipen.doing.title}` : (saipen.task ? `${saipen.task}: active` : "In progress ticket"),
        });
      }
      for (let i = 0; i < saipen.counts.todo; i++) {
        synthetic.push({
          status: "pending",
          content: i === 0 && saipen.nextTicket ? `${saipen.nextTicket.id}: ${saipen.nextTicket.title}` : `Queued ticket (${i + 1})`,
        });
      }
      items = synthetic;
    }
  }

  const done = items.filter((item) => item.status === "completed").length;

  return (
    <div
      className="relative z-10 flex w-full min-w-0 shrink-0 items-center justify-between gap-3 border-b border-border bg-card/60 px-3 py-1.5 text-ui-xs"
      data-zaicode-queue-todometer
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 font-medium uppercase tracking-wide text-foreground-subtle">
          {items.length > 0 ? "Todo" : "Todometer"}
        </span>
        <div
          className="min-w-0 flex-1"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={Math.max(1, items.length)}
          aria-valuenow={done}
          aria-label={`Todo ${done}/${items.length}`}
        >
          {items.length > 0 ? (
            <ZaicodeTodoCells items={items} className="h-2.5" />
          ) : (
            <div className="h-2.5 w-full border border-border/40 bg-background/50" />
          )}
        </div>
      </div>
      <button
        type="button"
        className="shrink-0 whitespace-nowrap border border-border bg-card px-1.5 py-0.5 tabular-nums text-foreground-subtle hover:text-foreground focus-visible:text-foreground"
        aria-label={`Open todo board: ${done}/${items.length} done`}
        title="Show / hide the todo list"
        onClick={toggleZaicodeTodoDock}
      >
        <strong className="font-normal text-foreground">{done}</strong>/{items.length}
      </button>
    </div>
  );
}


const COLUMN_WIDTH = 22;
const COLUMN_GAP = 10;
const COLUMN_LABEL_HEIGHT = 16;

/** Battlezone health zones, bottom to top: red, yellow, green. */
function columnZoneColor(position: number): string {
  if (position <= 1 / 3) return "#c0141a";
  if (position <= 2 / 3) return "#c8b41e";
  return "#1fb81f";
}

function columnCellBackground(color: string): string {
  // Solid cell with a bright centre stripe, like the Battlezone unit meter.
  const light = `color-mix(in srgb, ${color} 35%, #ffffff)`;
  return `linear-gradient(to right, ${color} 0 26%, ${light} 26% 74%, ${color} 74% 100%)`;
}

interface ColumnBox {
  left: number;
  top: number;
  height: number;
}

/**
 * Vertical todo meter in the free space left of the composer (Battlezone unit
 * F-group style): one cell per todo item stacked bottom-up, finished cells lit
 * in their zone colour, the running one half-lit, pending ones black. Click
 * shows / hides the todo list. Hidden when the window leaves no room for it.
 */
function ZaicodeTodoColumn({
  items,
  anchorRef,
}: {
  items: readonly ZaicodeTodoItem[];
  anchorRef: { current: HTMLDivElement | null };
}) {
  const [box, setBox] = useState<ColumnBox | null>(null);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const measure = () => {
      const rect = anchor.getBoundingClientRect();
      const composer = anchor.nextElementSibling as HTMLElement | null;
      const bottom = composer ? composer.getBoundingClientRect().bottom : rect.bottom;
      const left = rect.left - COLUMN_GAP - COLUMN_WIDTH;
      const next =
        left < 4 || rect.width === 0
          ? null
          : { left: Math.round(left), top: Math.round(rect.top), height: Math.round(Math.max(72, bottom - rect.top)) };
      setBox((current) =>
        current?.left === next?.left && current?.top === next?.top && current?.height === next?.height
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    if (anchor.parentElement) observer.observe(anchor.parentElement);
    window.addEventListener("resize", measure);
    // Sidebar / side-pane toggles move the column without resizing it; a cheap poll catches that.
    const timer = window.setInterval(measure, 700);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.clearInterval(timer);
    };
  }, [anchorRef]);

  if (!box || items.length === 0) return null;
  const done = items.filter((item) => item.status === "completed").length;
  // Bottom-up: completed first, then the running one, then what is still pending.
  const ordered = [
    ...items.filter((item) => item.status === "completed"),
    ...items.filter((item) => item.status === "inProgress"),
    ...items.filter((item) => item.status === "pending"),
  ];

  return createPortal(
    <button
      type="button"
      data-zaicode-todo-column
      onClick={toggleZaicodeTodoDock}
      title={`Todo ${done}/${items.length} — click to show / hide the list`}
      aria-label={`Todo ${done}/${items.length}: show or hide the todo list`}
      className="fixed z-40 flex flex-col border border-[var(--zaicode-bevel-dark,#000)] bg-black p-[2px]"
      style={{ left: box.left, top: box.top, width: COLUMN_WIDTH, height: box.height }}
    >
      <span className="flex min-h-0 w-full flex-1 flex-col-reverse gap-px">
        {ordered.map((item, index) => {
          const color = columnZoneColor((index + 1) / ordered.length);
          return (
            <span
              key={index}
              className="min-h-px w-full flex-1"
              style={
                item.status === "completed"
                  ? { background: columnCellBackground(color) }
                  : item.status === "inProgress"
                    ? {
                        background: columnCellBackground(`color-mix(in srgb, ${color} 55%, #000000)`),
                        outline: `1px solid ${color}`,
                        outlineOffset: -1,
                      }
                    : { background: "#141414" }
              }
            />
          );
        })}
      </span>
      <span
        className="flex w-full shrink-0 items-end justify-center tabular-nums leading-none text-white"
        style={{ height: COLUMN_LABEL_HEIGHT, fontSize: 10 }}
      >
        {done}
      </span>
    </button>,
    document.body,
  );
}
