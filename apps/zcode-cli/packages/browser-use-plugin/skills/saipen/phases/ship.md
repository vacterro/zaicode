# Phase: SHIP

## Purpose and entry

Publish one reviewed ticket: finalize release metadata, commit the exact
reviewed scope, push the branch, push its release tag, then finish atomically.
`PUBLISH` is an action, not a phase. Enter only on `saipen ship`, an opted-in
repository (existing `origin` plus prior ship evidence), or goal execution
with an existing `origin`. All mandatory verification and REVIEW must be green.

Pre-publish defects route `SHIP -> BUILD`, then repeat `VERIFY -> REVIEW ->
SHIP`. Use BLOCKED only when user input or an unknown safe fix is required.
Once commit/tag/push starts, use the recovery rules below; a successful push
never routes this ticket back to BUILD.

## `mode: no-publish`

The phase still runs, but CORE.md §1.3 forbids commit, tag and push.
**`no-publish` means publishing is not permitted. It does NOT mean git is
absent.** Test git availability independently.

| Work | `no-publish` |
|---|---|
| Board, README, version, junk, local metadata, core gate | run |
| Release-tag equality clause | omit |
| Remote classification, staging, ship gate, commit, branch/tag push | skip |

LOG exactly: `- DATE [E-###] [parent: E-###] RUN: ship vX.Y.Z -> skipped
publish (no-publish: <reason>)`, where `<reason>` is `policy` when git works
but publishing is disabled, or `no git` only when git cannot answer. This is
not a failure. Write the digest, then finish into DONE.

## Closure intent: determine BEFORE demanding a Git scope

Ticket closure (`saipen ticket done --closure-mode ...`) is NOT the same
operation as Git publication. The exact per-ticket diff requirement applies
only to `own_patch`. Decide the mode first; a verification-only or cohort
ticket must never BLOCK solely because its personal diff cannot be isolated
(orchestration repair, T-1302 / FastPrompter regression):

- `own_patch` — this ticket owns an attributable implementation delta. Run
  the full reviewed-scope release path below unchanged: exact path
  attribution, explicit staging, foreign bytes preserved, ship gate,
  commit/tag/push when publishing is enabled.
- `inherited_verified` — this ticket adds NO implementation delta; it
  independently verified implementation whose durable publication authority
  already exists elsewhere. Record `BUILD` no-delta evidence, `VERIFY` PASS,
  `REVIEW` PASS, then close with
  `saipen ticket done <T-###> --closure-mode inherited_verified
  --implementation-source <T-###|SRC-###|release:<id>>`. Do NOT demand a
  synthetic per-ticket Git diff, do NOT stage unrelated inherited files, do
  NOT create an empty release commit. Evidence closure, not a fake patch.
- `cohort` — this ticket owns part of a shared verified batch (overlapping
  files such as one accumulated `main.py`). Members never isolate fictional
  per-ticket blobs; each closes with
  `saipen ticket done <T-###> --closure-mode cohort --closure-cohort C-###
  --paths <shared paths>`, which binds the live bytes into the durable
  cohort registry. Publication belongs to the cohort authority:
  `saipen cohort ship C-###` freezes ONE batch scope (each shared path
  once), publishes through the exact release-integrity machinery, and flips
  the registry record to shipped with the release identity. While a cohort
  is pending, a member is evidence-complete but NOT published.

## Procedure

0. Confirm every shipped work unit has a ticket and the active ticket remains
   in `## DOING`; CORE.md §1.2 owns board freshness and attribution. For a
   cohort/crew terminal publication the local Core phase is DONE / task none
   and the batch authority (cohort registry) is the active surface.
1. Update README release-facing material and choose the semantic version bump.
2. Make the release identity consistent before push:
   - `VERSION` is canonical;
   - the root and every discovered locale README badge equal it exactly once;
   - the newest CHANGELOG entry equals it;
   - the intended tag is `vVERSION`.
   `tools/validate.py --gate ship` discovers locale mirrors from the
   translation kitchen; do not maintain a second list.
3. Apply `.gitignore`, secret, temporary-file and debug-output hygiene.
4. **Classify the remote BEFORE any external write.** Read `origin`, then
   `git ls-remote --heads --tags origin`. No `origin`, or an origin with no
   commit/tag, is first publish. Stop before all writes with
   `next_action: WAIT: first-publish -- confirm repo name '<name>' and
   public/private before I push`. Goal execution never bypasses this gate.
5. Finalize local metadata and run `tools/validate.py --gate core` after the
   last edit. Producer-package freshness is enforced when that package is
   consumed, not as a Core ship prerequisite. This core gate is a signal; the
   binding staged-set gate is below.
6a. **LOCAL. Touches no repository and no remote.** Complete steps 0-5 only.
6b. **GIT. Writes the repository and the remote.** Run in this order:

   1. Read `git status --porcelain=v1 -uall` and the staged set. Save the
      pre-ship index with `git write-tree` for rollback.
   2. Attribute every intended path to this ticket/wave. Unattributed work
      stops SHIP.
   3. Preserve all user-prestaged bytes. A foreign staged path must not enter
      the release; stop unless it can be isolated without changing that path.
   4. **Stage ONLY the reviewed files this ship owns** with explicit paths.
      **`git add .` and `git add -A` are
      forbidden here** because they widen the reviewed scope.
   5. Re-read the index and prove it equals the intended scope.
   6. **Run `tools/validate.py --gate ship` NOW.** It binds the staged release,
      requires a non-empty release index, checks discovered release paths and
      refuses staged/working divergence on the version surface.
   7. Run `git diff --cached --check`.
   8. **Commit exactly the staged scope.** Never use `-a` or widening paths.
   9. **Push the branch.** Immediately before branch push, and again before
      tag push, re-read remote first-publish state. If it changed to
      established, continue; otherwise return to step 4's gate.

   If the binding gate or diff check fails, do not commit/push/tag. Restore
   owned release paths in the index from the saved index tree, never from
   `HEAD`; leave foreign staging byte-identical, then route to BUILD.
7. **ONLY AFTER step 6b's branch push has LANDED** (push success, or fetched
   remote branch equals local branch), create `vVERSION` and push only
   `git push origin refs/tags/vVERSION:refs/tags/vVERSION`. Never use
   `--tags` or `--follow-tags`. A failed branch push means no tag push.
8. LOG success exactly: `- DATE [E-###] [parent: E-###] RUN: ship vX.Y.Z ->
   pushed HASH`.

## Push recovery

On failure LOG exactly: `- DATE [E-###] [parent: E-###] RUN: ship vX.Y.Z ->
push FAILED <reason>`; never claim success. The commit/local tag remain local.

- Transient network/auth failure: retry once with the changed condition named
  in LOG; a retry without delta is illegal. A second failure -> BLOCKED.
- Non-fast-forward: fetch and inspect incoming changes. Read changes touching
  `.saipen/` or this release; otherwise rebase, rerun validation, recreate the
  local tag on rebased HEAD, verify tag commit equals HEAD, then retry. This
  local tag was never pushed because step 7 follows landed branch push. A tag
  from an earlier completed release is remote history and needs the global
  force-push confirmation gate. Rebase conflict -> BLOCKED with file facts.
- Other non-transient or unsafe ambiguity -> BLOCKED. Never force-push to
  resolve rejection.

## Exit and evidence

After successful or intentionally skipped publish, overwrite
`.saipen/kitchen/digest.md` with exactly three short lines: `done:`,
`remaining:` and `awaiting:`. It is a snapshot, not history.

Finish with the journaled `saipen ticket done`: only phase SHIP may atomically
move the ticket `## DOING -> ## DONE`, record completion and transition to
DONE. **The shipped ticket was still in `## DOING` when this phase began**;
REVIEW never closes it. Under goal execution, DONE immediately follows its
MAINTENANCE routing instead of becoming a stopping point.

Failure summary: fixable and pre-publish -> BUILD; classified push failure ->
recovery above; user decision or no known safe action -> BLOCKED with facts.
