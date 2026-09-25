# T-51 evidence -- SRC-038: subscriptions as chat (SUBCHAT)

Operator's words (SRC-038, line 22): "use these subscriptions as in an ordinary
chat, without any WORKERS at all, fewer middlemen and rough edges, like a chat,
not a terminal". Line 30: several Claude / Codex subscriptions without problems.

Ticket verify: a subscription tile/pick sends the next chat turn through that
subscription in-app (no worker), shown by a real turn or a transport test;
multiple accounts listed and selectable.

## What was built

| Item | Where |
|---|---|
| Who can chat, exact invocation, both stream parsers, transcript reducer, stored-chat normalizer | `zcode/packages/shared/src/zaicode-subchat.ts` |
| Process transport (stdin prompt, line split, parse, one final result, Stop) | `zcode/packages/desktop/src/main/zaicodeSubchatProcess.ts` |
| Main half: account lookup from main's engines state, IPC, stop on window close / quit | `zcode/packages/desktop/src/main/zaicodeSubchat.ts`, `desktopMainIpcPlatform.ts`, `preload/index.ts`, `shared/src/channels.ts`, `platform.ts` |
| Renderer store (chats, turns, persistence) | `zcode/packages/ui/src/zaicode/subchat/zaicodeSubchatStore.ts` |
| SUBCHAT view (login tiles, chat list, transcript, composer, Stop / Delete) | `zcode/packages/ui/src/zaicode/subchat/ZaicodeSubchatView.tsx` |
| Composer + START for a picked tile -> SUBCHAT (or worker) | `zaicode/subchat/zaicodeSubscriptionRoute.ts`, `prompt-editor/ChatPromptEditor.tsx`, `prompt-editor/ZaicodeSaipenControls.tsx` |
| Main view `subchat`, SUBCHAT menu line, Help topic, sounds, setting | `app-shell/types.ts`, `WorkspaceShellLayout.tsx`, `zaicodeLayoutPrefs.ts`, `ZaicodeSidebarNavBlock.tsx`, `ZaicodeHelpSection.tsx`, `zaicodeSoundEvents.ts`, `shared/src/zaicode-engines.ts` (`subscriptionPrompts`, default `chat`), `ZaicodeEnginesSettings.tsx` |
| Docs | `UI.md` "SUBCHAT (T-51)", `docs/ZAICODE_IMPLEMENTATION.md` section 27, `docs/ZAICODE_UPSTREAM_DELTA.md` (T-51 rows), KNOWLEDGE D-12 |

Operator words -> behaviour:

- "like an ordinary chat, no WORKERS": the prompt for a picked Claude / Codex
  tile opens SUBCHAT; no worker record, no PTY, no terminal window; the answer
  renders as markdown, tool use as one line each.
- "fewer middlemen": the vendor's own CLI answers directly (no proxy, no
  router); the next prompt resumes the same vendor session.
- "several claude / codex subscriptions": every discovered login (A1, A2, C1,
  C2, C3 on this machine) is a tile in SUBCHAT; each chat keeps its account
  (its own `CLAUDE_CONFIG_DIR` / `CODEX_HOME`); chats run side by side.

## Real turns (2026-09-25, this machine, through `startZaicodeSubchatProcess`)

Smoke script: scratchpad `smoke-subchat.mts` (the shipped invocation + process
module, the real CLIs).

- Claude A2 (`C:\Users\vac34\.claude-account2`): turn 1 "Reply with exactly
  PONG" -> events session `ff47a13e-…`, model `claude-opus-5-5`, text `PONG`,
  usage 23 421 in / 5 out, result ok (4.0 s). Turn 2 with `--resume ff47a13e-…`
  "What single word did you just reply with?" -> same session id, text `PONG`,
  result ok (4.0 s). Resume proven.
- Claude A1 (`~/.claude`, default home): session `ad2440f7-…`, text + result
  "You've hit your session limit · resets 10pm (Europe/Tallinn)" -> ok=false.
  Different account, different answer: the homes are separate.
- Codex C1 / C2 / C3 (`~/.codex`, `~/.codex-account2`, `~/.codex-account3free`):
  each `thread.started` -> session id, then `error` + `turn.failed` "You've hit
  your usage limit … try again at Sep 30th, 2026 2:21 AM" / "… Oct 25th, 2026
  2:14 AM" -> ok=false. All three Codex logins are out of quota today, so no
  Codex answer text was possible; the real stream shape (thread.started /
  turn.started / error / turn.failed) matched the parser.

Found by the real runs and fixed: a failed turn was shown twice (Claude: text
and result; Codex: error and turn.failed) -> shown once as an error; vendor
error text was cut at 160 characters, losing the reset time -> 600; a Node CLI
crash reported "Node.js v24.x" as its reason -> the line before it.

## Gates (2026-09-25, from `zcode/`)

- UI `node --import tsx --test test/zaicode*.test.ts` (packages/ui): 207/207
  (new `zaicodeSubchat.test.ts` 9; `zaicodeWave35` / `zaicodeWave50` menu
  oracles now expect SUBCHAT after New task).
- Desktop `node --import tsx --test test/zaicode*.test.ts` (packages/desktop):
  43/43 (new `zaicodeSubchatProcess.test.ts` 5: stdin prompt with quotes /
  pipes / `%PATH%` / unicode arrives intact, CODEX_HOME per account, a split
  JSON line is joined, resume id reaches the CLI, crash -> last stderr line
  once, Stop -> "Stopped." once, missing executable -> failed result).
- Services `node --import tsx --test test/zaicode*.test.ts`: 30/30.
- `pnpm typecheck` (tsc -b set): EXIT 0; `tsc --noEmit -p packages/ui/tsconfig.json`: EXIT 0.
  Desktop `tsconfig.main.json` / `tsconfig.preload.json` (not in the gate)
  carry 83 / 3 older errors, none in a T-51 file.
- `pnpm lint` (oxlint, 2850 files): 0 errors, 72 warnings (baseline).
- `pnpm architecture:check --changed`: OK, violations 0, new 0.

Red control: Codex resume without the session id argument -> UI
`Codex turn: exec --json, resume <id>…` and desktop `the next turn resumes
the vendor session it was given` fail (1 each); restored -> 9/9 and 5/5.

## MANUAL-VERIFY (operator, after the staged build swaps in)

1. Close and reopen ZAICODE. Sidebar menu: SUBCHAT under New task.
2. SUBCHAT -> click A2 -> type "say hi" -> Enter: "A2 is answering…", then
   the answer; no WORKERS panel, no terminal window.
3. Send "what did I ask?": the same chat continues (same session).
4. Pick C1 on the sidebar tiles, type a prompt in the normal composer: SUBCHAT
   opens with C1 (today the limit error shows once, with the reset time).
5. Settings -> Engines & limits -> Workers: switch "Prompts for a picked
   subscription open a SUBCHAT" off -> the same prompt starts a worker again.
