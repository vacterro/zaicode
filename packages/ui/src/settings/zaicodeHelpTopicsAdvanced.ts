import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import { openZaicodeWorkersPanel } from "@/zaicode/zaicodeWorkers.js";
import { useZaicodeTimers } from "@/zaicode/zaicodeTimerStore.js";
import { openZaicodeSaipeggle } from "@/zaicode/saipeggle/ZaicodeSaipeggleView.js";
import type { HelpTopic } from "./zaicodeHelpContent.js";


export const ZAICODE_HELP_TOPICS_ADVANCED: readonly HelpTopic[] = [
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
      "Click opens the letter reader: each letter shows its header, and only your Open/Reopen click decrypts the body. Closing the reader forgets the text. Right-click for its options.",
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
    id: "sidebar",
    title: "Project list, slots and LIVE",
    what: "Every project, grouped in slots, with what runs in each; LIVE pulls the busy ones up.",
    lines: [
      "Drag to order; Shift+drag and hold 2 s opens the SLOTS panel; click a slot header to fold it.",
      "LIVE — working (or waiting) projects come first; Stay LIVE for — how long they keep that place after the work ends.",
      "Remain in position — a project that has been live keeps its LIVE rank instead of dropping back.",
      "A3 n/m — audit waves done of planned; OFF — switched off (Shift+Click).",
      "Footer — right-click it: the profile as avatar and name or the avatar alone, and your buttons next to it (Problip, ProTrail, Timers, Help …) in your order.",
    ],
    open: { label: "Sidebar", section: "zaicodeSidebar" },
  },
  {
    id: "changes",
    title: "Changes counter and RPG numbers",
    what: "+lines added / -lines removed since the last commit; each change can float up like healing or damage in a game.",
    lines: [
      "Green +N rises when lines are added, red -N flies off when lines are removed; a big burst is a critical hit.",
      "Click the counter to review the changed files.",
      "Style, size, time, colours, sound and the critical threshold are in Highlights & motion → Change numbers.",
    ],
    open: { label: "Highlights & motion", section: "zaicodeLights" },
  },
  {
    id: "splash",
    title: "Start-up splash",
    what: "The picture shown from the first moment until ZAICODE is fully loaded — no grey window in between.",
    lines: [
      "Your own picture of any size; whole picture, fill and crop, or stretch; 1x, 1.5x or 2x.",
      "Keep until fully loaded (with a longest wait), loading line on or off. Applies on the next start.",
    ],
    open: { label: "ZAICODE settings", section: "zaicode" },
  },
  {
    id: "todo",
    title: "Todo dock",
    what: "The open session's plan: what the agent will do and what is done.",
    lines: ["Dock it to an edge or drag it anywhere; it stays inside the window when you resize."],
  },
  {
    id: "audit",
    title: "Audits (A3 waves)",
    what: "Repeated review waves over a project, run on a model of your choice, to find what a single pass misses.",
    lines: [
      "An A3 campaign is waves. Each wave reads the project fresh and reports findings; the next wave starts from the last one.",
      "Automatic audits run while a project has nothing else to do: audit, an implementer fixes the findings, audit again — up to the limit you set, and they stop as soon as an audit finds nothing to act on.",
      "The panel shows which project, which model, the current stage and how long it has been running; finished waves can be copied out.",
      "LIVE rows show how many waves are done of how many, and a blocked campaign is reported as blocked rather than counting as spare reserve.",
    ],
  },
];
