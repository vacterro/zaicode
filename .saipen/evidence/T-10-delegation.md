# T-10 evidence — agent-initiated delegation (operator scope decision SRC-033)

Blocker lifted by the operator's decision in SRC-033: only the primary
coordinator spawns a child; depth exactly 1 (no child -> child); fixed
concurrency budget; allowed roles; explicit parent linkage; no protocol
ownership stealing; results back through the queue + SAIMAIL to the parent /
Work owner.

## Design

The 2026-09-22 sketch mirrored the OffPeakCreate built-in tool across ~14
upstream files. The shipped path keeps the queue as the only owner and adds no
upstream protocol surface: a running coordinator job gets a request folder of
its own; the agent's ordinary file tool is the tool call (write
`<name>.json`); the host claims the file by rename and hands it to the queue
service, which alone decides; the answer is `<name>.result.json`; a helper's
final state lands as `<childJobId>.done.json`. Helpers send their own SAIMAIL
telegram when SAIMAIL is configured (the host never sends under another
agent's seat: SAIMAIL `SAIPEN_SEAT_MISMATCH` rule).

| Rule (SRC-033) | Where it is enforced |
|---|---|
| primary coordinator only | `evaluateZaicodeDelegation` (`shared/src/zaicode-delegation.ts`): parent role in `policy.parentRoles` (default `coordinator`) |
| depth exactly 1 | parent must have no `parentJobId` (`parent_is_child`); child roles never include `coordinator`; the executor opens a folder only for top-level jobs |
| fixed budget | `maxChildrenPerParent` (default 3, 0 = off, limit 8) per parent job row; running helpers also obey the workspace concurrency limit of the queue |
| allowed roles | `policy.childRoles` (default implementer, auditor, researcher, hunter, tester, cleaner, wikier, translator) |
| explicit parent linkage | child rows carry `parentJobId`; answers carry the child id |
| no ownership stealing | a request from an earlier run is `stale_run` (the run id is the token); a parent that is not `running` is refused; helper prompt: "do not claim or close the parent's SAIPEN Work" |
| results back to the parent | queue row (authoritative) + `<childJobId>.done.json` in the parent folder via `onChildFinished`; the helper's own SAIMAIL telegram |

Files: `shared/src/zaicode-delegation.ts` (policy, request schema, prompt paragraphs),
`services/src/zaicode/zaicodeJobDelegation.ts` + `ZaicodeJobService.delegateFromRun /
get|setDelegationPolicy` (setting `delegation_policy`), `services/src/node.ts`
(`listAgents`, `setZaicodeChildFinishedListener`), `desktop/src/host/zaicodeDelegationSpool.ts`
(claim-by-rename, answers, outcomes), `zaicodeRunDispatch.ts` (folder per coordinator run,
helper paragraph), host `index.ts` wiring, remote stub, `ui/src/settings/ZaicodeDelegationSettings.tsx`
(Settings -> ZAICODE: helpers per run, delegating roles, helper roles).

## Gates (from `zcode/`)

- `tsc -b` (typecheck list) 0; `pnpm lint` 0 errors (72 baseline warnings; the first run hit
  max-lines on `zaicodeJobService.ts`, fixed by moving the delegation logic to its own module);
  `pnpm architecture:check --changed` OK.
- Services (run from `packages/services`): `test/zaicodeDelegation.test.ts` 4/4 (policy; coordinator
  delegates a linked child that runs through the real queue; depth, stale run, coordinator helper,
  invalid request, budget 3; tester parent refused; finished parent refused; policy 0 = off; spool:
  three requests answered once each, second pass answers nothing, helper outcome lands as
  `.done.json`), `test/zaicodeJobs.test.ts` 12/12 unchanged.
- Red control: depth rule removed -> 1 fail; restored -> 4/4.
- UI 110/110.

## MANUAL-VERIFY STEPS + EXPECTED

1. ZAICODE page: create a Coordinator and a Tester agent; queue a job for the Coordinator asking it to
   "have a tester check X". The running job's prompt ends with the Delegation paragraph and a folder.
2. The coordinator writes `ask.json`; within ~2 s `ask.result.json` shows the child job id; the queue
   shows the helper job linked to the parent.
3. When the helper finishes, `<childJobId>.done.json` appears in the folder.
4. Settings -> ZAICODE -> Delegation -> 0 helpers: a new coordinator run gets no folder / paragraph.
