# T-184 — the first-publish WAIT was never written by the gate

## The filed premise was wrong

T-184 was filed claiming "SAIPEN wrote a WAIT: first-publish that its own remote
classifier contradicts, stalling a green ticket on a gate that cannot fire."

The classifier half is right. The "SAIPEN wrote" half is false, and the difference
matters: nothing in the engine misfired, so there is no engine bug to fix here.

## What the engine actually does

One writer, one gate:

    release.py:1337   first_publish_wait=cls in (REMOTE_ABSENT, REMOTE_EMPTY)
    release.py:1377   return _apply_first_publish_wait(root, plan)
    release.py:2326   record_first_publish_wait(...)      <- the only writer

`_apply_first_publish_wait` is the sole producer of the canonical string
`_wait_message()` (release.py:2305-2307), and `record_first_publish_wait` is its
only callee. With `classification == ESTABLISHED` the branch at 1377 is
unreachable.

## The evidence that no gate fired

1. `git log -S "WAIT: first-publish" -- .saipen/STATE.md` -> **no commits**.
   The string was never committed to STATE.md in the history of this branch.
   (STATE.md is currently modified-uncommitted, which is consistent: the text
   was written to the working tree and never landed.)
2. `grep -rn "FIRST_PUBLISH_WAIT" .saipen/recovery/settled/` -> **no hits**.
   `_apply_first_publish_wait` returns `"code": "FIRST_PUBLISH_WAIT"`, so any
   real firing would leave a settled journal. None exists.
3. `grep -rn "record_first_publish_wait" tools/` -> one call site, release.py:2326,
   inside `_apply_first_publish_wait`. No other producer.
4. Provenance of the actual text: LOG E-2954
   (`reconcile-20261003012405708310`) is a hand-authored reconcile, and its
   pre-state is preserved verbatim at
   `.saipen/recovery/state-legacy-output/reconcile-20261003012405708310.STATE.md`:

       next_action: "WAIT: first-publish -- T-179 is implemented, verified and
       reviewed in zcode/ with exactly three reviewed paths staged and a clean
       index; reply 'publish' to commit and push to origin/zaicode, or 'hold' to
       leave it staged uncommitted"

That is prose describing a publication-authority decision. It borrows the
`WAIT: first-publish` prefix to look canonical. An earlier seat wrote it; I then
inherited it and read it as a gate.

## Why it still did damage

`entry.py:855` and `cold_recovery.py:782` route on `next_action.startswith("WAIT")`.
So a hand-written line with the right prefix halts continuation exactly like a
real gate would. The engine has no way to tell them apart, which is why the stall
looked authoritative.

## The residual that IS a real defect

`operations.py:10135` gates the first-publish *confirmation* on the same prose:

    if not na.startswith("WAIT: first-publish"):
        return _refuse("VALIDATION_FAILED", ...)

That precondition is satisfiable by any hand-written STATE line, with no journaled
operation backing it. It does **not** grant publication authority for an already
established remote — `execute_release` recomputes `first_publish_wait` from the live
classification at 1337 and only consults confirmation when that is true — so there
is no privilege escalation. The exposure is confined to a confirmation record that
can be journaled without a gate ever having fired.

Filed separately as T-185 rather than folded in here, because T-184's filed
defect does not exist and rewriting a ticket to describe a different defect is how
the board loses its meaning.

## Re-derived blocker hygiene

This is the T-151 lesson applied again: a blocker written in prose survives every
code change that would have invalidated it. T-179's WAIT line was re-derived
against `release.py:1337` and against the classifier's own answer (ESTABLISHED,
8 refs), and did not survive. Recorded in E-2954 with an explicit disclaimer that
it grants no publication authority and performs no push.
