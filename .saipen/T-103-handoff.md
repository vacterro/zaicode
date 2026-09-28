# T-103 / SRC-066 — SAIASUI! handoff

Operator explicitly requested `saipen stop` on 2026-09-28 because the session
limit was approaching. This is a user pause, NOT task completion. Resume only
after operator continuation (`cc` / `saipen continue`). Preserve ticket owner
`claude-code-local-verify`; this was inherited from canonical STATE at ingress.

## Binding and request

- Workspace: `V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE`.
- Separate product Git repository: `zcode/`, branch `zaicode`.
- SAIPEN home: `V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_SAIPEN`.
- Launcher: `<home>/bin/saipen.cmd`; load STYLE.md + EXECUTION.md + BOOT.md
  from `<home>/saipen` before responding. Current chat language setting is et.
- Work was in VERIFY before the requested stop. No REVIEW/SHIP/closure yet.
- Exact request: `.saipen/intake/active/SRC-066.md`; captured through `saipen
  start --file .saipen/saiasui-request.txt`. Contract/coverage currently retain
  start-generated empty mappings; do not invent closure evidence.
- User wants an osu-like aim game only from New task: gradual UI disappearance,
  slow bounded acceleration, seeded targets/events, scores/combo, HP after 50
  hits, 2-minute grades, linear/step setting, instant Esc restoration.

## Implemented, uncommitted

Specification: `zcode/specs/saiasui.md` (written before implementation).
All game source: `zcode/packages/ui/src/zaicode/saiasui/`.

- `saiasuiEngine.ts`: deterministic engine reuses existing SAIPEGGLE seeded RNG;
  one main target + optional tiny HP bonus, 2.8s initial interval, 650ms cap,
  HP starts on hit 50, healing/drain/misses, 3s god/slow, full HP, moving targets,
  segment SS/S/A/B/C/D, score/max combo, per-seed bounded variation.
- `saiasuiGesture.ts`: five spaced primary blank-background clicks within 6s;
  controls, composer, text, dialogs, inert/hidden panes excluded.
- `SaiasuiHost.tsx`: only mounted in focused editable ZAICODE draft SessionPane;
  8s nonblocking offer, hit to start, cancel on Esc/normal input/blur/hidden,
  route/unmount cleanup, render error boundary.
- `SaiasuiGame.tsx`, `SaiasuiTarget.tsx`, `saiasuiIsolation.ts`: body portal,
  30-hit gradual backdrop, true circles + approach rings, window-size bounds,
  inert sibling preservation/restoration, focus restoration, RAF disposal,
  event shielding, health/grade HUD, game-over view. Reduced motion stops drift.
- `saiasuiSound.ts`: original short oscillator percussion, master mute/volume,
  per-run AudioContext cleanup, no music; unavailable audio is harmless.
- `saiasuiStore.ts`: dedicated normalized settings/records, storage-safe;
  bests separate per pacing mode. Only settings enter release snapshots.
- `SaiasuiSettings.tsx`: Settings > ZAICODE enable/sound/tempo and records.
- English/Chinese messages: `packages/ui/src/i18n/locales/saiasui.ts`, imported
  by existing en-US.ts and zh-CN.ts; uses existing IntlProvider.
- Integration: `v4/SessionPane.tsx`, `settings/ZaicodeSettingsSection.tsx`,
  `zaicode/ZaicodeAppRuntime.tsx`, `zaicode/zaicodeSettingsSnapshot.ts`.
- `readZaicodeSetting` now catches unavailable storage and uses bundled defaults.
  Browser fault injection exposed an existing uncaught settings read during
  sound preheat; this small shared fix prevents optional game/audio imports
  from breaking the app in that condition.

No task/agent/service/queue/project APIs are called by the game. ProTrail already
defaults enabled; its configuration was not changed. No new dependencies.

## Preserve unrelated work

`packages/ui/src/zaicode/zaicodeSettingsDefaults.json` was already dirty at start
and has NOT been edited by this task. Do not stage/commit/revert it with T-103.
The outer repository has substantial existing uncommitted SAIPEN history,
untracked AGENTS.md and desktop.ini. Do not blanket-stage, clean, reset, or
attribute those bytes to this ticket. Product source is ignored by outer Git.
No commits, pushes, tags, executable replacement, or app restart were performed.

## Verification actually obtained

Use pinned pnpm: `.tools/pnpm10/node_modules/.bin/pnpm.cmd` from workspace;
from zcode use `../.tools/pnpm10/node_modules/.bin/pnpm.cmd`.

- Workspace freshness: current zaicode baseline was fresh against origin/zaicode.
- Architecture check: zero violations (before and after initial implementation).
- `pnpm typecheck`: PASS, including latest source edits (last process exited 0).
- Latest `pnpm test`: UI 404/404, services 59/59, desktop 79 pass + 2 skip,
  zero failures. Total 542 pass / 2 skip. Focused SAIASUI tests: 10/10.
- `pnpm lint`: PASS, 76 existing warnings, 0 errors before the final small
  event-shielding/UUID-fallback changes; rerun on final tree.
- `pnpm build:zaicode`: PASS, renderer+host production build. That build precedes
  final event-shielding/UUID-fallback edits; rebuild before packaging.
- `git diff --check`: PASS before final small edits; rerun.
- Red controls: unchanged tests FAILED as expected when HP threshold temporarily
  changed 50 -> 51 and storage catch temporarily removed. Both mutations were
  immediately restored. Focused tests then passed 10/10. Never leave mutations.
- Full test suite initially failed a brittle SAIPEGGLE source-text assertion when
  its selector was merged with SAIASUI. Fixed implementation by preserving the
  existing SAIPEGGLE guard line and adding a separate SAIASUI guard. Test untouched.

Browser harness (actual React components + actual product CSS, isolated from
operator profile/services):

- Fixture: `zcode/packages/ui/test/e2e/saiasui.fixture.tsx` (StrictMode).
- Runner: `C:/Users/vac34/AppData/Local/Temp/playwright-test-saiasui.js`.
- Run from `C:/Users/vac34/.agents/skills/playwright-skill` with
  `node run.js C:/Users/vac34/AppData/Local/Temp/playwright-test-saiasui.js`.
- Runner starts isolated Vite at 127.0.0.1:5187, launches its own Chromium,
  and closes both in finally. Uses repo Vite/React/Tailwind. No real Electron app.
- Screenshot: `C:/Users/vac34/AppData/Local/Temp/saiasui.png`.
- Earlier full browser pass: gesture, protected composer, scoring, Esc,
  inert/focus/draft restoration, blur, route unmount, non-draft negative trigger,
  disable setting, step setting, resize to 640x540 with reachable targets and no
  horizontal overflow, unavailable storage/audio, zero uncaught errors.
- Final expanded browser run also uses real Golden Default palette/crisp styles
  and checks offer cancellation, records and visibility cancellation. At pause
  request it was still finishing; its final result is appended below if available.
- Two initial harness setup failures (React preamble and fixture-only missing
  Tailwind layout utilities) were corrected. They were not product defects.
  Storage fault failure was real and fixed as described above.

## Exact continuation

1. Resume through canonical `saipen continue --json`; read returned phase/action.
   Read this handoff, current STATE/BOARD/LOG and SRC-066 (files outrank this note).
2. Check both Git worktrees. Inspect implementation against full source request;
   preserve existing changes. No subagents were requested or used.
3. Finish VERIFY: inspect final browser result below; rerun only if needed;
   rerun final lint, architecture, diff/format checks and production build.
   New files were formatted with oxfmt. Main legacy integration files were not
   wholesale reformatted to avoid unrelated changes.
4. REVIEW own diff and request coverage. Record real evidence via canonical
   checkpoint and transition. Do not claim full real-desktop interaction testing:
   browser evidence is a real-component isolated harness, model tests cover
   30-minute seeded sessions and occasional misses.
5. Follow installed SHIP policy for exact reviewed scope. Product repo and outer
   SAIPEN repo need separate handling; never stage foreign defaults/history.
   Read current release policy before deciding publication/version behavior.
6. If packaging for the operator, `pnpm bundle:zaicode --skip-prepare --skip-build`
   can package an already fresh build. Read wrapper/bundler options first.
   Wrapper detects a locked live ZAICODE.exe and stages into dist-next, which
   the root launcher adopts next start. Never stop/kill the operator's app.
   Packaging has NOT been performed yet; do not claim the running app has this.
7. Finish T-103 only after remaining gates. Final answer should state how to
   trigger (five spaced empty clicks in New task, then circle), Esc, settings,
   features, verification, and actual build/deployment status.

No operator decision is pending other than this explicit pause. Most remaining
work is final verification/review, packaging/publication if required by the
installed workflow, evidence/closure. Do not restart implementation from scratch.
