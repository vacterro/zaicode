# T-215 — the release-scope drift is seven plans and 112 paths, not one plan and 8

Measured 2026-10-04, at workspace `V:\___VAC\__K\__CODE\_AI_STUFF_AGENTIC\_ZAICODE`,
against `.saipen/kitchen/release_scope/*.json` (7 plans carry a `paths` map of
`path -> sha256`, 403 scoped paths in total).

## The premise on T-215 is falsified by the refusal it cites

T-215's title: *"nothing can SHIP until T-144's release scope is re-bound"*, and its
blocker frames the problem as `T-144.json`, *"stale in at least 8 paths"*.

The ship path does not refuse on T-144:

```
$ saipen ship --dry-run
REFUSE [STALE_PLAN]
reason: scope path zcode/scripts/zaicode-soak-verdict.mjs changed since review
        (live '3eb40b128fc67f55',
         reviewed '1bcfafc5af08ccd738992f14e48409b76a7cf7cb0db8c5e7524e740756353d2f');
        re-record the scope or revert the edit
```

`zcode/scripts/zaicode-soak-verdict.mjs` is scoped **only** by `T-179.json`. It does not
appear in T-144's 29 paths, nor in any other plan. So the first and current refusal
belongs to T-179. Re-binding T-144 alone would not move `saipen ship` one step; the
refusal would simply advance to the next drifted path.

That matters because T-215 is marked `OPERATOR_REQUIRED` and says *"Until one is
recorded, T-215 cannot enter SCOUT."* An operator who answered its question as posed —
option (a), re-bind T-144 — would have made the decision, spent the authority, and
still had a refused ship path.

## What the drift actually is

Every scope path whose current sha256 differs from its recorded value:

| plan | scoped paths | drifted |
| --- | --- | --- |
| T-137 | 140 | 32 |
| T-141 | 106 | 17 |
| T-206 | 40 | 36 |
| T-94 | 34 | 8 |
| T-142 | 28 | 8 |
| T-144 | 29 | 8 |
| T-179 | 3 | 2 |
| T-204 | 4 | 1 |
| **total** | **403** | **112** |

Seven plans are stale, not one. T-215's "8" is the drift of the single plan it names.

## Why re-recording all 112 today would not hold

Two of the drifted sets are not stale by accident — they are stale by construction:

- **T-137, 32 of its 32 drifted paths** are
  `.saipen/saitranslate/kitchen/audit.json` and `kitchen/drafts/<locale>.json`. These
  are the generated output of the running translation kitchen; `git status` shows every
  one of them dirty against HEAD, because the kitchen rewrites them. A content-hash
  scope bound to a file a background process rewrites is stale the moment it is
  recorded.
- **T-206, 36 drifted paths**, are the 33 locale files plus `SettingsPage.tsx`,
  `settingsPageConfig.ts` and `zaicodeLocaleParity.test.ts` — the same translation
  sweep landing through a different plan.

So the drift is not "later tickets touched these files". It is, overwhelmingly, one
translation run landing after the scopes were recorded, recorded against two plans. The
scope-hash design has no way to express "this file is generated, hash it at ship time".

## What this changes for the operator's decision

T-215's three options were posed against a premise that no longer holds. Restated
against the measurement:

- **(a) re-bind T-144's 8 files** — does not unblock ship; refusal is on T-179 and
  continues into six other plans.
- **(b) retire or retarget SRC-110..113** — unchanged, and still the option that stops
  naming T-144 specifically. It does not address T-179/T-206/T-137.
- **(c) accept no local ship until a committed release receipt exists** — the status quo,
  and what T-9 and T-94 are actually waiting on.

Two options the measurement adds, neither taken here because both change what a release
contains:

- **(d) exclude generated artifacts from release scopes.** The translation kitchen's
  `kitchen/drafts/*.json` and `audit.json` are build output. Scoping a release to
  generated files means the scope is stale by construction; scoping it to authored
  source would let T-137 and T-206 go green without re-recording anything. This is the
  only option that both unblocks ship and keeps the scope meaningful afterwards.
- **(e) re-record all 112 paths now**, accepting that T-137's 32 and T-206's locale set
  drift again on the next translation sweep and the refusal returns.

This session did **not** re-record any scope, and did **not** ship or publish. Re-recording
asserts that the current content of 112 paths was reviewed and should ship; publishing is
outward-facing and irreversible. Both are release authority, which is exactly why T-215
exists. What this file does is replace the ticket's premise with the measured one.

## Reproduce

```
python - <<'PY'
import json, hashlib, os, glob
for f in sorted(glob.glob('.saipen/kitchen/release_scope/*.json')):
    d = json.load(open(f, encoding='utf-8'))
    paths = d.get('paths', {})
    drift = [p for p, h in paths.items()
             if not os.path.exists(p)
             or hashlib.sha256(open(p, 'rb').read()).hexdigest() != h]
    if drift:
        print(f.split('/')[-1], 'scoped', len(paths), 'drifted', len(drift))
PY
```