# T-66 — A3 audit system (AUDAPACK mechanism) in ZAICODE

Verify field: "A3 audit waves generated, queued, listed and worked from ZAICODE
per AUDAPACK's own mechanism; smart mode demonstrated on an empty board;
parallel audit+work sessions shown by tests or a real run."

## One mechanism, converged

Prior build left three parallel audit implementations. This build keeps one
(the durable, queue-backed one) and deletes the other two:

- KEPT — services layer: `packages/services/src/zaicode/zaicodeAuditService.ts`
  (+ interface `zaicodeAudits.ts`, pure logic `packages/shared/src/zaicode-audits.ts`).
  A campaign = 3 waves; every wave is one ordinary ZAICODE queue job (lease,
  retry, parallelism for free), instructions = wave prompt, completion gated by
  the report file (STATUS line + done marker — AUDAPACK's rule). Campaign state
  at `{appConfig}/zaicode-audits/<id>/campaign.json`, atomic writes.
  Registered in `node.ts` ServiceCollection as `IZaicodeAuditService`, exposed
  over ServiceChannels `zaicode-audits` via accessor + client ProxyChannel.
- DELETED — `packages/desktop/src/main/zaicodeAudits.ts` (orphan duplicate
  factory, never instantiated, referenced PlatformChannels that never existed).
- DELETED — `packages/ui/src/zaicode/zaicodeAuditQueue.ts` (localStorage
  prompt-copy store — the "straight into chat" flow the ticket forbids).

## UI (generated, queued, listed, worked from ZAICODE)

- `ZaicodeAuditPanel.tsx` rewritten on the real service: Generate A3 (campaign
  `planned` in review queue, nothing dispatched), Audit now (generate + work),
  Work button per planned campaign (dispatches wave 1 onto the queue), Cancel,
  report viewer, wave status rows, campaign status badges.
- `zaicodeAuditStore.ts` (new): zustand mirror of `IZaicodeAuditService`
  (getState/generate/work/start/cancel/setSmartMode/readReport).
- `zaicodeServices.ts`: `audits` exposed through `resolveZaicodeServices`
  (optional; renders an explicit unavailable state when the host lacks it).
- `ZaicodeWorkspaceBar.tsx`: Audits tab badge = active campaigns for the
  workspace, from the real store.
- `ZaicodeAppRuntime.tsx`: `useZaicodeAuditSmartPoller` — 60 s tick publishes
  open projects (`publishProjects`) and runs `smartSweep` (renderer owns the
  clock, per the service's contract).

## Smart mode (empty board -> self-audit)

`shouldStartZaicodeAuditCampaign` (shared): smart mode on + SAIPEN board
present + 0 open tickets + 0 running jobs + no active campaign -> the project
starts its own A3 campaign. Toggle: panel header Switch -> `setSmartMode`
(persisted in `zaicode-audits/settings.json`).

## Proof (tests, `packages/services/test/zaicodeAudits.test.ts`, 8/8 PASS)

- generate is generate-first: planned, no job dispatched ✔
- work dispatches wave 1 and the campaign starts running ✔
- full A3: three good reports chain to complete with the finalizer handoff ✔
- AUDAPACK gate: a report missing the STATUS line blocks the campaign ✔
- cancel stops a running campaign and its wave job ✔
- smart mode: empty board + nothing running starts a campaign; a full board
  does not ✔
- parallel: an audit campaign runs alongside other queue work (own jobs,
  shared queue) ✔
- state persists to campaign.json under the audit root ✔

Test-harness fix that made the suite honest: the fake executor now reports the
run outcome via `reportRunOutcome` after writing the report (production path),
and dispose settles late wave writes before rm.

## Gates

- services `node --import tsx --test test/zaicode*.test.ts` → 38/38 PASS
- ui `node --import tsx --test test/zaicode*.test.ts` → 246/246 PASS
- desktop `node --import tsx --test test/zaicode*.test.ts` → 49/49 PASS
- tsc --noEmit: shared, services, ui, desktop → 0 errors
- pnpm lint → 0 errors

ponytail: no Settings-section entry for smart mode yet — the panel Switch
covers the ticket's control; add a Settings page when more audit knobs exist.
