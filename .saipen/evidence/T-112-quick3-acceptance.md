# T-112 — A3 (AUDAPACK Quick3) live acceptance

Run 2026-09-29, ticket T-112. Product commits `a7779a5` (the change),
`00dcee9` (review fix). Both trees were accepted live.
Harness: `zcode/packages/services/acceptance/quick3-live-acceptance.ts`
Raw log: `zcode/packages/services/acceptance/acceptance-run.log`

## What is real, and what is substituted

**Real, and under test:** `ZaicodeAuditService` as shipped — the Quick3 profile
binding, the report gate (`validateZaicodeAuditArtifact`), the campaign state
machine, exactly-once dispatch, same-wave retry, the deterministic synthesis of
`__00_AUDIT_ALL_3.md`, and the Fix-with-SAIPEN handoff. Also real: the queue
(`ZaicodeJobService`), the campaign record on disk under `{appConfig}/zaicode-audits/<id>/`,
and the audited source itself.

**Substituted, stated rather than glossed:** the auditor is a real local model
(`qwen3.5:9b` over Ollama at `127.0.0.1:11434`), not the desktop task service.
The production executor (`packages/desktop/src/host/zaicodeRunDispatch.ts`)
resolves a full host `ServiceCollection` and drives `IZCodeTaskService`, which
cannot be stood up headlessly from an agent session. The campaign machinery
under test is unchanged by this substitution.

The auditor is given **read tools only** — there is no write tool at all — so
"read-only" is structural, not a request the model was asked to honour.

Audited target: `zcode/packages/shared/src` (real source, not a fixture).

## Result: PASS

One run, one real model, one campaign. Wave 3 was **refused on its first
attempt** and then completed on the same wave, so the run demonstrates the
gate, the same-wave retry and the chain in a single pass:

```
STEP 1  /a3 -> one campaign, one Core
  run 86f26690-dd72-4e61-a868-e84116a50834
  profile quick3 1.0.0 (fnv1a64:fdfa9302)
  source  git:9f58b250c3c51feb7b04fc11a103cbd3fc4d68e0:11b357ee8b60e593
  queue   1 job(s), 1 wave(s)

STEP 2  three chained waves against the live model
  A3 1/3 AUDIT CORE    : read 4 file(s) -> wrote 9189 bytes   [1/3 saved]
  A3 2/3 AUDIT SECOND  : read 5 file(s) -> wrote  262 bytes   [2/3 saved]
  A3 3/3 AUDIT PERFORMANCE: wrote 439 bytes
  [service] wave performance rejected (missing-terminal-line)
  [blocked] 2/3 saved - refused: the report does not contain
            "STATUS: PERFORMANCE: COMPLETE"

  retrying wave performance (attempt 2); the wave index must not move
  after retry: index 2, attempt 2            <- the index did NOT move

  A3 3/3 AUDIT PERFORMANCE #2 -> wrote 468 bytes
  [complete] 3/3 saved - attempt 2

STEP 3  the four durable artifacts
  ZAICODE__01_AUDIT_CORE.md          saved  bd357f91bc1c73b9
  ZAICODE__02_AUDIT_SECOND_WAVE.md   saved  187cd970435d5089
  ZAICODE__03_AUDIT_PERFORMANCE.md   saved  597b5cda179afef3
  ZAICODE__00_AUDIT_ALL_3.md         saved  8da92ee090e5ef94
    combined digest verified: true

  campaign status: complete
  verified findings: 10

STEP 4  Fix with SAIPEN
  job zaicode-job:0397ee51-47fd-4456-acfb-208b313fc94d on the queue: true
  source drift: {"audited":"git:9f58b25...:11b357ee8b60e593",
                 "atFix":"git:9f58b25...:11b357ee8b60e593","changed":false}
  the job names the artifact digest: true
  the job names the artifact file:   true

RESULT: PASS
```

Every item the wave requires is observed: Core saved, Second saved, Performance
saved, `__00_AUDIT_ALL_3.md` saved with a digest that matches the bytes on disk,
and the Fix action accepting that exact file as the next repair input. The
campaign reached `complete` only after the combined file existed.

The Core report is 9189 bytes of real findings with `file:line` evidence read
from the real source; the campaign counted **10 verified findings** through the
gate, not a number the model asserted.

## The gate was seen refusing, live, three times

These are not unit tests. They are this harness refusing the model's real
output, and they are the behaviour the operator complained about being absent:

| Run | What the model produced | What the service did |
|---|---|---|
| 1 | 31-byte stub, no terminal line | `missing-terminal-line`; campaign `blocked` at 0/3, waves 2-3 never dispatched, no combined file, Fix refused |
| 2 | Core naming a different run id | `wrong-run`; wave index unmoved |
| 3 | Performance emitting read-file tags instead of a report | `missing-terminal-line`; `blocked` at 2/3, then same-wave retry completed it |
| 4 | Performance returning an empty message | `empty`; `blocked` at 2/3 |

No refusal was repaired by injecting a marker into the model's report. Under
the legacy profile these same outputs advanced the campaign — that was the
defect.

## Re-run on the final tree (commit 00dcee9) -- PASS again

The review fix (`/a3` guard, atomic combined write) landed after the run above.
The acceptance was re-run against that tree and passed again, with a different
wave refusing:

```
  [blocked] 0/3 saved - refused: the report has no "CORE-N" finding and
            does not contain "NO VERIFIED CORE DEFECTS."
  retrying wave core (attempt 2); the wave index must not move
  after retry: index 0, attempt 2            <- the index did NOT move
  A3 1/3 AUDIT CORE #2 -> 294 bytes -> [1/3 saved]
  A3 2/3 AUDIT SECOND  -> 259 bytes -> [2/3 saved]
  A3 3/3 AUDIT PERFORMANCE -> 517 bytes -> [3/3 saved]

  ZAICODE__01_AUDIT_CORE.md          saved  15c8303e99dc5ac4
  ZAICODE__02_AUDIT_SECOND_WAVE.md   saved  b73fab8829a3e5ff
  ZAICODE__03_AUDIT_PERFORMANCE.md   saved  33577ae62968460e
  ZAICODE__00_AUDIT_ALL_3.md         saved  c47248d33933db34
    combined digest verified: true
  campaign status: complete
  Fix with SAIPEN: job zaicode-job:7631eaf8-... on the queue: true
    names the artifact digest: true
    names the artifact file:   true
RESULT: PASS
```

Two independent live passes, two different waves refused, two different
same-wave retries, both completing 3/3 with a verified combined digest. The
behaviour is not a single lucky run.

This run's Core reported **0 verified findings** with the exact no-findings
sentence, and the gate accepted that: an audit that verifies nothing is a
legitimate result, and it is distinguishable from an audit that found nothing
to say.

## Gates at SHIP

| Gate | Result |
|---|---|
| `pnpm run typecheck` | 0 errors |
| `pnpm run lint` | 0 errors, 101 pre-existing warnings |
| `pnpm run architecture:check -- --changed` | `architecture: OK`, violations 0, new 0 |
| `pnpm test` | 765 tests, 763 pass, 0 fail, 2 pre-existing opt-in skips |
| `pnpm run bundle:zaicode` | exit 0 — the packaged app builds with the change |

## Not covered here

- The desktop executor path (`zaicodeRunDispatch.ts`) and the `/a3` composer
  keypress itself were not driven live: the agent session is barred from
  launching the packaged Electron UI (SAIPEN `KNOWLEDGE/HABITS-browser-hang.md`:
  a daemon outliving the tool call freezes the session, and the rule requires
  such a check to run outside the agent session). Both are covered by unit
  tests instead — `/a3` exactly-once and the existing-campaign decision in
  `packages/ui/test/zaicodeWave5A3Command.test.ts` (11/11).
- A trailing `ZaicodeJobRepo 未初始化` line in the raw log is the harness
  closing the database while the queue poller was still running, after
  `RESULT: PASS`. It is teardown noise, not a campaign failure.
