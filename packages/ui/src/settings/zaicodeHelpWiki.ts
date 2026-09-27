/* eslint-disable max-lines -- The ZAICODE encyclopedia: one article per Help topic, text only (SRC-060) */
import type { ZaicodeHelpTopicId } from "@/zaicode/zaicodeHelpTopics.js";

/**
 * The ZAICODE encyclopedia (SRC-060): "HELP must be the ZAICODE Wikipedia —
 * for beginners who want to meet AI agents; every element, every item: what,
 * why, what for". The Help cards (zaicodeHelpContent.ts) are the one-line
 * reference; each card opens its full article here: why it exists, how to use
 * it step by step, every control and word on it, and what to do when it does
 * not behave. Typed by topic id, so a topic without an article does not build.
 */

export interface HelpArticle {
  /** For someone who has never used an AI agent: what problem this solves. */
  why: string;
  /** How to use it, in order. */
  steps?: readonly string[];
  /** Every control, item and word on this surface: [name, what it does and why]. */
  terms?: readonly (readonly [string, string])[];
  /** [what you see, what to do]. */
  problems?: readonly (readonly [string, string])[];
  tips?: readonly string[];
}

export const ZAICODE_HELP_WIKI: Record<ZaicodeHelpTopicId, HelpArticle> = {
  start: {
    why: "An AI agent is a program that reads your project, runs commands and edits files for you, the way a helper would at your keyboard. ZAICODE gives every agent you have — free model pools and your paid subscriptions — one window, so you can start work, watch it and step in without juggling terminals.",
    steps: [
      "Add a project: the folder button above the project list, then pick the folder that holds your code or documents.",
      "Pick who works: click an engine tile at the top of the sidebar (SAIFREN costs nothing; A1, C1… are your own subscriptions).",
      "Press Ctrl+N (or New task), write what you want in normal words — 'add a dark theme', 'find why tests fail' — and send.",
      "Watch: the session title glows while the agent works; its todo list and the Changes counter show progress.",
      "When it asks something, the project turns 'waiting for you'; answer in the same box.",
      "Stuck anywhere? Point at the thing and press Shift+F1: Help opens at its explanation.",
    ],
    terms: [
      ["Project", "A folder on your disk that agents work in. Everything an agent does happens inside it."],
      ["Session", "One conversation with an agent inside a project, with its history. A project can have many."],
      ["Prompt", "What you write to the agent. Plain language works; say what, where and how you will check it."],
      ["Turn", "One round: you send, the agent works until it answers or stops. A turn can take seconds or an hour."],
      ["Engine", "What does the thinking: a model pool or a subscription. Picked with the tiles at the top."],
    ],
    tips: [
      "Start small: 'explain this project to me' is a safe first prompt that changes nothing.",
      "Almost everything can be right-clicked for its own settings.",
    ],
  },
  glossary: {
    why: "Words you will meet in ZAICODE, explained once, in plain terms. If a word on screen is not here, point at it and press Shift+F1.",
    terms: [
      ["Agent", "An AI program that can read files, run commands and edit code on its own, turn after turn, until the task is done or it needs you."],
      ["Project", "A folder on your disk that agents work in; the sidebar lists them."],
      ["Session", "One conversation with an agent inside a project, with its full history. Sessions keep going while you look at other ones."],
      ["Prompt", "What you write to the agent. Plain words work best: what you want, where, and how you will know it is right."],
      ["Model", "The AI brain behind an agent (for example a GPT, Claude, GLM or Gemini model). Bigger models think better and cost more."],
      ["Provider", "Who serves the model: a company API, a free pool, or your subscription."],
      ["Subscription", "A paid plan you already have (Claude, ChatGPT/Codex, Antigravity, Z.ai). ZAICODE uses its own login on your machine; nothing is shared."],
      ["Quota / limit", "How much a subscription lets you use in a window of time (5 hours, a week, a month). When it runs out, that engine waits."],
      ["Reset", "The moment a quota window refills. ZAICODE shows when each one resets and can start work right then."],
      ["Token", "The unit models read and write text in (roughly ¾ of a word). Quotas and statistics count tokens."],
      ["Reasoning effort", "How long a model thinks before answering (low … high, xhigh, max). More effort = better on hard problems, slower and pricier."],
      ["CLI", "Command-line program. Claude Code and Codex are CLIs; ZAICODE starts them for you as workers."],
      ["Worker", "A subscription CLI running inside a project on its own terminal, watched by ZAICODE."],
      ["SAIFREN / SAIOPP", "ZAICODE's own model pools behind a local router: SAIFREN free models, SAIOPP deeper-thinking ones. The router falls over to the next model when one fails."],
      ["SAIPEN", "A working method for agents: a project keeps a BOARD of tickets, a STATE and a LOG in its .saipen folder, so any agent can pick the work up where the last one left it."],
      ["Ticket", "One piece of work on a SAIPEN board, with how it will be checked."],
      ["MAIN session", "The one session per project that carries its SAIPEN work. START and CONTINUE ALL use it."],
      ["cc / goal cc all", "Short SAIPEN commands: 'cc' = continue the current work; '/goal cc all' = keep going until the board is done."],
      ["LIVE", "Projects with an agent working right now (or waiting for you). With LIVE on they float to the top of the list."],
      ["Slot", "A named group in the sidebar (MAIN0, MAIN1…, SIDE1…) to keep projects in order."],
      ["Queue / job", "Tasks waiting for an agent. A job is one task on the queue; the queue runs as many at once as Parallel allows."],
      ["Audit / wave", "An audit reads a project and lists what is wrong; it runs in waves (Core → Completeness → Performance), each a separate job."],
      ["Handoff", "The final list of next actions an audit leaves for whoever fixes the findings."],
      ["Changes", "Lines added (+) and removed (-) in the project since the last commit."],
      ["Commit", "A saved checkpoint of your project in Git. After a commit the Changes counter starts from zero."],
    ],
  },
  saipeggle: {
    why: "Agents often work for minutes at a time. SAIPEGGLE is a whole game for those minutes (the genre of Peggle Deluxe, drawn in ZAICODE's pixels and colours), so waiting is not staring.",
    steps: [
      "Open it: Settings → SAIPEGGLE (above Support Developer), this card (Open game), or type PEGGLE outside a text field.",
      "Aim with the mouse and click to fire. Clear every orange peg; the bucket at the bottom gives free balls.",
      "Green pegs give the stage master's power: Super Guide, Multiball, Pyramid, Space Blast, Spooky Ball, Fireball, Zen Ball or Lucky Spin.",
      "Hit the last orange peg for Extreme Fever and drop the ball into a 100K bucket.",
    ],
    terms: [
      ["Multiplier", "x2 / x3 / x5 / x10 as more orange pegs are hit; every peg is worth that much more."],
      ["Seed", "The text a random board is built from: the same seed, the same board."],
      ["Board code", "A SPG1.… text holding a whole board, to share it with anyone."],
      ["P / R / Esc", "Pause, retry the level, pause and then the menu."],
    ],
  },
  engines: {
    why: "Every AI you can use sits in one row of tiles, with how much quota each has left, so you pick the one that can work now instead of discovering it is out halfway through a task.",
    steps: [
      "Look at the bar under each tile: the more green, the more quota left.",
      "Click a tile: new prompts start it as a worker. To chat with a subscription account in ZAICODE itself, pick it in the model menu (account → model → effort).",
      "Double-click a tile: start it as a worker in the open project.",
      "A dashed tile with ! needs a sign-in or its CLI is missing: right-click → Fix shows exactly what it will run.",
    ],
    terms: [
      ["SAIFREN / SAIOPP", "In-app pools: free models / deep-thinking models, through the local router."],
      ["A1 A2 · C1 C2 C3 · AG · ZC", "Your accounts: Anthropic (Claude), Codex (ChatGPT), Antigravity (Google), ZCode. Found automatically on this machine."],
      ["Bar colour", "Green over 50% left, amber below, red under 20%, dark = out."],
      ["Glow", "A tile glows right after its quota window resets; hover says which window."],
      ["Right-click", "Start, read the quota now, fix sign-in, hide the tile."],
    ],
    problems: [
      ["A tile stays dark", "Its quota is spent; the card says when it resets. Use another tile or schedule the prompt (Scheduler)."],
      ["A subscription I have is missing", "Sign in with its own CLI once (claude, codex…), then right-click → Refresh; hidden tiles come back in Settings → Engines."],
    ],
  },
  meter: {
    why: "Paid plans have rolling limits that are easy to hit by surprise. The meter in the title bar shows every account's quota at a glance, and when each resets.",
    steps: [
      "Hover the meter: each window (5h, weekly…), percent left, reset time.",
      "Shift+Click reads every quota now (reading never spends quota).",
      "Right-click chooses which engines show and how bars look.",
    ],
    terms: [
      ["Window", "A quota period: 5 hours, a week, a month. A plan can have several; the tightest decides."],
      ["Stacked / Bars / Dots", "Three looks for the meter; Ctrl+Click cycles them."],
      ["Hide spent", "Hide accounts that have no quota left right now (a fresh account at 100% always shows)."],
      ["Glowing meter", "A prepared prompt (Scheduler) waits for this account's reset and will fire right after it."],
    ],
    problems: [["An account shows 'needs sign-in'", "Its CLI login expired; right-click the engine tile → Fix."]],
  },
  accounts: {
    why: "You pay for Codex, Claude or Antigravity subscriptions; this makes each of those accounts a normal model inside ZAICODE, so a chat uses exactly the account you picked, with its real effort, and you see how much it has left.",
    steps: [
      "Connect each account once in the 9router dashboard (Settings → Router → Subscriptions as models → Connect one).",
      "Open the model menu under the prompt box and pick the account (Codex 1, Claude 2 …).",
      "Pick the model under it, then the effort in the button next to the model.",
      "Watch the bar next to the account: green is plenty, yellow is getting low, red is almost out.",
    ],
    terms: [
      ["Account", "One login of a vendor. Codex 1 and Codex 2 are two different logins, numbered in the order you connected them in 9router."],
      ["Effort", "How hard the model thinks before it answers: low is fast and cheap, high (and xhigh on Codex) is slow and thorough."],
      ["Fuel", "When the account you picked is at its limit, 9router answers with the next account of the same vendor so the work continues."],
      ["Readiness bar", "What the account has left in its tightest window (5 hours, week …), read from the vendor through 9router."],
    ],
  },
  sessiontext: {
    why: "You read the agent's answers all day. This makes them read the way you like: a book-like serif, a Word document with blue numbered headings, a typewriter, a terminal, or just a bigger, calmer text.",
    steps: [
      "Open Settings → Session text.",
      "Try a preset first: Word document, Book, Typewriter, Terminal, Pixel, Highlighter, Large print or Compact.",
      "Then pick a part on the left and fine-tune it; the sample answer on the right changes as you click.",
      "Happy with it? Save as preset. Export sends your presets to a file you can import on another machine.",
    ],
    terms: [
      ["As app", "Not changed: the part keeps the look ZAICODE gives it."],
      ["Highlighter", "A colour behind the text, like a marker pen on paper."],
      ["Line spacing", "The distance between lines of a paragraph; 1.5 is Word's 1.5 lines."],
      ["Line length", "The widest a paragraph gets, in letters; shorter lines are easier to read."],
    ],
  },
  protrail: {
    why: "A visible cursor is easier to follow on big or several screens, in screen recordings and in demos, and it is simply nice. ProTrail draws it the way the stand-alone ProTrail app does, without a second program running.",
    steps: [
      "Open Settings → ProTrail.",
      "General: keep Everywhere in Windows, or pick Only inside ZAICODE. Try a colour preset.",
      "Trail: pick a style (Classic, Comet, Neon …), its thickness, lifetime and sparkles.",
      "Click: pick a click style (Ring, Burst, Fire, Water …), which buttons trigger it, and the hold effect.",
    ],
    terms: [
      ["Trail", "The fading line the cursor leaves behind as it moves."],
      ["Hold", "Keeping a mouse button down: an aura charges up, and the release plays a stronger effect."],
      ["Motion wake", "Shapes left behind while you drag with a button held down."],
      ["Click-through", "The effect layer never catches a click; the app under it gets every click as usual."],
    ],
  },
  workers: {
    why: "A worker is a subscription CLI (Claude Code, Codex…) running inside a project in its own terminal. WORKERS shows them all, so you can see who is running, who finished and who crashed.",
    steps: [
      "Start one: double-click an engine tile, or the project's … menu.",
      "Open WORKERS (menu or its hotkey) to see each worker's terminal, state and time.",
      "Stop, restart or open the terminal from its row.",
    ],
    terms: [
      ["Dock", "WORKERS can sit docked at a window edge or float; drag its header."],
      ["Working icon", "The spinner next to a working session or project; its picture and speed are yours (Highlights)."],
      ["Crashed", "The CLI exited with an error; the row keeps its last output so you can see why."],
    ],
  },
  saihome: {
    why: "SAIHOME answers 'what is going on?' in one screen: who is working, what needs you, what resets next, how much you used. Opening it starts nothing.",
    steps: [
      "Alt+H, the SAIHOME menu line, or the tray menu.",
      "Read Needs you first: each line says why, the impact and has one button.",
      "Click a project row for its SAIPEN state, then Go to project or Open MAIN session.",
    ],
    terms: [
      ["Now", "Working sessions and workers, the queue, today's tokens and runs, the next reset and schedule."],
      ["Activity", "One square per day, coloured by how much happened; arrow keys walk the days."],
      ["Presets", "EVERYTHING, MINIMAL, OPERATOR, STATS, FACTORY: which cards show; Edit layout for your own."],
    ],
  },
  header: {
    why: "The strip above the project list holds the buttons you use all the time: back / forward, jump to the next working session, show or hide the menu.",
    terms: [
      ["← →", "Back / forward through the places you visited, like a browser."],
      ["Focus next session", "Click = next working or waiting session; right-click = previous."],
      ["Project row buttons", "Hover a project: ◆ / ◇ switches 'this row is a session' (on: the row opens that session and the others are its children; off: a folder), ▶ START (continue it), … (more, new session)."],
      ["Clicking a project", "First click: go to the project (the row's session, or the new-task screen). Every next click only folds or unfolds its sessions -- it never jumps to another session."],
      ["✔ / ✔A3 after a name", "SAIPEN says the project is done and its board is clean (nothing open, blocked or parked). ✔A3: it changed since its last audit -- click to open the audit centre on it and plan an A3 wave. A3 x/y: an audit is planned (quiet) or running (bright)."],
      ["Shift+Click a project", "Switch it off: dimmed, marked OFF, no automatic agent or schedule touches it."],
      ["Ctrl+Click a project", "Send it down to another slot."],
      ["Working meter", "One cell per working session, from black (just started) to green (almost done)."],
    ],
    tips: ["Right-click the header to choose which buttons it shows."],
  },
  sidebar: {
    why: "The project list is your desk: every project, grouped in slots, with what is running in each. LIVE pulls the busy ones up so you always see what moves.",
    steps: [
      "Drag projects to order them; Shift+drag and hold 2 s opens the SLOTS panel.",
      "Turn LIVE on (right-click the list or Settings → Sidebar): working projects float to the top.",
      "Want finished ones to stay up instead of dropping back? Turn on Remain in position.",
    ],
    terms: [
      ["Slots (MAIN0 … SIDE3)", "Named groups; a project sits in one. Fold a slot by clicking its header."],
      ["LIVE", "Projects with a working (or waiting) session come first, most recent on top by default."],
      ["Stay LIVE for", "A grace period: a project keeps its place this long after its work ends, so rows do not jump while you look."],
      ["Remain in position", "A project that has been live keeps its LIVE rank for good, instead of returning to its manual place."],
      ["A3 n/m", "Audit waves done of planned for that project (Audits)."],
      ["OFF", "The project is switched off (Shift+Click to toggle)."],
      ["Freshness dot", "How recently something happened in the project."],
    ],
    problems: [
      ["A project jumps around", "That is LIVE ordering. Raise 'Stay LIVE for', turn on Remain in position, or switch LIVE off."],
    ],
  },
  continue: {
    why: "With many projects, opening each one to say 'continue' wastes time. CONTINUE ALL and Auto keep every project moving, and DONE walks you through what finished.",
    steps: [
      "Hover CONTINUE ALL to see the plan before anything is sent.",
      "Click it: stopped goals restart, failed turns continue, SAIPEN projects with open tickets continue their MAIN.",
      "Turn Auto on to have this happen by itself until each project says there is nothing left to do.",
      "Press DONE (Alt+Right) to open the oldest finished session you have not seen yet.",
    ],
    terms: [
      ["Auto", "Keeps pushing projects to the end of their todo lists; when a project is truly done it can audit itself (Audits → Automatic)."],
      ["Manual Stop", "If you press Stop in a session, Auto leaves that session alone until you continue it yourself."],
      ["▶ on a session row / Alt+Click", "Continue that one session without opening it."],
    ],
  },
  zaicode: {
    why: "The ZAICODE page runs several agents on a queue of tasks in parallel, like a small team: you describe tasks, pick who does them, and watch results come in.",
    steps: [
      "Agents (left): add one, or press Teams for a ready-made set.",
      "Tasks (middle): write a task, pick an agent, Add. Autopilot on starts it at once.",
      "Results (right, Inspector): what ran, on which model, the result, Open session.",
      "▶ Tour walks you over the real screen once.",
    ],
    terms: [
      ["Hit & go", "One click: tell this project to keep going (cc all) in its MAIN session, or through an Autopilot agent."],
      ["Autopilot", "On = queued tasks start by themselves; off = you start each one."],
      ["Parallel", "How many tasks may run at the same time."],
      ["Configured vs actual model", "What the agent was set to use, and what really ran (a pool may fall over to another model)."],
    ],
  },
  timers: {
    why: "Quota resets, breaks and reminders at the right minute, without another app: ZAICODE carries FastPrompter's timers.",
    steps: [
      "Click the title-bar clock to open Alarms.",
      "Type a time (7, 0730 or 07:30) and press Enter to add an alarm.",
      "Shift+Click the clock adds minutes to a quick Temp Timer; Ctrl+Click starts / pauses Productivity.",
    ],
    terms: [
      ["Alarm", "Once, daily, weekdays, weekly, monthly, yearly or every N minutes; own sound and colour."],
      ["Interval reminder", "A sound every N minutes, on the clock or after the last one."],
      ["Heat colour", "The nearest timer's colour on the clock: blue far away → red close."],
    ],
  },
  notifications: {
    why: "Agents finish, ask and fail while you look elsewhere. Notifications tell you, each kind in its own way, and can be quiet at night.",
    terms: [
      ["Card", "The small notice in a corner; how long it stays is per kind."],
      ["Windows notification", "Also show it in Windows' own notification area."],
      ["Glow", "The thing that changed stays highlighted for the minutes you choose."],
      ["Quiet hours", "No cards (and optionally no sounds) in the hours you pick."],
    ],
  },
  sounds: {
    why: "Sound tells you what happened without looking: a turn finished, a question arrived, a quota reset. Every action has its own row, and the Orchestra section gives every kind of control its own voice.",
    steps: [
      "Settings → Sounds: tick a row on or off, pick its sound, set its volume in dB against the master.",
      "Use 'all on' / 'all off' on a section header to switch a whole group.",
      "Import your own WAV / MP3 / OGG for any row.",
    ],
    terms: [
      ["Master volume", "Everything's level; each row adds or removes decibels on top."],
      ["Overlay / replace", "Overlay lets the same sound stack; replace stops the previous one first."],
      ["Orchestra", "Tabs, menu items, tick boxes (on and off differ), sliders, links, fold / unfold, windows opening and closing, disabled controls, paste, notices; Esc, hover and typing are optional."],
      ["Echo", "A sound caused by your own click right before (a window your click opened) stays silent, so one action makes one sound."],
      ["Problip", "A short cue on an interval, to keep a rhythm in long sessions."],
      ["Ambience", "A quiet background loop only while agents work."],
    ],
    problems: [
      ["Too many sounds", "Turn the Orchestra section 'all off', or lower the master volume."],
      ["No sound at all", "Check Muted and 'Play while ZAICODE is focused', and Windows' own volume mixer."],
    ],
  },
  hotkeys: {
    why: "Keys are faster than the mouse for things you do fifty times a day. Every ZAICODE action can have two combinations.",
    terms: [
      ["Global", "Works anywhere in Windows, even when ZAICODE is not in front."],
      ["In-app", "Works only while ZAICODE is focused."],
      ["F1 / Shift+F1", "Help / Help for the thing under the pointer."],
      ["F-keys", "Can jump to recent sessions or to projects."],
      ["Bind", "Press it, then the combination you want; Esc cancels, Backspace clears."],
    ],
  },
  memory: {
    why: "Without memory, every new session starts knowing nothing about your project's habits. Memory keeps small facts ('tests run with pnpm test') and gives them to the next sessions.",
    terms: [
      ["Fact", "One short note saved as its own file; you can read and delete each one."],
      ["'remember that …'", "Say it in a prompt to save a fact on purpose."],
    ],
    problems: [["The agent insists on something wrong", "Settings → Memory: find the fact and remove it."]],
  },
  home: {
    why: "The empty new-session screen is the first thing you see before writing a task; you decide what it shows.",
    terms: [["Welcome text", "By time of day, or your own words, only in the hours you pick."]],
  },
  saimail: {
    why: "SAIMAIL is a mailbox folder where agents leave you letters (reports, questions) and you leave them instructions, so long-running work can talk to you asynchronously.",
    terms: [
      ["Envelope", "Title bar; shows unread letters, hover lists them."],
      ["Click", "Asks the agent to read the desk; it drafts replies and never sends by itself."],
    ],
  },
  autostart: {
    why: "Quotas refill while you sleep. Autostart starts an engine in a project at a time you choose, or right when its quota refills, so no window is wasted.",
    terms: [
      ["When", "Once, daily, every N minutes, or on a quota refill."],
      ["Missed", "If ZAICODE was closed at that moment, the run is reported, not launched late."],
    ],
  },
  zones: {
    why: "Put the ZAICODE window into a part of the screen with one key, like Windows PowerToys FancyZones.",
    terms: [["Ctrl+Q", "Opens the zone picker; pick a zone and the window snaps there."]],
  },
  dispatch: {
    why: "Sometimes you just need a terminal, or a vendor's own CLI, in a project. Dispatch opens one there, without finding the folder by hand.",
    steps: ["Alt+D.", "Pick the project.", "Pick a plain terminal or a vendor CLI."],
  },
  scheduler: {
    why: "Write a repeating job once — 'every morning, update dependencies' — and let it fire on a schedule, or the moment a quota refills.",
    steps: [
      "Open SCHEDULER, add a job: project, prompt, trigger, which agent / subscription.",
      "Check the next run time in the list.",
      "A waiting prompt glows around its limit meter until it fires.",
    ],
    terms: [
      ["Trigger", "A time, an interval, or a quota reset."],
      ["Destination", "Which subscription gets the prompt, and what happens when it is busy."],
    ],
  },
  search: {
    why: "One box that finds anything — a project, a session, a setting, a command — so you do not have to remember where it lives.",
    tips: ["Type part of a name; Enter goes there."],
  },
  plugins: {
    why: "Plugins add abilities to the app itself. The marketplace installs, updates and removes them in one place; a plugin never touches your projects.",
  },
  settings: {
    why: "Every preference, grouped by what it changes. Right-clicking a control is usually the shortest way to its own settings.",
    terms: [
      ["Profile", "A named set of your preferences; switching profiles switches sounds and pictures too."],
      ["Next start", "Some settings (splash, window) apply after a restart and say so."],
    ],
  },
  composer: {
    why: "The composer is where you talk to an agent: what you write, which model answers, and what it is doing now.",
    steps: [
      "Write the task; mention files or paste images if the engine accepts them.",
      "Pick the model and effort above the box when it matters.",
      "Send; watch the spinner and 'working for' timer; Stop ends the turn.",
    ],
    terms: [
      ["Working for", "How long the agent has worked on this turn (not how long the session exists)."],
      ["Todo list", "The agent's own plan; ticks as steps finish."],
      ["Retry", "After an error ZAICODE can retry the turn by itself after a countdown (Settings → Workers)."],
    ],
    problems: [
      ["'Turn failed'", "The model returned an error (limit, network). Wait for auto-retry, press Retry now, or switch engine."],
    ],
  },
  changes: {
    why: "The Changes counter says how much the agent changed: +lines added, -lines removed since your last commit. The RPG numbers make each change visible as it happens: green +N rises like healing, red -N flies off like damage.",
    steps: [
      "Watch the Changes chip above the composer while an agent works.",
      "Click it to open the review of the changed files.",
      "Settings → Highlights & motion → Change numbers to style the numbers, or switch them off.",
    ],
    terms: [
      ["+N (heal)", "Lines added since the last reading."],
      ["-N (damage)", "Lines removed since the last reading."],
      ["Critical hit", "A burst of at least the threshold (default 100 lines): bigger, with '!'."],
      ["Merge window", "Changes within this time add up to one number instead of many small ones."],
      ["Style", "Rise, Pop, Drift or Arcade."],
    ],
    problems: [["The counter went to 0", "A commit happened: Changes counts since the last commit."]],
  },
  splash: {
    why: "The start-up picture appears the moment ZAICODE starts and stays until the app is really ready, so you never look at a grey half-loaded window.",
    steps: [
      "Settings → ZAICODE → Start-up splash.",
      "Pick picture… for your own (PNG, JPEG, GIF, WebP, BMP, any size).",
      "Choose how it fills the box (whole picture / fill and crop / stretch) and the size.",
      "Leave 'Keep the splash until ZAICODE is fully loaded' on for a clean start.",
    ],
    terms: [
      ["Whole picture", "Nothing is cut; free space gets the dark background."],
      ["Fill, crop edges", "The picture fills the box; what sticks out is trimmed evenly."],
      ["Longest wait", "After this, the app shows even if it is still loading."],
      ["Loading line", "What ZAICODE is doing and its version, at the bottom."],
    ],
    problems: [["Changes did nothing", "Splash settings apply on the next start."]],
  },
  todo: {
    why: "The todo dock shows the open session's plan: what the agent intends to do and what is done.",
    terms: [
      ["Docked / free", "Stick it to the window edge or drag it anywhere; it stays inside the window when you resize."],
      ["Tick", "A finished step; plays the Todo done sound."],
    ],
  },
  audit: {
    why: "An audit is a second pair of eyes: an Auditor agent reads the whole project and writes down what is wrong, in three passes, so problems a single pass misses are found before they bite.",
    steps: [
      "Open the ZAICODE page → Audits.",
      "Tick the projects to audit (or 'only this one').",
      "Press START. Each audit runs as queue jobs beside your other work.",
      "Watch 'Now': the waves (done ✓, running ●), time per wave and total, which model, and the session it runs in.",
      "When it finishes, Copy handoff gives you the list of next actions.",
    ],
    terms: [
      ["Wave 1 — Core correctness", "Real defects: broken logic, wrong edge cases, lost errors, data loss."],
      ["Wave 2 — Completeness", "What the project promises but does not do yet; half-wired features."],
      ["Wave 3 — Performance", "Leaks, needless work, things that grow without end; writes the combined handoff."],
      ["Auditor", "The agent that runs the waves; change its model in Agents & tasks."],
      ["Last sign of life", "How long the running wave has been silent: quiet after 3 minutes, stalled after 10."],
      ["Plan only", "Create the audit without running it; press Start on it later."],
      ["Automatic audits", "When a project's SAIPEN board is empty and nothing runs, it audits itself; an implementer fixes the findings; it audits again — until an audit finds nothing or the limit is reached."],
    ],
    problems: [
      ["An audit is 'stopped'", "A wave failed or its report missed the STATUS line. Open its report or session, then cancel and start again."],
      ["Stalled for many minutes", "Open its session to see what it is doing; cancel if it is stuck."],
    ],
  },
};
