import { useEffect, useMemo, useRef, useState } from "react";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import { cn } from "@/components/lib/utils.js";
import { openZaicodeSettings, takeZaicodeHelpTopic } from "@/zaicode/zaicodeActions.js";
import { openZaicodeWorkersPanel } from "@/zaicode/zaicodeWorkers.js";
import { useZaicodeTimers } from "@/zaicode/zaicodeTimerStore.js";

/**
 * ZAICODE Help: every control in plain words. One card per area, each line
 * is "what you see — what it does". Type to filter; "Open" jumps to the
 * place where it is set up. Nothing here is required reading: the product
 * works without it, this is where to look when something is unclear.
 */

interface HelpTopic {
  id: string;
  title: string;
  /** One sentence: why this exists. */
  what: string;
  lines: readonly string[];
  open?: { label: string; section?: SettingsSectionId; run?: () => void };
}

const TOPICS: readonly HelpTopic[] = [
  {
    id: "start",
    title: "Start here",
    what: "ZAICODE runs AI coding agents on your projects — in-app agents and your own subscriptions (Claude Code, Codex, Antigravity, ZCode).",
    lines: [
      "Open a project — the sidebar lists them; the folder button adds one.",
      "Pick an engine — the tiles at the top of the sidebar (see Engines).",
      "SAIHOME (Alt+H) — what is happening: clock, limits, projects, agents, statistics. Opening it starts nothing.",
      "New task (Ctrl+N) — type what you want and send. That is all you need.",
      "Several agents in parallel — the ZAICODE page: Teams adds ready-made agents, ▶ Tour shows the screen step by step.",
    ],
  },
  {
    id: "engines",
    title: "Engines (sidebar top)",
    what: "Everything that can do work for you, picked with one click.",
    lines: [
      "SAIFREN / SAIOPP — in-app model pools (free / deep thinking). Click = new sessions use it.",
      "A1 A2 · C1 C2 C3 · AG · ZC — your Claude, Codex, Antigravity and ZCode logins, found automatically.",
      "Bar under a tile — quota left: green > 50%, amber, red < 20%, dark = out. Background tint says the same (strength in Engines & limits).",
      "Click a tile = START and new prompts use it (Claude / Codex answer in SUBCHAT) · double-click = start it as a worker in this project · right-click = start, read quota, fix sign-in, hide.",
      "Dashed tile with ! — needs sign-in or the CLI is missing; right-click → Fix shows the exact command first.",
      "A tile glows after its quota window resets; the card says which window.",
    ],
    open: { label: "Engines & limits", section: "zaicodeEngines" },
  },
  {
    id: "meter",
    title: "AI limit meter (title bar)",
    what: "Every subscription's quota without opening anything.",
    lines: [
      "Hover — full breakdown: each window (5h, weekly…), percent left, when it resets.",
      "Click — Engines settings · Ctrl+Click — Stacked / Bars / Dots · Shift+Click — read every quota now.",
      "Right-click — which engines show: hide 0% used, only engines whose 5h window can work now, hide one engine from the meter only, bars show left or used, vendor tint, names.",
      "Reading quota never spends quota: each vendor's own read-only call is used.",
    ],
    open: { label: "Meter settings", section: "zaicodeEngines" },
  },
  {
    id: "subchat",
    title: "SUBCHAT (subscriptions as a chat)",
    what: "Your Claude Code and Codex logins answer in a plain chat inside ZAICODE: no worker, no terminal.",
    lines: [
      "Open it — the SUBCHAT menu line. The tiles at its top start a new chat with that login (A1, A2, C1…) in the current project.",
      "Or pick a Claude / Codex tile on the sidebar and type in the composer (or press START): the prompt opens a SUBCHAT.",
      "Each turn runs that login's own CLI in the background in the project folder, with its own tools and quota; the next prompt continues the same session.",
      "Several logins side by side — every login is its own tile and its own chat; chats can answer at the same time.",
      "Stop ends the running turn; Delete removes the chat from ZAICODE (the vendor keeps its own session files).",
      "Prefer a terminal? Settings → Engines & limits → Workers: switch “Prompts for a picked subscription open a SUBCHAT” off. Antigravity and ZCode always start a worker.",
    ],
    open: { label: "Engines & limits", section: "zaicodeEngines" },
  },
  {
    id: "workers",
    title: "WORKERS (subscription CLIs)",
    what: "A worker is a subscription CLI (or a shell) running in a terminal inside ZAICODE.",
    lines: [
      "They dock in the WORKERS panel under the chat, like a normal terminal. Show / hide it from the sidebar list, the header button or its hotkey.",
      "Split shows all docked workers side by side (or stacked, or a grid); drag a divider, double-click it = even. Tabs shows one at a time.",
      "⧉ on a worker = its own window. Drag its title: side edge = half, corner = quarter, top = maximize, bottom = back into the panel. Edges stick to other windows.",
      "– = minimize to a chip named “engine · project”; chips stack where you choose (bottom left / centre / right, or left / right middle).",
      "× stops the CLI (asks first while it runs). Right-click any worker for: move, minimize, start the same again, copy its command.",
      "Font: Terminus by default (crisp at 12–32 px).",
    ],
    open: { label: "Workers settings", section: "zaicodeWorkers", run: () => openZaicodeWorkersPanel() },
  },
  {
    id: "saihome",
    title: "SAIHOME",
    what: "The operator home: what is happening, what needs you, what resets and starts next. New task is the composer; SAIHOME only shows and links.",
    lines: [
      "Open it — the SAIHOME menu line, Alt+H, or the tray menu. It is the first view after a start unless Layout & home says otherwise.",
      "Now — working sessions and workers, the queue, today's tokens and runs, the next reset, the next schedule, health.",
      "Needs you — only problems, each with why, impact and one button (router down, sign-in needed, blocked project, missed schedule…).",
      "Tokens & work — today / yesterday / week / month / all time from local statistics; CLI workers report no tokens and are shown as unmeasured, never as 0.",
      "Activity — day squares by activity, tokens, tasks, runs or runtime; arrow keys walk the days; current and longest streak.",
      "Projects — every project's SAIPEN state; click a row for details, Go to project and Open MAIN session (nothing is created).",
      "Presets — EVERYTHING, MINIMAL, OPERATOR, STATS, FACTORY; Edit layout for your own order, sizes and visibility.",
    ],
    open: { label: "Layout & home", section: "zaicodeLayout" },
  },
  {
    id: "header",
    title: "Sidebar header and menu",
    what: "The buttons above the project list — yours to choose.",
    lines: [
      "← → — previous / next place in your session history.",
      "Focus next session — click = next working or waiting session, round the ring; right-click = back.",
      "Menu toggle — shows / hides the menu block (SAIHOME, New task, ZAICODE, …).",
      "Project row — hover shows ◆ MAIN, ▶ START and … (new session, files, slots); the name never moves. Shift+Click switches a project off (dimmed, OFF: no automatic agent or schedule works there) and on again; Ctrl+Click sends it down a slot.",
      "Shift + drag a project and keep holding 2 s — the SLOTS panel opens: drop it on any slot, also an empty or folded one.",
      "Tray icon — right-click for ZAICODE's own menu (Open, SAIHOME, New task, WORKERS, Timers, Settings, Quit).",
      "Working meter — one cell per working session, black (just started) → green (almost done); click a cell = open it; the number = next working one.",
      "Right-click the header or the menu to choose and order the buttons and lines.",
    ],
    open: { label: "Layout & home", section: "zaicodeLayout" },
  },
  {
    id: "continue",
    title: "CONTINUE ALL, DONE and continue in place",
    what: "Keep every project moving and see what finished, without opening one session after another.",
    lines: [
      "CONTINUE ALL (under the menu) — hover or right-click shows the plan first: stopped goals start again with the same objective, failed turns continue (cc, or continue without SAIPEN), a SAIPEN project with open tickets and nothing running continues its MAIN with /goal cc all. Finished, running, switched-off and waiting-for-you sessions are left alone.",
      "DONE n — the oldest finished session you have not opened yet; opening marks it seen, so the next press opens the next one. Right-click lists them. Hotkey Alt+Right.",
      "▶ on a session row, or Alt+Click the row — continue that session without opening it. A session that waits for your answer opens instead.",
    ],
    open: { label: "Hotkeys", section: "zaicodeHotkeys" },
  },
  {
    id: "zaicode",
    title: "ZAICODE page (agents, tasks, results)",
    what: "Run several agents on queued tasks in parallel.",
    lines: [
      "Agents (left) — saved roles with their model pool. Teams adds a ready-made set (Solo, Builder + Reviewer, SAIPEN crew, Research → Build).",
      "Tasks (middle) — write, pick an agent, add. Autopilot on = starts at once; Parallel = how many at a time.",
      "Inspector (right) — configured pool vs what actually ran, the result, Open session.",
      "▶ Tour — a guided walk over the real screen.",
    ],
  },
  {
    id: "timers",
    title: "Timers and the clock",
    what: "FastPrompter's timers: never miss a limit reset or a break.",
    lines: [
      "Alarms — once, daily, weekdays, weekly, monthly, yearly or every N minutes; each with its own sound and colour.",
      "Interval reminders — a sound every N minutes, on the clock (:00, :30) or after the last one, optionally only in active hours.",
      "Temp Timer — one quick countdown; Shift+Click the clock adds minutes to it.",
      "Productivity — work / break phases; Ctrl+Click the clock starts / pauses.",
      "Calendar — events by date.",
      "Times are typed, 24-hour: 7, 0730 or 07:30 (00:00 is midnight); Up / Down move a minute, Shift ten, Page Up / Down an hour. Sound rows have their own All-day box. Enter in the moment field adds the alarm.",
      "The title-bar clock shows the nearest one in its heat colour (blue far away → red close); right-click it for what to show.",
    ],
    open: { label: "Timers", section: "zaicodeTimers", run: () => useZaicodeTimers.getState().openDialog("alarms") },
  },
  {
    id: "notifications",
    title: "Notifications",
    what: "A card for each kind of moment, each set up on its own.",
    lines: [
      "Per moment (turn finished, question, quota reset, worker crashed, timer…) — card on / off, how long it stays, Windows notification, glow.",
      "Glow — the thing that changed (a tile, a meter cell, a limit row) stays highlighted for the minutes you choose.",
      "Quiet hours — silence cards (and sounds, if you want) at night.",
    ],
    open: { label: "Notifications", section: "zaicodeNotifications" },
  },
  {
    id: "sounds",
    title: "Sounds, Problip and Ambience",
    what: "Every action can have its own sound — or none.",
    lines: [
      "Sounds table — one row per action: on / off, sound, your own file, volume relative to the master.",
      "Sound picker — short cues, jingles, voice and long ambience are separate groups with their length; hover, the wheel or arrow keys play what is under the cursor.",
      "Problip — a short cue at your interval, to keep a rhythm in long sessions.",
      "Ambience — a quiet background loop that plays only while agents work.",
    ],
    open: { label: "Sounds", section: "zaicodeSounds" },
  },
  {
    id: "hotkeys",
    title: "Hotkeys",
    what: "Everything can have two key combinations.",
    lines: [
      "Global keys work anywhere in Windows; In-app keys only while ZAICODE is focused.",
      "Keys follow the printed letter, so Ctrl+Q stays Ctrl+Q on any keyboard layout.",
      "F-keys can jump to recent sessions or to projects.",
      "Bind listens for the next combination; Esc cancels, Backspace clears.",
    ],
    open: { label: "Hotkeys", section: "zaicodeHotkeys" },
  },
  {
    id: "memory",
    title: "Memory",
    what: "What the in-app agent remembers about a project between sessions.",
    lines: [
      "On: after a conversation the agent may save a fact worth keeping (“tests run with pnpm test”, “never touch the prod folder”) as one small file.",
      "Next sessions in that project get those facts automatically. It costs a few extra model requests.",
      "Say “remember that …” to save one on purpose. Wrong ones can be read and removed in Settings → Memory.",
      "Only the in-app agent uses it; subscription workers (Claude Code, Codex…) keep their own memory.",
    ],
    open: { label: "Memory", section: "memory" },
  },
  {
    id: "home",
    title: "New task screen",
    what: "What an empty new session (the composer) shows. SAIHOME is the home.",
    lines: [
      "Welcome text — by time of day or your own words, only in the hours you pick.",
      "“Empty” marker and the SAIMAIL line — off unless you want them.",
      "Right-click that screen, or Layout & home, to change it.",
    ],
    open: { label: "Layout & home", section: "zaicodeLayout" },
  },
  {
    id: "saimail",
    title: "SAIMAIL",
    what: "Letters between your agents and you, in a mailbox folder.",
    lines: [
      "The envelope in the title bar shows unread letters; hover lists them.",
      "Click asks the agent to read the desk (it drafts, never sends by itself). Right-click for its options.",
    ],
    open: { label: "ZAICODE settings", section: "zaicode" },
  },
  {
    id: "autostart",
    title: "Autostart",
    what: "Start an engine in a project later, by itself.",
    lines: [
      "Once at a time, daily, every N minutes, or when a quota window refills.",
      "Each run fires once; a moment missed while ZAICODE was closed is reported, not launched late.",
    ],
    open: { label: "Engines & limits", section: "zaicodeEngines" },
  },
  {
    id: "zones",
    title: "Window zones",
    what: "Put the ZAICODE window on a screen zone with one key (FancyZones style).",
    lines: ["Pick a layout and a zone; save the current window position as a preset."],
    open: { label: "Layout & home", section: "zaicodeLayout" },
  },
];

export function ZaicodeHelpSection() {
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    const topic = takeZaicodeHelpTopic();
    if (!topic) return;
    setFocus(topic);
    requestAnimationFrame(() => refs.current.get(topic)?.scrollIntoView({ block: "start" }));
  }, []);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return TOPICS;
    return TOPICS.filter((topic) =>
      [topic.title, topic.what, ...topic.lines].some((text) => text.toLowerCase().includes(needle)),
    );
  }, [query]);

  return (
    <div className="flex flex-col gap-3 text-ui-xs" data-zaicode-help>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-ui-lg text-foreground">Help</h2>
        <span className="text-foreground-subtle">Every control in one line. Almost anything can also be right-clicked for its own settings.</span>
      </div>
      <input
        className="max-w-[420px] border border-border bg-background px-2 py-1 text-foreground"
        placeholder="Find: worker, meter, sound, reset, hotkey…"
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="flex flex-wrap gap-1">
        {TOPICS.map((topic) => (
          <button
            key={topic.id}
            type="button"
            className="border border-border px-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
            onClick={() => {
              setQuery("");
              setFocus(topic.id);
              requestAnimationFrame(() => refs.current.get(topic.id)?.scrollIntoView({ block: "start" }));
            }}
          >
            {topic.title}
          </button>
        ))}
      </div>
      {shown.length === 0 ? <p className="text-foreground-subtle">Nothing matches “{query}”.</p> : null}
      {shown.map((topic) => (
        <section
          key={topic.id}
          ref={(element) => {
            if (element) refs.current.set(topic.id, element);
            else refs.current.delete(topic.id);
          }}
          className={cn(
            "flex flex-col gap-1 border bg-card p-3",
            focus === topic.id ? "border-[var(--zaicode-highlight,var(--color-border-hover))]" : "border-border",
          )}
          data-zaicode-help-topic={topic.id}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-ui-base text-foreground">{topic.title}</h3>
              <p className="text-foreground-subtle">{topic.what}</p>
            </div>
            {topic.open ? (
              <button
                type="button"
                className="shrink-0 border border-border px-1.5 text-foreground hover:bg-hover"
                onClick={() => {
                  topic.open?.run?.();
                  if (topic.open?.section) void openZaicodeSettings(topic.open.section);
                }}
              >
                Open {topic.open.label}
              </button>
            ) : null}
          </div>
          <ul className="flex flex-col gap-0.5 pl-3">
            {topic.lines.map((line) => (
              <li key={line} className="list-disc text-foreground">
                {line}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
