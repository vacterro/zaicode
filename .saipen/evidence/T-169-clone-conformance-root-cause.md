# T-169 — why a fresh clone of `_SAIPEN` FAILs conformance

Written 2026-10-03 while re-auditing the BLOCKED board after T-179 closed. T-169's
board blocker was `TARGET_FILE_COLLISION` ("the engine repo's in-flight work must be
settled by its owner"). That premise no longer holds, so the ticket was re-derived
against the tree as it actually is rather than as it was written.

## The collision is gone

```
$ cd _SAIPEN && git status --porcelain | wc -l
3
```

The tree the blocker describes had 1956 dirty files. It now has three, all protocol
bookkeeping (`.saipen/BOARD.md`, `.saipen/LOG.md`, `.saipen/STATE.md`). The specific
targets T-153 and T-156 name are clean:

```
$ git status --porcelain -- saipen/CORE.md saipen/BOOT.md saipen/OPS.md saipen/IMPROVE.md
(empty)
```

So T-153 and T-156 are no longer blocked by a file collision. T-153's substance is
still real: `validate.py` still emits the 16 cross-doc-drift warnings, including
`[ahead-stamp-repair]` and `[shortcut-memory-ban]`.

## T-169 reproduces, but smaller than recorded

```
$ git clone --no-hardlinks -q . /tmp/t169clone
$ cd /tmp/t169clone && python tools/validate.py | grep -c '^FAIL'
14
CLONE_VALIDATE_EXIT=1
```

The board records 163 FAILs, "121 of them 'active receipt SRC-0NN has no metadata'".
That is history: the receipt-bundle FAILs were committed as `9daae7d9`. The residual
is 14, and it decomposes as:

- **11 × `closure-evidence`** — DONE tickets with no current-tree receipt
- 1 × `source receipts` — SRC-130 INVALID
- 1 × `improve-report` — preserved report sha256 mismatch (tamper detection working)
- 1 × `KNOWLEDGE` — `INDEX.md` is stale

## Root cause: receipts are gitignored, so they cannot ship

This is the finding that matters, and it is not what the ticket assumed.

```
$ git check-ignore -v .saipen/recovery
.gitignore:12:.saipen/recovery/    .saipen/recovery
$ git ls-files .saipen/recovery | wc -l
0
```

`.saipen/recovery/` is ignored and **zero** files beneath it are tracked. Every
re-verification receipt — the thing `closure-evidence` demands — lives only on the
machine that ran it. The clone has:

```
$ ls /tmp/t169clone/.saipen/recovery/settled
ls: cannot access ...: No such file or directory
```

The validator reads that absence as "unproven closure" and FAILs 11 legitimately-closed
tickets. The clone is not broken. **The evidence was never distributable in the first
place.**

### Why the obvious remedy does not work

Re-verifying the 11 tickets writes new receipts into `.saipen/recovery/settled/` — the
same ignored directory. They would appear on this machine and the clone would still
FAIL. Any fix that consists of running `saipen work reverify` repeatedly is treating a
symptom.

### The two candidate fixes, and why the second is wrong

1. **Stop ignoring the receipt ledger.** Makes the clone conformant. But the ignore is
   deliberate — `.gitignore` carries the comment that quarantined receipt bodies are
   "local source authority, never a Git or archive distribution surface". Reversing that
   is a policy decision about what the engine repo ships, not a bug fix.
2. **Make the validator treat an absent ledger as UNKNOWN rather than unproven.** This
   is what makes a clone green without weakening the gate on a real seat — but it
   touches `validate.py`, the gate every seat in every project reads. The comment at
   `validate.py:3886` is explicit that an absent event is "explicitly UNKNOWN legacy
   provenance, never an invitation to infer evidence from the checkbox". Extending
   UNKNOWN to "no receipts exist anywhere in this tree" is a real semantic change.

Both need the engine owner's decision, because both change engine-repo policy rather
than fixing a defect in it. That is why this stays BLOCKED, with a different and
sharper reason than the one on the board.

## Measured for the next pass

- Source tree: `python tools/validate.py` → exit 0, 34 warnings.
- Clone: exit 1, 14 FAILs (11 closure-evidence + 3 other).
- `_SAIPEN` HEAD `da23881f`, T-185's fix confirmed present in `operations.py`.