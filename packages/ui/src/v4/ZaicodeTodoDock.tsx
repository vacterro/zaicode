import { useEffect, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import type { ConversationStatusPanelPlanModel } from "./conversationStatusPanelModel.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ZaicodeIcon } from "@/zaicode/zaicodeIconSlots.js";

const STORAGE_KEY = "zaicode-todo-window";
const TOGGLE_EVENT = "zaicode-todo-window-toggle";

/** Shows the todo window, or hides it when it is already open (every todo trigger toggles). */
export function toggleZaicodeTodoDock(): void {
  window.dispatchEvent(new Event(TOGGLE_EVENT));
}

interface TodoWindowState {
  open: boolean;
  docked: boolean;
  x: number;
  y: number;
}

function readWindowState(): TodoWindowState {
  const fallback = { open: false, docked: true, x: 80, y: 80 };
  try {
    const value = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "null",
    ) as Partial<TodoWindowState> | null;
    if (!value || typeof value !== "object") return fallback;
    return {
      open: value.open === true,
      docked: value.docked !== false,
      x: Number.isFinite(value.x) ? Math.max(0, value.x!) : fallback.x,
      y: Number.isFinite(value.y) ? Math.max(0, value.y!) : fallback.y,
    };
  } catch {
    return fallback;
  }
}

export function ZaicodeTodoDock({ plan }: { plan: ConversationStatusPanelPlanModel }) {
  const { intl } = useZCodeIntl();
  const [state, setState] = useState(readWindowState);
  const [dragStart, setDragStart] = useState<{
    pointerX: number;
    pointerY: number;
    x: number;
    y: number;
  } | null>(null);
  const label = (id: string) => intl.formatMessage({ id: `zaicode.todo.${id}` });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* preference is optional */
    }
  }, [state]);

  useEffect(() => {
    const toggle = () => setState((current) => ({ ...current, open: !current.open }));
    window.addEventListener(TOGGLE_EVENT, toggle);
    return () => window.removeEventListener(TOGGLE_EVENT, toggle);
  }, []);

  // The window is always movable: grabbing a docked window detaches it where it stands.
  const beginDrag = (event: PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    const origin = state.docked && rect ? { x: rect.left, y: rect.top } : { x: state.x, y: state.y };
    if (state.docked) setState((current) => ({ ...current, docked: false, ...origin }));
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart({ pointerX: event.clientX, pointerY: event.clientY, ...origin });
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    if (!dragStart) return;
    setState((current) => ({
      ...current,
      x: Math.max(
        0,
        Math.min(window.innerWidth - 100, dragStart.x + event.clientX - dragStart.pointerX),
      ),
      y: Math.max(
        0,
        Math.min(window.innerHeight - 60, dragStart.y + event.clientY - dragStart.pointerY),
      ),
    }));
  };

  return (
    <>
      <button
        type="button"
        className="pointer-events-auto flex shrink-0 items-center gap-1 border border-border bg-card px-2 py-1 text-ui-xs text-foreground"
        aria-label={`${label("title")} ${plan.completedCount}/${plan.totalCount}`}
        aria-expanded={state.open}
        onClick={() => setState((current) => ({ ...current, open: !current.open }))}
      >
        <ZaicodeIcon slot="todo.trigger" className="size-4" />
        <span className="tabular-nums">
          {plan.completedCount}/{plan.totalCount}
        </span>
      </button>
      {state.open &&
        createPortal(
          <aside
            aria-label={label("title")}
            className="fixed z-[90] flex max-h-[min(70vh,34rem)] w-80 max-w-[calc(100vw-1rem)] flex-col border border-border bg-card text-foreground shadow-md"
            style={state.docked ? { right: 16, top: 64 } : { left: state.x, top: state.y }}
          >
            <header
              className="flex cursor-move items-center gap-2 border-b border-border px-2 py-1.5"
              onPointerDown={beginDrag}
              onPointerMove={moveDrag}
              onPointerUp={() => setDragStart(null)}
              onPointerCancel={() => setDragStart(null)}
            >
              <ZaicodeIcon slot="todo.drag" className="size-3 text-foreground-subtle" />
              <ZaicodeIcon slot="todo.panel" className="size-4" />
              <strong className="min-w-0 flex-1 truncate text-ui-base">{label("title")}</strong>
              <span className="tabular-nums text-ui-xs">
                {plan.completedCount}/{plan.totalCount}
              </span>
              <button
                type="button"
                title={state.docked ? label("detach") : label("dock")}
                aria-label={state.docked ? label("detach") : label("dock")}
                className="border border-border p-1"
                onClick={() =>
                  setState((current) => ({
                    ...current,
                    docked: !current.docked,
                    x: current.docked ? Math.max(0, window.innerWidth - 340) : current.x,
                    y: current.docked ? 80 : current.y,
                  }))
                }
              >
                <ZaicodeIcon
                  slot={state.docked ? "todo.detach" : "todo.dock"}
                  className="size-3.5"
                />
              </button>
              <button
                type="button"
                title={label("close")}
                aria-label={label("close")}
                className="border border-border p-1"
                onClick={() => setState((current) => ({ ...current, open: false }))}
              >
                <ZaicodeIcon slot="todo.close" className="size-3.5" />
              </button>
            </header>
            <ol className="min-h-0 overflow-y-auto p-2">
              {plan.items.map((item, index) => (
                <li
                  key={item.id ?? index}
                  className="flex items-start gap-2 border-b border-border/50 px-1 py-2 text-ui-xs last:border-b-0"
                >
                  <ZaicodeIcon
                    slot={item.status === "completed" ? "todo.done" : "todo.pending"}
                    className={
                      item.status === "completed"
                        ? "mt-0.5 size-4 shrink-0 text-success"
                        : "mt-0.5 size-4 shrink-0 text-foreground-subtle"
                    }
                  />
                  <span className="min-w-0 flex-1 break-words">{item.content}</span>
                </li>
              ))}
            </ol>
          </aside>,
          document.body,
        )}
    </>
  );
}
