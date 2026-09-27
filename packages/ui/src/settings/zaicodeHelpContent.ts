import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import { openZaicodeWorkersPanel } from "@/zaicode/zaicodeWorkers.js";
import { useZaicodeTimers } from "@/zaicode/zaicodeTimerStore.js";
import { openZaicodePebbleGame } from "@/zaicode/ZaicodePebbleGame.js";

// The Help content, kept apart from the component on purpose. SRC-060 asked for
// ZAICODE Help to be a real explanatory base, and it grows every time a surface
// is added, so the data cannot live inside a JSX file that also has a 400-line
// ceiling. Adding a topic here needs no component change at all.

export interface HelpTopic {
  id: string;
  title: string;
  /** One sentence: why this exists. */
  what: string;
  lines: readonly string[];
  open?: { label: string; section?: SettingsSectionId; run?: () => void };
}

export const ZAICODE_HELP_TOPICS: readonly HelpTopic[] = [
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
    id: "pebble",
    title: "PEBBLE DROP (easter egg)",
    what: "A complete six-level pixel game for a break between agent runs.",
    lines: [
      "Catch gold pebbles, dodge red hazards, collect rare hearts; every level gets faster and needs more catches.",
      "Left / Right or A / D moves; Space starts and advances; P pauses; R restarts; Esc closes.",
      "The title bar buttons make it fullscreen or detach it into its own window. Typing PEBBLE outside a text field is the secret entrance.",
    ],
    open: { label: "game", run: () => openZaicodePebbleGame() },
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
      "Right-click — which engines show: hide spent accounts, only engines whose 5h window can work now, hide one engine from the meter only, bars show left or used, vendor tint, names.",
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
    open: {
      label: "Workers settings",
      section: "zaicodeWorkers",
      run: () => openZaicodeWorkersPanel(),
    },
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
    open: {
      label: "Timers",
      section: "zaicodeTimers",
      run: () => useZaicodeTimers.getState().openDialog("alarms"),
    },
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
  {
    id: "dispatch",
    title: "Dispatch (terminal or vendor CLI in a project)",
    what: "Opens a real terminal, or a vendor CLI, rooted at whichever project you ask for — for the things the agents do not cover.",
    lines: [
      "Alt+D, or the Dispatch entry. Pick the project first, then the kind: a plain terminal, or a vendor's own CLI.",
      "The window is tied to that project, so relative paths and the project's own tools just work.",
      "Agents run independently of this: a Dispatch window is yours, not a worker's.",
    ],
  },
  {
    id: "scheduler",
    title: "SCHEDULER (prepared work)",
    what: "Fires prepared prompts on a schedule or when a limit window refills, so a repetitive job is written once.",
    lines: [
      "Each job has a project, a prompt, a trigger and a destination agent. A moment missed while ZAICODE was closed is reported, not fired late.",
      "The pool is per job: pick which subscription each prepared prompt lands on, and what happens when that one is busy.",
      "A prepared prompt that is waiting glows around its AI-limit meter, then fires when the room is made.",
    ],
    open: { label: "Timers & scheduler", section: "zaicodeTimers" },
  },
  {
    id: "search",
    title: "Search / Command Center",
    what: "One box for everything: projects, sessions, settings, and the commands ZAICODE can run.",
    lines: [
      "Type a project or session name to jump to it; type a command to run it without finding the button.",
      "Everything it lists is a real destination, so nothing here is a second thing to learn.",
    ],
  },
  {
    id: "plugins",
    title: "Plugin Marketplace",
    what: "Browse and install plugins for the app itself, the same place you manage them afterwards.",
    lines: [
      "Install, update and remove in one place. A plugin only ever changes ZAICODE, never your projects.",
      "Installed plugins appear in the main view beside the chat; the marketplace itself is read-only until you choose something.",
    ],
  },
  {
    id: "settings",
    title: "Settings (where everything is set up)",
    what: "Every ZAICODE preference lives here, grouped by what it changes. Nothing important is only reachable by right-click.",
    lines: [
      "Almost any control in the app can also be right-clicked for its own settings, and that is usually the shortest way.",
      "Settings that change the window itself (caption buttons, zones, splash) take effect on the next start, and say so.",
      "Sound and picture choices are kept per profile, so switching profiles switches them with it.",
    ],
  },
  {
    id: "composer",
    title: "The composer (writing to an agent)",
    what: "The box at the bottom of a session: what you type, what the agent may touch, and what it is doing right now.",
    lines: [
      "Type and send. The running turn shows a spinner and a working-for timer; the timer counts the work, not how long the session has been open.",
      "The model and its reasoning effort sit above the box. Effort choices come from the vendor, so the list differs per engine.",
      "Attachments, images and video are limited per engine; an unsupported file is refused with the reason rather than silently dropped.",
      "Stop ends the turn. A manual Stop is remembered: Auto continue leaves that session alone until you say otherwise.",
    ],
  },
  {
    id: "audit",
    title: "Audits (A3 waves)",
    what: "Repeated review waves over a project, run on a model of your choice, to find what a single pass misses.",
    lines: [
      "An A3 campaign is waves. Each wave reads the project fresh and reports findings; the next wave starts from the last one.",
      "Auto runs campaigns back to back while a project has nothing else to do, up to the cycle limit you set, and stops as soon as a wave finds something to act on.",
      "The panel shows which project, which model, the current stage and how long it has been running; finished waves can be copied out.",
      "LIVE rows show how many waves are done of how many, and a blocked campaign is reported as blocked rather than counting as spare reserve.",
    ],
  },
];
