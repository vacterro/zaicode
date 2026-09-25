import { ListCollapse, ListTree } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { readinessBarColor } from "./zaicodeTodoProgress.js";
import { useZaicodeRunningSessions, useZaicodeSidebarPrefs } from "./zaicodeSidebarPrefs.js";
import { useZaicodeLayout } from "./zaicodeLayoutPrefs.js";
import { cycleZaicodeSession, openZaicodeSession, useZaicodeSessionNav } from "./zaicodeSessionNav.js";

/** Header toggle for the sidebar menu block (New task, ZAICODE, ... as the operator chose). */
export function ZaicodeSidebarNavToggle() {
  const navOpen = useZaicodeSidebarPrefs((state) => state.navOpen);
  const update = useZaicodeSidebarPrefs((state) => state.update);
  const Icon = navOpen ? ListCollapse : ListTree;
  const label = navOpen ? "Hide the menu (New task, ZAICODE, …)" : "Show the menu (New task, ZAICODE, …)";
  return (
    <button
      type="button"
      aria-pressed={navOpen}
      aria-label={label}
      title={label}
      onClick={() => update({ navOpen: !navOpen })}
      className={cn(
        "flex size-7 items-center justify-center text-foreground-subtle hover:bg-hover hover:text-foreground",
        navOpen && "bg-selected text-foreground",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

/**
 * How many sessions are working right now, plus one Battlezone F-group cell
 * per worker: black (just started) -> red -> amber -> green (almost done).
 * Click a cell to open that session; click the count to jump to the next
 * working one (right-click: back).
 */
export function ZaicodeRunningMeter() {
  const sessions = useZaicodeRunningSessions((state) => state.sessions);
  const visible = useZaicodeLayout((state) => state.headerTools.find((tool) => tool.id === "meter")?.visible !== false);
  const activeTaskId = useZaicodeSessionNav((state) => state.activeTaskId);
  if (!visible) return null;
  const count = sessions.length;
  const ordered = [...sessions].sort((left, right) => right.ratio - left.ratio);
  const title =
    count === 0
      ? "Nothing is working right now"
      : `${count} working now — click a cell to open it\n${ordered
          .map((session) => `${Math.round(session.ratio * 100)}%  ${session.title}`)
          .join("\n")}`;
  const shown = ordered.slice(0, 12);
  const cellWidth = shown.length > 8 ? "w-1" : shown.length > 5 ? "w-1.5" : "w-2.5";
  const cellGap = shown.length > 8 ? "gap-[1px]" : shown.length > 5 ? "gap-0.5" : "gap-1";

  return (
    <span
      className={cn("flex h-7 shrink-0 items-center px-1 tabular-nums max-w-[88px]", cellGap)}
      title={title}
      aria-label={`${count} sessions working`}
      data-zaicode-running-meter={count}
    >
      <div className={cn("flex items-center shrink min-w-0", cellGap)}>
        {shown.map((session) => (
          <button
            key={session.sessionId}
            type="button"
            title={`${Math.round(session.ratio * 100)}%  ${session.title}\nClick: open this session`}
            aria-label={`Open ${session.title}`}
            className={cn(
              "h-4 shrink-0 border hover:border-[var(--zaicode-highlight,#f0c040)]",
              session.sessionId === activeTaskId ? "border-[var(--zaicode-highlight,#f0c040)]" : "border-black",
              cellWidth,
            )}
            style={{ background: readinessBarColor(session.ratio) }}
            onClick={() => openZaicodeSession(session)}
          />
        ))}
      </div>
      <button
        type="button"
        className={cn("text-ui-sm shrink-0 hover:text-foreground", count > 0 ? "text-foreground" : "text-foreground-subtlest")}
        title={count > 0 ? "Next working session (right-click: previous)" : "Nothing is working"}
        disabled={count === 0}
        onClick={() => cycleZaicodeSession(1, sessions)}
        onContextMenu={(event) => {
          event.preventDefault();
          cycleZaicodeSession(-1, sessions);
        }}
      >
        {count}
      </button>
    </span>
  );
}
