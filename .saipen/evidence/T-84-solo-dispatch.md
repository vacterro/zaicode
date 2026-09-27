# T-84 — Solo preset SAIFREN dispatch

Agent: `claude-code-local-verify` (local verification executor, operator machine).
Closed 27.09.2026 on `V:\___VAC\__K\__CODE\_AI_STUFF_AGENTIC\_ZAICODE`, branch `saipen-live`.

## The defect

The Solo preset creates one agent with `modelSelection` from the SAIFREN pool and
**no `options.reasoningLevel` at all** (`packages/ui/src/zaicode/ZaicodeTeamPresets.tsx:30-36`,
member built at `ZaicodeTeamPresets.tsx:79-89`). SAIFREN requires a reasoning level,
so the run was refused outright with `Reasoning effort ... is not supported`
before any task was created.

## The fix

`packages/desktop/src/host/zaicodeRunDispatch.ts`, `clampZaicodeReasoningLevel`:

```
- if (!requested || !supportedLevels || supportedLevels.length === 0) return selection;
- if (supportedLevels.includes(requested)) return selection;
+ if (!supportedLevels || supportedLevels.length === 0) return selection;
+ if (requested && supportedLevels.includes(requested)) return selection;
```

A missing `requested` no longer short-circuits the clamp; it falls through to the
supported default (`"medium"` when offered, else `supportedLevels[0]`).

Commit `30fd56a` — exactly two files, `zaicodeRunDispatch.ts` (+5/-6) and
`zaicodeHitAndGo.test.ts` (+31). `packages/ui/src/zaicode/zaicodeSettingsDefaults.json`
was inspected and **deliberately left out**: it holds a serialized
`zaicode-ui-prefs-v1` localStorage snapshot (greeting text, preview row counts,
`autoRetryMaxAttempts`), which is the operator's personal state, not product code.
It is still uncommitted in the working tree by design.

## Gates

| Gate | Result |
|---|---|
| `pnpm run verify:pre-push` | exit 0 — lint 0 errors / 76 warnings, `architecture: OK` violations 0, ui 327/327, services 59/59, desktop 65/65 |
| focused executor regression | PASS — `Solo SAIFREN agent receives the model's required reasoning default` (in desktop 65/65) |
| `pnpm bundle:zaicode` | exit 0, staged to `packages/desktop/dist-next` |
| fix present in the shipped package | PASS — verbatim in `dist-next/win-unpacked/resources/app.asar` |
| `git push origin zaicode` | `92d7969..30fd56a` exit 0 |

## Packaged acceptance run

Isolated profile (`V:\_TEMP_\zaicode-t84f-uX4UTS`), seeded with the operator's real
`provider_config.json` so SAIFREN resolves — the same seeding rule the
`ZAICODE-Preview` launcher uses, applied programmatically through
`playwright-core` `_electron.launch` against
`packages/desktop/dist-next/win-unpacked/ZAICODE.exe` (built 27.09.2026 12:35,
after the fix commit at 12:19).

Flow, all through the real packaged UI:

1. SAIHOME → `[data-testid="zaicode-sidebar-open"]` → ZAICODE agents view, `[data-zaicode-team-presets]` rendered.
2. `[data-zaicode-team-preset="solo"]` → "Add team". Panel status: `SAIFREN is ready / Free models, nothing to set up / Ready`.
3. Queue "New task" → instructions `Reply with the single word PONG and nothing else.` → "Add task". Queue showed `queue 1`, engine `new-provider/SAIFREN`, then state **Running**.
4. Terminal job read back from `.zaicode/v2/tasks-index.sqlite`, table `zaicode_jobs`:

```json
{"job_id":"zaicode-job:5fd47bce-7424-4953-960f-aa004919f99d",
 "agent_id":"zaicode-agent:2d38d00e-5f41-4fee-a6b5-11de6ecaa868",
 "status":"completed",
 "error":null, "attempt":1,
 "run_id":"eb6e98af-92e9-464f-9f8d-f4677b1fe632",
 "session_id":"sess_715f9605-884f-41a5-9500-513ab0257a76",
 "started_at":1790502334095, "finished_at":1790502334343,
 "actual_model_selection":"{\"providerId\":\"new-provider\",\"modelId\":\"SAIFREN\",\"options\":{\"reasoningLevel\":\"disabled\"}}"}
```

`status: completed` with `error: null` in 6.2 s, through a real run and a real
session, and `actualModelSelection` carrying the clamped reasoning level. This is
the ticket's verify criterion met end to end on the packaged build.

## Two side findings, not blockers

- **One-off desktop test failure.** The first `pnpm test` of the session failed
  `a window held by the start-up splash is not revealed from the coordinator`
  (`packages/desktop/test/zaicodeSplashGate.test.ts:168`, `held.shown` 1 !== 0)
  at a moment when the T-91 writer was rewriting `primaryWindowCoordinator.ts`
  and that test file. It did not recur in 21 later runs (8/8 full desktop suite,
  10/10 the file alone, 3/3 real `pnpm test`), and the fix shipped as `92d7969`
  plus the T-92 audit. Cause correlated in time, not confirmed.
- **`pnpm bundle:zaicode` needs the tree quiet.** A run failed with
  `EBUSY ... mock-cdn/releases/3.14.0/manifest-darwin-arm64.json` when it
  overlapped a second bundle I had started. A clean re-run passed. Not a product
  defect; noted so the next agent does not chase it.

## Note on the blocker this ticket carried

The `LOCALITY` blocker (`DEBT_SNAPSHOT_FOREIGN_PROJECT`, E-1446) is resolved by
construction: the fix is now published as `30fd56a` on `origin/zaicode`, so no
cloud BUILD entry is needed. Nothing in `.saipen/recovery/*` was rewritten to
achieve this.
