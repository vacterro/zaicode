/* eslint-disable max-lines -- ZAICODE SAIPEN side pane renders the protocol inspector sections from one parsed snapshot. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZaicodeSaipen } from "./zaicodeSaipen.js";
import { useZaicodeProjectRuntime, zaicodeSaipenHeadline } from "./zaicodeProjectRuntime.js";
import {
  saipenBoardShares,
  type ZaicodeSaipenBoardTicket,
  type ZaicodeSaipenLogLine,
  type ZaicodeSaipenSection,
} from "./zaicodeSaipenModel.js";
import { ZaicodeWorkingIcon } from "./ZaicodeWorkingIcon.js";
import { sortZaicodeLogLines, type ZaicodeLogOrder } from "./zaicodeSaipenDetail.js";
import { useZaicodeRunningSessions } from "./zaicodeSidebarPrefs.js";

/**
 * SAIPEN live protocol view for the right side pane: STATE, BOARD and LOG of
 * the active project, re-read whenever STATE.md moves (every SAIPEN
 * checkpoint), so the protocol can be watched as it lives. Read-only: agents
 * own `.saipen/` through the SAIPEN launcher.
 */

const OPEN_KEY = "zaicode-saipen-pane-open-v1";
type PaneSection = "state" | "board" | "log" | "done";
const DEFAULT_OPEN: Record<PaneSection, boolean> = { state: true, board: true, log: true, done: false };

function readOpen(): Record<PaneSection, boolean> {
  try {
    return { ...DEFAULT_OPEN, ...(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") as object) };
  } catch {
    return { ...DEFAULT_OPEN };
  }
}

const LOG_ORDER_KEY = "zaicode-saipen-log-order-v1";

function readLogOrder(): ZaicodeLogOrder {
  try {
    return localStorage.getItem(LOG_ORDER_KEY) === "newest-first" ? "newest-first" : "oldest-first";
  } catch {
    return "oldest-first";
  }
}

const FLASH_CSS = `
@keyframes zaicode-saipen-flash {
  from { background: color-mix(in srgb, var(--zaicode-highlight, var(--color-warning)) 28%, transparent); }
  to { background: transparent; }
}
[data-zaicode-saipen-new] { animation: zaicode-saipen-flash 2.4s ease-out 1; }
`;

const SECTION_META: Record<
  ZaicodeSaipenSection,
  { label: string; glyph: string; color: string; hint: string }
> = {
  DOING: {
    label: "DOING",
    glyph: "▶",
    color: "var(--zaicode-highlight, var(--color-warning))",
    hint: "Claimed and being worked on",
  },
  TODO: { label: "TODO", glyph: "☐", color: "var(--color-foreground-subtle)", hint: "Waiting to be picked up" },
  BLOCKED: {
    label: "BLOCKED",
    glyph: "⛔",
    color: "var(--color-destructive)",
    hint: "Needs a human or an outside fact",
  },
  DONE: { label: "DONE", glyph: "☑", color: "var(--color-success)", hint: "Closed with evidence" },
};

const PRIORITY_COLOR: Record<string, string> = {
  P0: "var(--color-destructive)",
  P1: "var(--zaicode-highlight, var(--color-warning))",
  P2: "var(--color-foreground-subtle)",
  P3: "var(--color-foreground-subtlest)",
};

function tagColor(line: ZaicodeSaipenLogLine): string {
  const text = line.text.toUpperCase();
  if (/\bFAIL|BLOCK|REFUSE|ERROR\b/.test(text)) return "var(--color-destructive)";
  if (/\bPASS\b|finished|SHIP/.test(line.text)) return "var(--color-success)";
  if (line.tag === "DEC") return "var(--zaicode-highlight, var(--color-warning))";
  if (line.tag === "USR") return "var(--color-foreground)";
  return "var(--color-foreground-subtle)";
}

function isoAge(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function SectionHeader({
  open,
  onToggle,
  title,
  right,
}: {
  open: boolean;
  onToggle: () => void;
  title: ReactNode;
  right?: ReactNode;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="flex items-center gap-1 border-b border-border bg-card px-2 py-0.5 text-[10px] tracking-wide text-foreground-subtle">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground"
        onClick={onToggle}
        aria-expanded={open}
      >
        <Chevron className="size-3 shrink-0" />
        {title}
      </button>
      {right}
    </div>
  );
}

function TicketRow({
  ticket,
  fresh,
  working,
}: {
  ticket: ZaicodeSaipenBoardTicket;
  fresh: boolean;
  working: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = SECTION_META[ticket.section];
  const detailFields = Object.entries(ticket.fields);
  return (
    <li data-zaicode-saipen-new={fresh ? "" : undefined}>
      <button
        type="button"
        className="flex w-full min-w-0 items-start gap-1.5 px-2 py-0.5 text-left hover:bg-hover"
        onClick={() => setExpanded((value) => !value)}
        title={ticket.fields.blocker ? `BLOCKER: ${ticket.fields.blocker}` : meta.hint}
      >
        <span className="flex w-4 shrink-0 justify-center pt-px" style={{ color: meta.color }}>
          {ticket.section === "DOING" && working ? <ZaicodeWorkingIcon className="size-3.5" /> : meta.glyph}
        </span>
        <span className="shrink-0 tabular-nums text-foreground">{ticket.id}</span>
        {ticket.priority ? (
          <span
            className="shrink-0 border px-0.5 text-[10px] leading-3"
            style={{ borderColor: PRIORITY_COLOR[ticket.priority], color: PRIORITY_COLOR[ticket.priority] }}
          >
            {ticket.priority}
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0 flex-1",
            expanded ? "whitespace-normal break-words" : "truncate",
            ticket.section === "DONE" ? "text-foreground-subtle" : "text-foreground",
          )}
        >
          {ticket.title || "—"}
        </span>
      </button>
      {expanded && detailFields.length > 0 ? (
        <dl className="ml-7 mr-2 mb-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 border-l border-border pl-2 text-[11px]">
          {detailFields.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-foreground-subtlest">{key}</dt>
              <dd
                className={cn(
                  "min-w-0 break-words",
                  key === "blocker" ? "text-destructive" : "text-foreground-subtle",
                )}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

export function ZaicodeSaipenSidePane({
  workspacePath,
  workspaceIdentity,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  className?: string;
}) {
  const saipen = useZaicodeSaipen(workspacePath, workspaceIdentity);
  const runtime = useZaicodeProjectRuntime(workspacePath, workspaceIdentity, saipen);
  // T-41: the header lines print SAIPEN's projection when it answered.
  const headline = zaicodeSaipenHeadline(saipen);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const projectWorking = useZaicodeRunningSessions((state) =>
    state.sessions.some((session) => session.workspaceKey === workspaceKey),
  );
  const [open, setOpen] = useState(readOpen);
  const [follow, setFollow] = useState(true);
  const [logOrder, setLogOrder] = useState<ZaicodeLogOrder>(readLogOrder);
  const [now, setNow] = useState(() => Date.now());
  const [changedAt, setChangedAt] = useState<number | null>(null);
  const seenEventsRef = useRef<Set<string> | null>(null);
  const seenTicketsRef = useRef<Map<string, ZaicodeSaipenSection> | null>(null);
  const logRef = useRef<HTMLOListElement | null>(null);
  const projectName = workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? workspacePath;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const toggle = (section: PaneSection) =>
    setOpen((current) => {
      const next = { ...current, [section]: !current[section] };
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        // View preference only.
      }
      return next;
    });

  const detail = saipen?.detail;
  // New events / tickets that moved since the previous snapshot flash once.
  const fresh = useMemo(() => {
    const events = new Set<string>();
    const tickets = new Set<string>();
    if (!detail) return { events, tickets };
    const seenEvents = seenEventsRef.current;
    const seenTickets = seenTicketsRef.current;
    if (seenEvents) for (const line of detail.log) if (!seenEvents.has(line.key)) events.add(line.key);
    if (seenTickets) {
      for (const ticket of detail.tickets) {
        if (seenTickets.get(ticket.id) !== ticket.section) tickets.add(ticket.id);
      }
    }
    return { events, tickets };
  }, [detail]);
  useEffect(() => {
    if (!detail) return;
    if (seenEventsRef.current && (fresh.events.size > 0 || fresh.tickets.size > 0)) {
      setChangedAt(Date.now());
    }
    seenEventsRef.current = new Set(detail.log.map((line) => line.key));
    seenTicketsRef.current = new Map(detail.tickets.map((ticket) => [ticket.id, ticket.section]));
  }, [detail, fresh]);
  useEffect(() => {
    // "follow" keeps the newest event in view: at the bottom oldest-first, at the top newest-first.
    if (follow && logRef.current) logRef.current.scrollTop = logOrder === "newest-first" ? 0 : logRef.current.scrollHeight;
  }, [detail?.log, follow, open.log, logOrder]);
  const flipLogOrder = () =>
    setLogOrder((current) => {
      const next: ZaicodeLogOrder = current === "newest-first" ? "oldest-first" : "newest-first";
      try {
        localStorage.setItem(LOG_ORDER_KEY, next);
      } catch {
        // View preference only.
      }
      return next;
    });

  if (!saipen) {
    return (
      <div className={cn("flex h-full min-h-0 flex-col items-center justify-center gap-2 p-4 text-ui-xs", className)}>
        <span className="text-foreground-subtle">SAIPEN · {projectName}</span>
        <span className="text-foreground-subtlest">No .saipen/ memory in this project yet.</span>
        <span className="text-foreground-subtlest">INIT SAIPEN in the composer strip creates it.</span>
      </div>
    );
  }

  const shares = saipenBoardShares(saipen);
  const chipColor = runtime?.color ?? null;
  const tickets = detail?.tickets ?? [];
  const bySection = (section: ZaicodeSaipenSection) => tickets.filter((ticket) => ticket.section === section);
  const done = bySection("DONE");
  const log = sortZaicodeLogLines(detail?.log ?? [], logOrder);
  const stateFields = detail?.state ?? [];
  const ageOfState = isoAge(saipen.updated, now);
  const live = changedAt !== null && now - changedAt < 15_000;
  const total = saipen.counts.doing + saipen.counts.todo + saipen.counts.done + saipen.counts.blocked;
  const lastEvent = stateFields.find(([key]) => key === "last_event")?.[1];

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col bg-background text-ui-xs", className)}
      data-zaicode-saipen-pane
    >
      <style>{FLASH_CSS}</style>
      {/* Header: project, live pulse, protocol clock */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
        <strong className="font-normal text-foreground">SAIPEN</strong>
        <span className="min-w-0 truncate text-foreground-subtle" title={workspacePath}>
          {projectName}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-foreground-subtlest" title="Re-read on every SAIPEN checkpoint (STATE.md change), polled every 3 s">
          <span
            className={cn("size-2 border border-black", projectWorking && "animate-pulse")}
            style={{
              background: projectWorking
                ? "var(--color-success)"
                : live
                  ? "var(--zaicode-highlight, var(--color-warning))"
                  : "var(--color-foreground-subtlest)",
            }}
          />
          {projectWorking ? "LIVE" : "idle"}
          {ageOfState ? ` · ${ageOfState}` : ""}
        </span>
      </div>

      {/* Summary: phase chip, ticket, next action, progress */}
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="shrink-0 border px-1 tabular-nums"
            style={
              chipColor
                ? {
                    borderColor: chipColor,
                    color: `color-mix(in srgb, ${chipColor} 70%, var(--color-foreground))`,
                    background: `color-mix(in srgb, ${chipColor} 14%, transparent)`,
                  }
                : undefined
            }
            title={runtime ? `${runtime.verdict.label}: ${runtime.verdict.reason}` : undefined}
          >
            {headline?.phase ?? "IDLE"}
          </span>
          <span className="shrink-0 text-foreground">{headline?.task && headline.task !== "none" ? headline.task : "no ticket"}</span>
          <span className="min-w-0 flex-1 truncate text-foreground-subtle" title={headline?.nextAction ?? undefined}>
            → {headline?.nextAction ?? "—"}
          </span>
        </div>
        {headline?.blocker ? (
          <div className="border border-destructive px-1 text-destructive" title={headline.blocker}>
            BLOCKER: {headline.blocker}
          </div>
        ) : null}
        {shares ? (
          <div className="flex items-center gap-2">
            <span className="flex h-2 min-w-0 flex-1 border border-border" title="DONE / TODO+DOING / BLOCKED">
              <span style={{ width: `${shares.done * 100}%`, background: "var(--color-success)" }} />
              <span style={{ width: `${shares.todo * 100}%`, background: "var(--color-warning)" }} />
              <span style={{ width: `${shares.blocked * 100}%`, background: "var(--color-destructive)" }} />
            </span>
            <span className="shrink-0 tabular-nums text-foreground-subtle">
              {saipen.counts.done}/{total}
            </span>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* STATE */}
        <SectionHeader
          open={open.state}
          onToggle={() => toggle("state")}
          title={<>STATE{lastEvent ? <span className="text-foreground-subtlest"> · {lastEvent}</span> : null}</>}
        />
        {open.state ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 px-2 py-1 text-[11px]">
            {stateFields.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-foreground-subtlest">{key}</dt>
                <dd
                  className={cn(
                    "min-w-0 truncate",
                    key === "blocker" && value !== "none" ? "text-destructive" : "text-foreground-subtle",
                    key === "phase" && "text-foreground",
                  )}
                  title={value}
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {/* BOARD */}
        <SectionHeader
          open={open.board}
          onToggle={() => toggle("board")}
          title={
            <>
              BOARD
              <span className="text-foreground-subtlest">
                {" "}
                · {saipen.counts.doing} doing · {saipen.counts.todo} todo · {saipen.counts.blocked} blocked
              </span>
            </>
          }
        />
        {open.board ? (
          <div className="py-0.5">
            {(["DOING", "TODO", "BLOCKED"] as const).map((section) => {
              const rows = bySection(section);
              const meta = SECTION_META[section];
              return (
                <div key={section}>
                  <div className="flex items-center gap-1 px-2 pt-1 text-[10px] tracking-wide" style={{ color: meta.color }}>
                    {meta.label}
                    <span className="text-foreground-subtlest">({rows.length})</span>
                  </div>
                  {rows.length === 0 ? (
                    <div className="px-2 pl-7 text-foreground-subtlest">—</div>
                  ) : (
                    <ul>
                      {rows.map((ticket) => (
                        <TicketRow
                          key={ticket.id}
                          ticket={ticket}
                          fresh={fresh.tickets.has(ticket.id)}
                          working={projectWorking}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
            <button
              type="button"
              className="flex w-full items-center gap-1 px-2 pt-1 text-left text-[10px] tracking-wide hover:text-foreground"
              style={{ color: SECTION_META.DONE.color }}
              onClick={() => toggle("done")}
              aria-expanded={open.done}
            >
              {open.done ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              DONE <span className="text-foreground-subtlest">({done.length})</span>
              {!open.done && done[0] ? (
                <span className="min-w-0 truncate text-foreground-subtlest normal-case">
                  · last {done[0].id} {done[0].title}
                </span>
              ) : null}
            </button>
            {open.done ? (
              <ul>
                {done.map((ticket) => (
                  <TicketRow
                    key={ticket.id}
                    ticket={ticket}
                    fresh={fresh.tickets.has(ticket.id)}
                    working={false}
                  />
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {/* LOG */}
        <SectionHeader
          open={open.log}
          onToggle={() => toggle("log")}
          title={
            <>
              LOG <span className="text-foreground-subtlest">· last {log.length} events</span>
            </>
          }
          right={
            open.log ? (
              <span className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  className="border border-border px-1 text-foreground-subtle hover:text-foreground"
                  title="Order by time stamp: click to flip (newest first / oldest first)"
                  aria-label={logOrder === "newest-first" ? "Newest first: click for oldest first" : "Oldest first: click for newest first"}
                  data-zaicode-log-order={logOrder}
                  onClick={flipLogOrder}
                >
                  {logOrder === "newest-first" ? "newest first" : "oldest first"}
                </button>
                <label className="flex shrink-0 items-center gap-1 text-foreground-subtlest" title="Keep the newest event in view">
                  <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
                  follow
                </label>
              </span>
            ) : null
          }
        />
        {open.log ? (
          <ol ref={logRef} className="max-h-[50vh] overflow-y-auto py-0.5 font-mono text-[11px] leading-4">
            {log.map((line) => (
              <li
                key={line.key}
                className="flex min-w-0 gap-1.5 px-2 hover:bg-hover"
                data-zaicode-saipen-new={fresh.events.has(line.key) ? "" : undefined}
                title={[line.date, line.time, line.event, line.ticket, line.agent ? `agent ${line.agent}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              >
                <span className="shrink-0 tabular-nums text-foreground-subtlest">{line.time ?? "--:--"}</span>
                {line.ticket ? <span className="shrink-0 text-foreground-subtle">{line.ticket}</span> : null}
                {line.tag ? (
                  <span className="shrink-0" style={{ color: tagColor(line) }}>
                    {line.tag}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 break-words text-foreground-subtle">{line.text}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </div>
  );
}
