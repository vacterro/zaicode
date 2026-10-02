import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import { openZaicodeWorkersPanel } from "@/zaicode/zaicodeWorkers.js";
import { useZaicodeTimers } from "@/zaicode/zaicodeTimerStore.js";
import { openZaicodeSaipeggle } from "@/zaicode/saipeggle/ZaicodeSaipeggleView.js";
import { openZaicodeUsage } from "@/zaicode/zaicodeUsage.js";
import type { HelpTopic } from "./zaicodeHelpContent.js";

// Split in two only because a single file of this size trips the 400-line lint
// ceiling. Where a topic physically lives says nothing about when it is read:
// ZAICODE_HELP_CURRICULUM (zaicodeHelpOrder.ts) decides that.

export const ZAICODE_HELP_TOPICS_CORE: readonly HelpTopic[] = [
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
    id: "glossary",
    title: "Words for beginners",
    what: "Agent, model, session, quota, reset, worker, SAIPEN, LIVE… — every word ZAICODE uses, in plain terms.",
    lines: [
      "Open the full explanation below for the whole list.",
      "Pointing at something and pressing Shift+F1 opens the card that explains it.",
    ],
  },
  {
    id: "saipeggle",
    title: "SAIPEGGLE (the pixel game)",
    what: "A complete Peggle-style game for the minutes an agent works: a cannon, pegs, a bucket, an adventure of 55 levels with 8 masters, Extreme Fever.",
    lines: [
      "Aim with the mouse, click or Space to fire; hit every orange peg before the balls run out. Green pegs give the stage master's power.",
      "Levels: the adventure (a level opens when the one before is cleared), Quick Play from any seed, and board codes you can copy and paste.",
      "Settings: balls, orange and green pegs, gravity, bounce, bucket speed, peg density, colours from your palette, fever, effects. Sounds: Settings → Sounds → SAIPEGGLE.",
      "Settings (left column) → SAIPEGGLE above Support Developer opens it; the gear next to it opens its settings. Typing PEGGLE outside a text field works too. Esc pauses, Esc again opens the menu; Exit returns to ZAICODE.",
    ],
    open: { label: "game", run: () => openZaicodeSaipeggle() },
  },
  {
    id: "engines",
    title: "Engines (sidebar top)",
    what: "Everything that can do work for you, picked with one click.",
    lines: [
      "SAIFREN / SAIOPP — in-app model pools (free / deep thinking). Click = new sessions use it.",
      "A1 A2 · C1 C2 C3 · AG · ZC — your Claude, Codex, Antigravity and ZCode logins, found automatically.",
      "Bar under a tile — quota left: green > 50%, amber, red < 20%, dark = out. Background tint says the same (strength in Engines & limits).",
      "Click a tile = START and new prompts start it as a worker in this project · double-click = start a worker at once · right-click = start, read quota, fix sign-in, hide. To chat with a subscription account inside ZAICODE, pick it in the model menu under the prompt box (account → model → effort).",
      "Dashed tile with ! — needs sign-in or the CLI is missing; right-click → Fix shows the exact command first.",
      "A tile glows after its quota window resets; the card says which window. Reset credits (Codex grants them, the ZCode Coding Plan too) show as ⟲ next to the reset timer and in Engines & limits, with a button that uses one after asking; Claude Code has none.",
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
    id: "usage",
    title: "Usage (9router)",
    what: "Requests, tokens and estimated costs across every client using your local 9router.",
    lines: [
      "Usage in the header or footer opens the full page; right-click or Ctrl+Alt+B opens it beside the chat.",
      "Pick today, 24 hours, 7 days, 30 days, 60 days or all time. The trend switches between tokens and estimated cost.",
      "Recent requests, Models, Providers and Accounts explain where the traffic goes. Requests from external tools are included too.",
      "Live refresh reads every 10 seconds while this view is visible; closing it stops refresh. Dashboard opens the original 9router Usage page.",
    ],
    open: { label: "Usage", run: () => openZaicodeUsage() },
  },
  {
    id: "accounts",
    title: "Subscriptions as models (Codex 1, Claude 2 …)",
    what: "Every subscription account connected in 9router is its own entry in the model menu: pick the account, then the model, then the effort.",
    lines: [
      "Open the model menu under the prompt box: next to SAIRoute you see Codex 1, Codex 2, Claude 1, Antigravity … Each has that vendor's models.",
      "The bar next to an account is what it has left (the tightest window: 5 hours, week …). Hover it for the numbers and the reset time.",
      "The effort next to the model is real: it goes to the vendor as its own reasoning setting (Codex reasoning effort, Claude thinking budget, Gemini thinking level).",
      "New accounts and models show up by themselves, retired ones leave: at start, every 10 minutes and whenever you open the model menu.",
      "When the picked account is at its limit, the next account of the same vendor answers instead, so the work does not stop.",
      "Connect accounts once in the 9router dashboard (Settings → Router → Subscriptions as models → Connect one). Sync now there if you are in a hurry.",
    ],
    open: { label: "Router → Subscriptions", section: "zaicodeRouter" },
  },
  {
    id: "sessiontext",
    title: "Session text (how answers read)",
    what: "Word-like styles for the agent's answers: the text, every heading, bold, italics, underlines, links, code in the text, quotes, lists, tables and the divider line.",
    lines: [
      "Settings → Session text. Pick a part on the left (Text, Heading 1 …), change it in the middle, watch the sample answer on the right.",
      'Every value starts at "as app": it keeps the ZAICODE look until you change it.',
      "Underline: none, a line, dotted, dashed, double or wavy, in its own colour, thickness and distance from the text.",
      "Headings can have a line under or over them, a frame, a bar on the left or a shaded band, and Word-like numbers 1. / 1.1 / 1.1.1.",
      "Presets apply a whole look in one click (Word document, Book, Typewriter, Terminal, Pixel, Highlighter, Large print, Compact); save your own, export and import them as a file.",
      "It applies at once in every open session. Off switch at the top: back to the app's look without losing anything.",
    ],
    open: { label: "Session text", section: "zaicodeSessionText" },
  },
  {
    id: "protrail",
    title: "ProTrail (cursor trail and clicks)",
    what: "ProTrail built into ZAICODE: a trail behind the mouse cursor and an effect on every click, over the whole Windows desktop or only inside ZAICODE.",
    lines: [
      "Settings → ProTrail. General: on/off, where it draws, colour presets, pixel look. Trail and Click: every ProTrail setting.",
      "Everywhere in Windows (default): one see-through layer per monitor, over every app. Clicks always go to the app under the cursor.",
      "The first start compiles a tiny mouse reader with Windows' own C# compiler (a second or two, once). Without it the trail still follows the cursor, but clicks are not seen; the status line says which.",
      "Press and hold a button: a charging aura; release it for a bigger effect. Drag while holding: the motion wake.",
      "Quick switch: the ProTrail button in the sidebar footer (left click on/off, right click opens these settings).",
    ],
    open: { label: "ProTrail", section: "zaicodeProtrail" },
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
      "Needs you — only problems, each with why, impact and one button (router down, sign-in needed, blocked project, missed schedule…). The router counts as degraded only when a real share of its providers (a quarter, at least 3) failed in the last hour, or SAIFREN has no model; 9router keeps a provider's last error until it next works, so older errors are history, amber with their date under Router → Providers & keys.",
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
      "Project row — a click goes to the project (its MAIN session when the row is a session, else the new-task screen); clicking again only folds or unfolds its sessions. Hover shows ◆ / ◇, ▶ START and … (new session, files, slots); the name never moves. ◆ is a switch: on, the row IS a session and the others are its children; off (◇), the row is a folder. Shift+Click switches a project off (dimmed, OFF: no automatic agent or schedule works there) and on again; Ctrl+Click sends it down a slot.",
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
      "Your sounds, pools, presets — WAV, MP3 or OGG files dropped into customization\\sounds (the page shows the path) appear under “Mine” in every picker at once; the 1 / N cell makes a row a pool you fill under “Add sounds to the pool…”; Presets (top right) save and share a page, exports land in customization\\presets.",
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
];
