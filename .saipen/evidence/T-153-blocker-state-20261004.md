# T-153 — the recorded file collision is gone; the work is still outstanding

Measured 2026-10-04 against `V:\___VAC\__K\__CODE\_AI_STUFF_AGENTIC\_SAIPEN`.

## The recorded blocker, and what it measures now

`.saipen/recovery/board-compaction/T-153/T-153-*.BOARD.md`:

> TARGET_FILE_COLLISION: the first of the sixteen repairs is `saipen/CORE.md`, which git
> reports as `'M'`, and 14 files under `saipen/` are dirty in the same 1956-file tree.
> These repairs rewrite the rules this session executes under -- CORE.md §1.2, BOOT.md
> step 7, RFC §1.10 -- so applying them mid-run would change the protocol under the agent
> holding the seat. Same prerequisite as T-149 and T-150.

Every factual claim in that sentence was re-measured:

| claim on T-153 | measured 2026-10-04 |
| --- | --- |
| `saipen/CORE.md` git status is `M` | clean — `git status --short saipen/CORE.md` is empty |
| 14 files under `saipen/` are dirty | **0** — `git status --short saipen/` is empty |
| the tree is 1956 files | 4902 tracked files |

So the collision the ticket is named for no longer exists: nothing under `saipen/` has
uncommitted work, `CORE.md` among it. Whatever was being edited when T-153 was filed has
since been committed. The tree has more than doubled since that measurement.

## The work is not done

T-153's verify clause: *`tools/validate.py` emits zero cross-doc-drift warnings against
the installed saipen home.* It does not:

```
$ python tools/validate.py
exit=0
WARN [cross-doc-drift]: cross-doc drift [ahead-stamp-repair] -- CORE.md must say a
  future-stamped LOG line is restamped to a defensible bound with a DEC naming the
  original, the replacement, and that the minute is inherited rather than measured.
  Without it the only sanctioned response is waiting, which keeps a false record and reds
  every gate until the clock catches up
WARN [cross-doc-drift]: cross-doc drift [shortcut-memory-ban] -- RFC § 1.10 must state
  that answering a row from recall is the same failure as inventing a command, not a
  lesser one
WARN [cross-doc-drift]: ... and 10 more like the above
Validation complete. Agent is conformant. (30 warning(s))
```

Twelve cross-doc-drift warnings, of which the validator names two and elides ten. The
engine itself is conformant — exit 0 — and the repairs are documentation, not code.

## Why this was not simply applied

The blocker had two halves. The first, the collision, is gone. The second is not a fact
about the tree but a hazard: *these repairs rewrite the rules this session executes
under.* Applying them is authoring normative protocol prose — the text every future
agent reads before it does anything — unattended, mid-run, in a repository that carries
its own active work (T-169 records that repository as having active T-1600 and
uncommitted protocol changes as of its own measurement).

That is a decision with blast radius past this session, so it is recorded rather than
taken. The prerequisite the ticket itself names is satisfied; what remains is the
operator's call on whether the seat may rewrite its own governing documents.

## T-154, re-measured in the same pass

Its claim also still holds, but its recorded evidence has moved:

| claim on T-154 | measured 2026-10-04 |
| --- | --- |
| `subs.py` differs, `e21a1f7e` vs `d537a78b` | still differs — `cb72628d` vs `669704d` |

The split-brain is real and unresolved; both copies have changed since the hashes were
recorded, which is consistent with two engines being edited independently. No decay to
report here, only a refresh of the evidence.

## Reproduce

```
cd V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_SAIPEN
git status --short saipen/          # 0 lines
git status --short saipen/CORE.md   # empty
git ls-files | wc -l                # 4902
python tools/validate.py | grep -c "WARN \[cross-doc-drift\]"
```