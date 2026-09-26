# T-63 evidence — SRC-048 wishlist (9 items)

Date: 2026-09-26. Repo: `zcode/` (branch `zaicode`) + workspace (`tools/launcher`, docs).

## Root causes found

- "Project works, sidebar shows no animation": the sidebar decides "running"
  from the sessions-index list projection only; the open chat (Stop button,
  streaming) knew better. Screenshot 05:23: `_FastPrompter` session
  `sess_51339932` ("saipen continue") running, row showed the idle MAIN diamond.
- "SUBCHAT is not complete": only Claude / Codex were chat vendors (D-12);
  `agy` (Antigravity CLI) has `-p … --output-format stream-json` and
  `--conversation <id>`, and ZCode's CLI `-p … --json` / `--resume` -- both
  probed on this machine (agy: real turn with claude-sonnet-4-6, resume
  verified; Gemini pool answered 429 "Individual quota reached. Resets in
  100h3m51s"; zcode: `{sessionId, response, usage, projection}` document).
- "Reset every 5 minutes back to 5 h": Codex 1 / Codex 2 Session and
  Antigravity 5 h all showed reset 09:46 = read time + 5 h. An untouched
  window's reset slides with every read; Codex's session was also gated by
  its spent weekly window, yet the title timer picked it ("C1 ↺ 4h 56m").
- "Blur at this size": the todo tooltip's left = cell centre - 160 with
  fractional cell widths -> x.5 px -> soft pixel font.
- "Half a minute of grey rectangle": on Windows the main BrowserWindow is
  frameless, transparent + acrylic and shown before the renderer bundle is
  loaded; the root launcher also swaps the staged build before any window.
- "Worker icon animation asymmetric": the flip / combined transform used
  `perspective(40px)` on a 16 px icon -- one half drawn twice the size of the
  other (the slanted yellow sliver next to WORKERS 1/1); wobble decayed to one
  side, bounce went only up.

## Item -> change

| # | Item | Change |
|---|------|--------|
| 1 | sidebar animation | `zaicodeLiveRuns.ts`: the open chat publishes its running state; task row, project count, MAIN glyph light from either source |
| 2 | SUBCHAT all subscriptions, "like projects" | AG / ZC vendors (invocation, agy stream parser, zcode document parser, prompt file over 24 000 chars), Freebuff tile disabled with reason, chats grouped per project with Working icon, SUBCHAT menu line running count |
| 3 | hard bevels, optional, default on | `zaicodeBevels.ts` inset-shadow 2 px bevels, `zaicode-bevels` / `zaicode-bevel-rows`, palette menu toggles |
| 4 | reset every 5 min | `startsOnUse` marking at read time, gated / idle rows never lead, "5h on use" / "after weekly", SCHEDULER waits |
| 5 | presets + export / import | `zaicodeLightsPresets.ts` + Presets block; profile export / import |
| 6 | blur | `zaicodeDevicePx` for measured pop-ups; optional vertical snap |
| 7 | SAIPEN splash, rest delayed | launcher splash + app splash (same 560x300 picture, same place), main window hidden until `zcode-startup-ready`, in-window loading shows the picture |
| 8 | more control in mixes | per-motion / per-effect / per-shape / per-layer settings, own easing curves, curve editor |
| 9 | symmetric worker icon | no perspective, symmetric wobble / bounce, centre origin |

## Verification (this machine)

- `pnpm typecheck` equivalent (`tsc -b` over the typecheck set): exit 0.
- Desktop main (`tsconfig.main.json`, not in the gate): no error on touched lines
  (remaining errors are upstream's, in lines not touched).
- `pnpm lint`: 0 errors, 72 warnings (baseline; none in T-63 files).
- UI `zaicode*.test.ts`: 237/237 (new `zaicodeWave63.test.ts` 20 tests).
- Desktop `zaicode*.test.ts`: 45/45 (ZCode document transport case added).
- Services `zaicode*.test.ts`: 30/30.
- Root launcher compiled to a scratch exe (csc, exit 0).
- GUI click-through is an operator step (see the final report).

## Finish pass (second session, 2026-09-26)

The first session hit its account limit while the staged bundle ran (the
bundle died with it: `node-repl-host build failed with code 3221225794`,
0xC0000142, not a code error). This pass reviewed every item against the
operator's words and screenshots, then fixed what the review found:

- SUBCHAT Antigravity: the CLI defaults to a Gemini model. A real turn through
  ZAICODE's own invocation, parser and process transport answered
  `Individual quota reached ... Resets in 99h11m` while the Claude & GPT pool
  sat at 100 % (Nearest resets screenshot) -- every AG chat would have failed.
  `zaicodeSubchatAutoModel` picks the first pool without a spent / blocked
  window; main passes its model; the chat header names it. Real run with
  `--model claude-sonnet-4-6`: turn 1 `PONG`, turn 2 (`--conversation <id>`)
  remembered `PONG`, usage 18 807 / 17 then 37 842 / 34 (18 335 cached).
- Layers: a layer's opacity was the `opacity` property, which its own breathe
  / blink animation overwrites (the SRC-043 bug class); now `filter: opacity()`.
- Bevels: the `!important` bevel shadow replaced the upstream focus ring (a
  box-shadow), so keyboard focus vanished on buttons; focus is now the
  Windows 95 dotted rectangle (outline, no layout change).
- Generated CSS (bevels, motion) parsed strictly with lightningcss
  (`errorRecovery: false`): no error, no warning -- one bad selector would have
  dropped a whole rule.
- Root docs had been rewritten with CRLF over LF blobs (whole-file diffs);
  restored to LF.

Gates after the pass: `pnpm typecheck` exit 0; `pnpm lint` 0 errors / 72
warnings (baseline); UI `zaicode*` 238/238; desktop 45/45; services 30/30.
Root launcher rebuilt with `tools\launcheruild.cmd` (exit 0; the running
launcher keeps its old image until the operator's next start). Staged bundle:
see the final report.
