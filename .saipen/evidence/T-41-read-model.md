# T-41 evidence -- System Read Model (SRC-033 analysis 2)

## What reads what

| Surface | Before | After |
|---|---|---|
| Sidebar project strip tint | own STATE/BOARD heuristics | `useZaicodeProjectRuntime` -> `zaicodeProjectRuntimeState` |
| Composer SAIPEN chip + NEXT / THEN / BLOCKER lines | STATE/BOARD parse | chip: read-model verdict; lines: `zaicodeSaipenHeadline` (projection first) |
| SAIPEN side pane header | STATE parse | read-model verdict + `zaicodeSaipenHeadline` |
| /goal verdict (agent CLI) | BOARD/STATE parse | `saipen status --json` first (`readSaipenGoalProjection`), board parse as fallback + blocked list |

The projection comes from the SAIPEN launcher (`<home>/bin/saipen.cmd status
--json --project-root <path>`), the protocol's DIRECT_LAUNCHER transport; the
desktop main process caches it per project until STATE/BOARD/LOG change.

## Verification (2026-09-25)

- `node --import tsx --test test/zaicode*.test.ts` (packages/ui): 114/114 pass
  (includes `zaicodeWave41.test.ts`: one verdict ordering, files fallback,
  owner/generation, headline from projection).
- `node --import tsx --test ../../apps/zcode-cli/packages/core/test/saipenGoalVerdict.test.ts`
  (packages/services): 13/13 pass (projection decides open work over a stale
  board line, autonomy push kept, JSON parse rejects junk).
- Live: `readSaipenGoalProjection` on this workspace returned
  `{ phase: SCOUT, claimedTicket: T-41, topWorkableTicket: T-45, closureComplete: false }`
  and the verdict `passed: false, "SAIPEN reports open work: T-41"` (4.3 s incl. tsx start).
- Root `tsc -b` (typecheck script set): exit 0. `apps/zcode-cli/packages/core`
  `tsc --noEmit`: exit 0. Root `oxlint`: 0 errors. Core `oxlint src`: 30
  pre-existing max-lines errors in upstream files, none in changed files.
  `pnpm architecture:check --changed`: OK, 0 violations.
- Red control: `zaicodeSaipenModel.test.ts` failed before its expectation was
  updated for the new owner/generation fields (the parse change was real).
