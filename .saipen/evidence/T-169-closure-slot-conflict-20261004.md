# T-169 closure: the single-slot publication receipt conflict

Date: 2026-10-04. Recorded because the validator now carries exactly one FAIL and
that FAIL is not a defect in the fix -- it is the resolver correctly refusing to
accept a publication that never happened.

## The failure, verbatim

```
FAIL: closure provenance does not resolve: T-169: implementation source
'release:0b78ff221ea19d2bf87f18cddd8f1b9bc61fbabf' cannot be resolved to a durable
published release; no COMMITTED release receipt names
'0b78ff221ea19d2bf87f18cddd8f1b9bc61fbabf' -- a DONE line may record HOW it closed,
never that something was published when it was not (CORE-003)
```

## Two frozen closures, one receipt slot

Both rows are terminal machine-written BOARD lines. Neither can be re-written by
any command that exists.

```
T-107 | closure_mode: inherited_verified | implementation_source: release:release-T-108-046a5fb44352
T-169 | closure_mode: inherited_verified | implementation_source: release:0b78ff221ea19d2bf87f18cddd8f1b9bc61fbabf
```

`_published_releases` (tools/saipen_engine/closure.py) collects from two places and
both are the SAME file:

1. `_committed_release_receipts(root)` -- a journal scan over
   `.saipen/recovery/ops` and `.saipen/recovery/settled`, accepting a record only
   when `operation == "release"` and `status == "COMMITTED"` and
   `release_stage == "COMMITTED"`; plus `.saipen/kitchen/release_receipt.json`
   itself when that file says `operation: "release_receipt"`.
2. the raw `.saipen/kitchen/release_receipt.json` object, accepted whatever its
   `operation` says, then filtered by `_is_published`.

The journal arm contributes nothing here. Enumerating every `"operation"` literal
the engine emits (`grep` over `tools/saipen_engine/*.py`) yields no `release`
value at all -- the release values in use are `release_receipt` (the clone-visible
closure artifact) and `cohort_ship`. `saipen ship` writes release receipts to the
kitchen file, not to the journal: `release.py:3148` `_release_receipt_target`
serialises `{schema_version, operation: "release_receipt", op_id, version, tag,
ticket_id, source_head, source_tree_fingerprint, mode, crew_epoch, cohort_id,
project_lineage, recorded_at}` into `.saipen/kitchen/release_receipt.json`.
`tools/release_provenance.py` writes the same single path (`RECEIPT_RELPATH`).

So the design is deliberate and clone-safe: ONE clone-visible publication identity
per project root. The journal tree is gitignored producer state and does not
survive a clone, which is exactly why the kitchen file exists.

## Why the two identities cannot share one record

`_release_matches` compares the wanted id against five SINGLE-VALUED slots:

```python
candidates = {op_id, version, tag, commit, release_commit}
candidates.discard("")
if wanted in candidates: return True
return wanted.lstrip("v") in {c.lstrip("v") for c in candidates}
```

`release-T-108-046a5fb44352` would have to sit in one field and
`0b78ff221ea19d2bf87f18cddd8f1b9bc61fbabf` in another of the same dict. That
receipt would claim T-108's op_id names T-169's commit -- a fabricated identity,
which is the precise thing `tools/release_provenance.py` exists to prevent:

> "a receipt typed by an agent is not a receipt a release process committed, and the
> whole reason the closure resolver insists on committed evidence is that 'it
> shipped' must not become true before anything shipped."

Not written.

## Every reopen path, and its exact refusal

| path | refusal |
| --- | --- |
| `ticket block T-169` | `block accepts DOING or TODO; T-169 is under ## DONE` |
| `ticket unblock T-169` | `unblock accepts only BLOCKED` |
| `claim T-169` | `T-169 is under ## DONE` |
| `ticket supersede T-169 --by ...` | refuses a self-cycle; the `superseded_verified` branch only fires for that exact closure mode |
| `saipen undo` | `INVALID_MANIFEST: no Restore Milestones exist` |
| `saipen ship --dry-run` | `STALE_PLAN` on `zcode/scripts/zaicode-soak-verdict.mjs` (T-215's measured scope drift) |
| `ticket resolve-external T-169` | `TICKET_ALREADY_DONE` -- "external resolution never rewrites another closure mode" |
| `ticket repair-metadata` | only `--field source_receipts`; `implementation_source` is not a repairable field |

## The decision

Keep T-108's receipt in the slot. It is truthful and checkable:
`046a5fb443525bba5b291d5f9a37ef5984acba6f` resolves as a real commit in this
repository (`git cat-file -t` -> `commit`), and it is the state this project was
found in. T-169's own closure is the newer, weaker claim: `0b78ff22` is an
evidence-document commit in this repo, not a publication of anything, so naming it
as a release was the wrong closure for a ticket that produced no bytes.

The residual FAIL is therefore a true statement -- "T-169's inherited authority
cannot be located" -- and swapping the slot would only move it onto a legitimate
pre-existing closure.

## What would clear it, and why it is not this seat's call

A multi-slot publication receipt store: `_published_releases` additionally scans
`.saipen/kitchen/release_receipts/*.json`, and `tools/release_provenance.py`
grows a non-destructive append beside the overwrite. Backward compatible -- the
single file keeps resolving exactly as today -- and it does NOT loosen CORE-003:
an authority that still cannot be found still FAILs. It only stops two legitimate
closures from competing for one slot.

It changes what "durable publication evidence" means in an engine every seat runs,
and the check being relaxed here is one the owner deliberately strengthened (the
CORE-003 mutation battery at tools/audit_checks.py:2098 proves the check fires).
Engine source in `_SAIPEN` is governed by that project's own board and release
path; editing it from this seat, as this seat, to make this seat's validator green,
is the hand-write antipattern all over again. Filed as T-219.

## Reading order after the next commit

`saipen work reverify T-113` and only then `saipen validate`. Committing the
reverify receipt re-arms the T-113 boundary check, so the order is
commit -> reverify -> validate, and the four generated receipts under
`.saipen/recovery/` stay uncommitted on purpose.