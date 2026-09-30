# T-136 -- full access by default, rolling 5h windows, token economy, live project badge (SRC-100)

Operator (2026-09-30, Russian), five asks in one message:

1. "Sometimes it does not show that a project is working until you switch to it."
2. "Maximum optimisation of token and model use, the best price/quality, set up under the hood from the start."
3. "If ZAICODE detects '5h limit starts at first use', start that window automatically so the 5 hours keep
   rolling instead of waiting for the user; spend next to nothing (10 tokens or so)."
4. "Remove approvals entirely: ZAICODE is FULL ACCESS YOLO by default" (screenshot: a "Permission required"
   card for `saipen.cmd continue --json` with Allow / Always allow / Full access / Deny).
5. "What is 'Task output exec_... Wait timed out / Fetching output' that can hang for up to 15 minutes?"

## SCOUT (zcode 1677486..bf0d64d = T-134 tree)

### 4. Approvals

- New drafts already default to `yolo` in ZAICODE (`draftWorkspaceDefaults.ts`, `newTaskDraft.ts`).
- But a session keeps the mode it was stored with. Old sessions, imported sessions, the task-index syncer
  (`mode: "build"`), and the CLI runtime itself (`runtime.config.mode ?? "build"`) all fall back to
  `build` = "Ask before changes". The operator's card offers "3. Full access", so that session was in
  `build`: `PermissionService.checkPermission` only passes everything through when `mode === "yolo"`.
- `alwaysAsk` tools (CreateWorkflow / AmendWorkflow / SaveWorkflow) ask even in yolo.
- Plan: the permission decision itself makes ZAICODE full access. In ZAICODE product mode any non-plan
  mode (build, edit, autoEdit, absent) is decided as yolo, and alwaysAsk confirmations pass as well.
  Kept: plan mode (the operator's own choice), questions to the user (`requiresUserInteraction`), the
  self-kill guard. Opt-out `ZAICODE_PERMISSION_PROMPTS=on` restores upstream prompts. The composer shows
  Full access for a session stored as build/edit and offers no "ask" modes in ZAICODE.

### 5. "Task output exec_..."

- It is the `TaskOutput` tool: the agent started a shell command in the background (`exec_...` is the
  background task id) and then waits for it with `block: true`. One wait may last up to 600 000 ms
  (`TaskOutputInputSchema.timeout.max`); "Wait timed out" is a wait that ended while the command still
  ran; the model then waits again. 10 min + 5 min = the 15 minutes the operator saw. The card showed only
  the opaque id, not the command.
- The tool's own description says the agent gets a `<task-notification>` when the task ends, so a long
  blocking wait is never needed.
- Plan (ZAICODE only): one wait is capped at 120 s and ends after 60 s without new output; the result
  tells the model the command still runs, how long it was silent, that a notification will come and
  that TaskStop ends a hung command. The card names the command instead of the id and says
  "Waiting for background command".

### 1. Project badge only after switching

- The project row counts working sessions from its task list (`useWorkspaceTaskLists`).
- `pendingConfigs` refreshes only the active project while the active project has a stale query
  ("cold start: current workspace first"). A running session in the active project marks it stale again
  on every sessions-index change, so the other projects' stale lists are never refreshed: their running
  badge appears only when the operator switches to them. Starvation, not a missing event.
- Plan: the active-first rule applies only while the active project has never loaded (its real purpose,
  cold start); a stale active project refreshes together with the other stale ones.

### 3. Rolling 5h windows

- The engines reader already marks a window that has not started (`startsOnUse`, SRC-048: the vendor puts
  the reset a full window after the read).
- Plan: `keepWindowsRolling` (engines config, default on). After a read that finds a not-started window
  on a ready, visible Claude or Codex account, ZAICODE sends the smallest request that account's CLI can
  make, then reads the account again:
  Claude `claude -p ok --model haiku --tools "" --system-prompt <one line> --no-session-persistence`,
  Codex `codex exec --ephemeral --skip-git-repo-check -s read-only -c model_reasoning_effort=low`.
  At most one start per account per 15 minutes; a failed start waits an hour. Antigravity and ZCode's
  plan are not started (no minimal request path known; recorded, not guessed).

### 2. Token economy

- Already in place: prompt caching (ephemeral cache control), 9router Token Saver (RTK + Caveman lite,
  SRC-061), microcompact of old tool results, low reasoning for auxiliary calls (titles, memory).
- Gap: auto-compact fires only near the model's full context window. On a 1M-token model a session
  re-sends up to ~950k tokens on every step before it compacts: the largest cost driver and a quality
  loss (long-context recall). Plan: in ZAICODE the compaction window is capped at 200k tokens
  (`ZAICODE_COMPACT_CONTEXT_TOKENS`, 0 = model window); microcompact follows the same cap.
- TaskOutput waits (above) stop burning wall time; nothing re-polls in a tight loop.

### 6. Added during BUILD (SRC-102): model buttons instead of the combobox

Operator, with a screenshot of the composer model menu (SAIRoute > SAIFREN / SAIOPP behind a hover submenu):
"buttons instead of the combobox; the combobox only when there are many models, otherwise buttons are enough."

## BUILD

| Ask | Before | After | Where | Pinned by |
|---|---|---|---|---|
| 4 approvals | a session stored as build/edit/auto asked "Permission required" for every command | ZAICODE decides every non-plan mode as full access (`zaicode.fullAccess`), workflow confirmations included; plan, questions to the user, the self-kill guard, disallowed tools and project deny rules stay; `ZAICODE_PERMISSION_PROMPTS=on` restores prompts. Composer: a build/edit session or recent choice is shown and sent as Full access; the mode menu offers Full access (+ the Plan checkbox) only | core `permission/zaicode-full-access.ts`, `service.ts`; ui `draftWorkspaceDefaults.ts`, `newTaskDraft.ts`, `useDraftConfigControl.ts`, `V4ComposerModeControls.tsx` | core `zaicodeFullAccess.test.ts` (4), ui `zaicodeT136` |
| 5 TaskOutput hang | one wait up to 600 s, re-waits; card shows `exec_...` | ZAICODE: one wait <= 120 s, ends after 60 s without new output, the result tells the model a notification will come and TaskStop ends a hung command; the card names the command ("Waiting for background task", "Still running, wait ended") | core `task-output-wait.ts`, `task-output.ts`, `result-display.ts`; contracts `wait_note`, display `description`; ui renderer | core `zaicodeT136.test.ts` (silent shell ends the wait, busy shell waits to the cap) |
| 1 project badge | active project refreshed alone while stale -> other projects starved | active-first only on cold start | ui `workspaceTaskListRefreshSignatures.ts`, `useWorkspaceTaskLists.ts` | ui `zaicodeT136` (stale active + stale other both refresh) |
| 3 5h windows | idle window waited for the first request | `keepWindowsRolling` (default on): an idle Claude/Codex window is started with the smallest request, recorded on the account ("window started by ZAICODE 3m ago"), re-read 20 s later; 15 min cooldown, 1 h after a refusal; Engines settings switch | shared `zaicode-engines.ts`; desktop `zaicodeWindowStarter.ts`, `zaicodeEngines.ts`; ui Engines settings, limits panel | ui `zaicodeT136` (decision table), desktop `zaicodeWindowStarter.test.ts` |
| 2 tokens | auto-compact near the model window (1M model: ~966k threshold) | ZAICODE compacts at <= 200k window (threshold ~166k); `ZAICODE_COMPACT_CONTEXT_TOKENS` | core `compact/zaicode-context-ceiling.ts`, `runtime/methods/compact.ts`, `microcompact.ts` | core `zaicodeT136.test.ts` |
| 6 model buttons | 2 models behind a submenu; a dropdown for a handful | <= 6 models in all: one toolbar button each + a small menu button (Manage models, Ctrl+M); inside the dropdown a provider with <= 4 models shows buttons instead of a submenu | ui `zaicodeModelButtonsModel.ts`, `ZaicodeModelButtons.tsx`, `ModelConfigSelect.tsx`, `V4ComposerToolbar.tsx` | ui `zaicodeT136` (2 tests) |

Measured window starts (real accounts, 2026-09-30): Claude account 2 `claude -p ... --model haiku --tools ""`:
701 input / 48 output tokens, answer "ok", 1.8 s. Codex `codex exec --ephemeral --ignore-user-config ...`:
18 378 input (7 296 cached) / 5 output tokens -- Codex's own instructions and tool list; its CLI has no smaller
request. The default Claude home is not signed in ("Not logged in"), which is why it is hidden in ZAICODE.
Not started (no minimal request path known, recorded instead of guessed): Antigravity, ZCode's plan.

Auto-mode classifier: two actions of the full-access work (a search for other approval paths, the mode-menu
filter) were refused by the host's classifier; the operator approved them in chat (SRC-103) and they were redone.
The search found one other ask source: PreToolUse hooks the operator configures (their own config, left as is).

## VERIFY (zcode c71febd)

- `pnpm run verify:pre-push` on the final tree: exit 0 -- lint 0 errors (105 warnings), architecture OK,
  ui 803 pass, services 86 pass, desktop 200 pass + 2 skipped, cli 40 pass. `pnpm typecheck` exit 0; core
  `tsc --noEmit` exit 0 after the contracts build.
- New tests: core `zaicodeFullAccess.test.ts` 4/4 and `zaicodeT136.test.ts` 6/6; ui `zaicodeT136.test.ts` 9/9;
  desktop `zaicodeWindowStarter.test.ts` 5/5. Red on bf0d64d by construction (the modules they import do not
  exist there) and, for the behaviour tests, on the old logic: a build-mode Bash call asked (`notEqual allow`
  holds outside ZAICODE, i.e. the old decision), the old pending selection returned only the active project.
- Staged bundle of c71febd in `packages/desktop/dist-next` (the operator's app was running): packaged boot gate
  PASS -- shell mounted, 29 Settings sections, ProTrail on 3 monitors, customization list live, 0 uncaught
  exceptions, 0 console errors.
- FREE gate on that staged build (`verify-zaicode-free.cjs dist-next ... --router-package 0.5.91-extra`): PASS,
  first token 9.5 s, New task answered after 3 s. Its composer screenshot shows the mode control reading
  "Full access" and the model choice as two buttons SAIFREN / SAIOPP plus the menu icon.
- Real window starts measured on the operator's accounts (see BUILD); the settings switch defaults to on.
