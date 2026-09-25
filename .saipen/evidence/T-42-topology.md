# T-42 evidence -- SRC-033 analysis 3: execution topology vs UI layout

Verify: worker/session identity survives every placement change in tests;
placement code cannot change identity fields.

| SRC-033 words | Where |
|---|---|
| runtime_id, work_id, owner, role, generation, engine, lease, health | `zcode/packages/shared/src/zaicode-topology.ts` `ZaicodeRuntimeIdentity` (frozen) |
| one registry owns identity | `ui/src/zaicode/zaicodeRuntimeRegistry.ts` (workers + running chat turns; identity records only) |
| panel / window / tab / tray are placement only | `ui/src/zaicode/zaicodeWorkerRecords.ts`: `ZaicodeWorkerPlace` written only by `placeZaicodeWorkerRecord` |
| location != ownership, window != worker identity | identity record replaced only by `exitZaicodeWorkerRecord`; `applyZaicodePlacementPatch` throws on identity keys |
| slot != execution authority | sidebar slot groups and the MAIN pointer are not registry inputs (test) |
| Project -> primary / auxiliary / workers | `zaicodeProjectTopology` (primary / auxiliary from the agent runtime when registered; workers; subchats) |

Tests (`ui/test/zaicodeTopology.test.ts`, 7/7):
1. identity is the same frozen record through float, resize, raise, minimize,
   restore, dock, reorder, solo, panel maximize / hide / show, cycle (12 moves),
   and each move did change the placement;
2. a placement patch naming projectPath, accountId, exitCode, generation, id or
   command throws; assigning to a frozen identity throws; placement keys and
   identity keys are disjoint;
3. an exit replaces the identity (exit code, end time, failed, lease null) and
   keeps the place;
4. generations 1, 2 (same engine + project, path case ignored), 1 (other
   project), 3 (duplicate); the crash list keeps generation (default 1);
5. runtime transitions: exit ends the lease, restart = generation + 1 with a
   new runtime id, same work and owner;
6. topology groups workers and chat turns per project from identities only;
7. moving a project to SIDE1 and re-pointing MAIN leave the registry unchanged.

Red control: `placeZaicodeWorkerRecord` rebuilt the identity object -> test 1
fails ("identity is the same record"); restored -> 7/7.

Gates (2026-09-25): UI `zaicode*` 217/217 (`zaicodeWave60` recovery oracle
now carries `generation: 1`); desktop `zaicode*` 44/44; `pnpm typecheck` 0; UI
`tsc --noEmit` 0; `pnpm lint` 0 errors, 72 warnings (baseline);
`pnpm architecture:check --changed` OK.
