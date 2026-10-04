# T-169 -- the published engine distributable, re-measured (2026-10-04, second run)

## What was already known

`.saipen/evidence/T-169-clone-20261004.txt` (13:56 today) recorded the first
clean result: a fresh clone of published engine HEAD validated `exit 0`, `0 FAIL`,
`30 WARN`. That run proved the positive half only. The saved resumption
instruction for this ticket was explicit about what was still missing:

> Resume verification-only Work, prove a negative instrument control and restore
> exact clone STATE; require a published carrying fix and truthful warning scope
> before closure.

Those four things are what this run adds.

## 1. The published distributable, cloned from GitHub itself

The earlier clone was made from the engine home on disk. That proves the local
tree; it does not prove the distributable. So the ticket's own instrument was
run against the remote directly:

```
git clone --no-hardlinks https://github.com/vacterro/saipen.git <dest>
  -> HEAD 445d2478257f03c57026a6b97a8291caa97ab865   (== origin/main, confirmed
     by git ls-remote --heads origin before the clone)
  -> 394 tags, 0 untracked, 4902 files checked out
python tools/validate.py --project-root <dest>
  -> exit 0, 0 FAIL, 30 WARN
```

Its PASS/WARN line list is **byte-identical** to the local-origin clone's
(`diff` over every `^PASS|^WARN|^FAIL` line: no differences), and both clones
report the same tree object `6fde435324ebdb8d743fa6867ca82698186f3761`.

A `--depth 1` clone was also tried and is the wrong instrument: it reports 31
WARN, because without history the 24 sealed hunt marks cannot resolve
(`hunt-mark-unresolvable`) and the tag list is empty (`release-ledger: git tag
list unavailable or empty`). Both are artifacts of the shallow clone, not of the
distributable. Recorded here so the number is not mistaken for a real delta.

## 2. Negative instrument control -- the check would still fire

A `0 FAIL` result is only evidence if the same instrument can still produce a
FAIL. The control reproduces the ticket's own historical defect class:

```
cd <clone> && rm .saipen/intake/active/SRC-015.meta.json
python tools/validate.py --project-root <clone>
  -> exit 1
  -> FAIL: source receipts -- active receipt SRC-015 has no metadata
  -> FAIL: source receipts -- ORPHAN_RECEIPT SRC-015
  -> Validation FAILED: 2 problem(s), 30 warning(s)
```

`FAIL: source receipts -- active receipt SRC-0NN has no metadata` is verbatim the
class that produced the historical 163 FAILs (121 of them). The instrument still
catches exactly that, so the clean clone result is a measurement and not a
rubber stamp. The clone carries 127 `.meta.json` receipt sidecars under
`.saipen/intake/active/`; deleting one is enough to red the gate.

## 3. Clone STATE restored exactly

```
git checkout -- .saipen/intake/active/SRC-015.meta.json
git status --porcelain=v1 -uall   -> 0 lines
git rev-parse HEAD                 -> 445d2478257f03c57026a6b97a8291caa97ab865
python tools/validate.py           -> exit 0, 0 FAIL, 30 WARN
```

The clone is left at the published commit with an empty porcelain, so the second
run's starting state equals its ending state.

## 4. Carrying fix is published

The three engine commits that closed the historical clone-provenance defect are
ancestors of the published `refs/heads/main`:

| commit | subject | ancestor of `445d2478` |
|---|---|---|
| `a157e654` | fix(distribution): make a clean clone read the same record as this checkout | YES |
| `f0a637b2` | fix(registry,shards): register the refusal the clean clone needed; count sandboxes per shard | YES |
| `9daae7d9` | fix(receipts): ship the archived source receipts a fresh clone needs | YES |

None of the three is inside a release tag (`git tag --contains` is empty for all
three, and the validator's own `release-ledger` WARN says the same about
`v8.0.2` and `v8.1.0`). They are published on the branch, which is what
`git clone` actually delivers -- but they are **not** inside a tagged release,
and that is the reason this ticket cannot close as `inherited_verified` (see the
closure note below).

## 5. Truthful warning scope -- the 30 WARNs, classified

| slug | n | what it means in a clone |
|---|---|---|
| `producer-package-stale` | 8 | producer packages (e.g. `[HUNT-014]`) whose `source_head` predates published `445d2478`. The validator says so itself: reported under `--gate core`, MUST NOT be collected, blocks nothing. |
| `cross-doc-drift` | 12 | the docs lag the validator's own rules. Not clone loss -- the source tree has the same family, and T-153 already owns it (16 rules; 12 of them surface here). |
| `board-soft-cap`, `log-soft-cap`, `log-missing-date` | 3 | size/history hygiene of BOARD.md and LOG.md. Identical in the source tree. Not distributable defects. |
| `op-id-ledger-absent`, `hand-authored-op-id` | 2 | 89 historical `[op: ...]` ids predate the journaled ledger; the validator exempts them as sealed history (T-1282). |
| `goal-reauth-untripped` | 1 | a goal reauth line cleared counters that had not tripped. History record. |
| `translation-surface-absent`, `saiui-mission-absent` | 2 | gitignored producer state (`saitranslate/kitchen/`, `SAIUI_SAISENT_MISSION.md`) absent from a fresh clone. The validator states the consequence plainly: **this checkout has proved nothing about locale coverage.** |
| `subsaipen-uncollected` | 1 | 4 OUTBOX entries at `status: ready`, visible only when someone runs `saipen sub collect`. |
| `release-ledger` | 1 | `v8.0.2` and `v8.1.0` have a CHANGELOG entry but no git tag. |

**Not one of the 30 is a clone-provenance FAIL.** Two of them
(`translation-surface-absent`, `saiui-mission-absent`) explicitly mark a surface
this run measured nothing about, and that is stated rather than glossed: this
ticket says nothing about locale README parity, the 32 locale sources, the 3 root
mirrors, or the saiui mission contract.

## 6. The source tree no longer exits 0 -- and the reason is another seat

The ticket's contrast sentence was "163 FAILs in the clone where the source tree
exits 0". Run today against the engine home:

```
python tools/validate.py --project-root <_SAIPEN>
  -> exit 1, 2 problem(s), 31 warning(s)
```

Both FAILs are uncommitted in-flight work belonging to a live seat, not a
regression of the published history:

1. `FAIL: runtime manifest names a file git does not track:
   tools/test_t1612_accidental_success_reproduction.py` -- `tools/run_scenarios.py`
   is one of 13 modified tracked files in the engine home; the live seat added the
   manifest entry for a test file it has not committed yet (file mtime 19:51
   today). The clone has no such manifest entry and no such file, which is why
   the clone's `runtime manifest complete (599 files, all tracked)` PASSes.
2. `FAIL: cross-doc drift [root-file-set] -- ['unit1612.log']` -- an empty root
   scratch file, untracked, mtime 20:09 today, created by the same in-flight
   activity.

Neither is committed or deleted here: the engine home belongs to the seat
currently working in it, and its dirty set is 13 modified + 4565 untracked paths
of in-flight T-1600/T-1612 work. This is the TARGET_FILE_COLLISION shape already
recorded on T-153. Both FAILs clear on their own once that seat commits or
removes its scratch.

## 7. VERIFY re-run, end to end, on the published clone

The control and the restore were repeated on the GitHub clone itself rather than
only on the local-origin one, so the whole acceptance rests on the published
artifact:

```
cd <github clone>                       # HEAD 445d2478, 0 untracked
rm .saipen/intake/active/SRC-015.meta.json
python tools/validate.py --project-root <github clone>
  -> exit 1, Validation FAILED: 2 problem(s), 30 warning(s)
  -> FAIL: source receipts -- active receipt SRC-015 has no metadata
  -> FAIL: source receipts -- ORPHAN_RECEIPT SRC-015
git checkout -- .saipen/intake/active/SRC-015.meta.json
git status --porcelain=v1 -uall  -> 0
python tools/validate.py --project-root <github clone>
  -> exit 0, 0 FAIL, 30 WARN
git rev-parse HEAD             -> 445d2478257f03c57026a6b97a8291caa97ab865
```

## Closure consequence

T-169's own defect is **gone and published**: the distributable a fresh clone
receives validates at `exit 0, 0 FAIL`. The blocking fact for closure is not the
product but the publication authority. Both legal `inherited_verified` sources
were tried and both were refused, verbatim:

```
$ saipen ticket done T-169 --closure-mode inherited_verified \
      --implementation-source T-163
REFUSE [VALIDATION_FAILED]
reason: T-163 is DONE but no committed release evidence names it; DONE is an
evidence claim, never proof of publication

$ saipen ticket done T-169 --closure-mode inherited_verified \
      --implementation-source release:445d2478257f03c57026a6b97a8291caa97ab865
REFUSE [VALIDATION_FAILED]
reason: implementation source 'release:445d2478257f03c57026a6b97a8291caa97ab865'
cannot be resolved to a durable published release; no COMMITTED release receipt
names '445d2478257f03c57026a6b97a8291caa97ab865'
```

This is the RELEASE_AUTHORITY_PENDING shape already recorded on T-9 and T-94,
in a different repository. `own_patch` is not the honest answer either: it
declares that this ticket owns an implementation delta, and it owns none -- the
commits are another seat's work in another repository, and claiming them as this
ticket's patch would be exactly the fabrication SRC-148 forbids.

**The operator action, precisely scoped:** in the engine repository, tag and push
a release that contains `a157e654`, `f0a637b2` and `9daae7d9` (`git tag v<VERSION>
445d2478 && git push origin refs/tags/v<VERSION>:refs/tags/v<VERSION>`), then
record the release as a committed receipt in this project. `VERSION` already
reads `8.1.0` and the validator's own `release-ledger` WARN names `v8.0.2` and
`v8.1.0` as CHANGELOG entries with no tag, so the gap is known on both sides. That
tag must not be cut from this seat: the engine home carries another seat's
uncommitted work, and publishing is not this session's call.