# Phase: CLEAN

## Purpose and safety floor

Run the repository hygiene mutations, strictly in the order below. CLEAN owns
proven-safe deletion, move, rename, prune and relocation. HUNT detects and
tickets; it deletes, moves and renames nothing.

Never delete user data without explicit confirmation. Ambiguous ownership,
load-bearing risk or missing recovery evidence becomes a ticket; if safe audit
cannot continue, enter BLOCKED. CLEAN reaches DONE only after safe completion.

**Files are deleted on proof of recovery, never on how obvious they look.**
Without confirmation, both CORE.md §1.1 authorization and one recovery proof
are required:

- tracked at HEAD, so the exact bytes can be restored; or
- mechanically regenerable by a named repository command.

Name the proof in the deletion LOG event. Untracked/non-regenerable content is
never deleted without confirmation. With no git, only regeneration can prove
recovery. The five-file cap is a **mass-deletion gate, not a grant of authority**:
it limits authorized recoverable deletion; it authorizes nothing.

**Moving or renaming a file needs a reference sweep first (`phases/hunt.md`).**
Search its path and basename across source, configuration, scripts, manifests
and docs. Update every reference atomically or treat any hit as a blocker. A
recoverable move can still break all consumers of the old path.

## Actions

1. **Board scrub**

   - Prune old DONE entries only after their permanent LOG evidence exists.
     A DONE ticket that any live ticket **still names in `needs:` MUST NOT be pruned**.
   - Prune TODO/BLOCKED only with cited evidence that it is superseded, already
     resolved or no longer applicable. Age alone proves nothing.
   - Re-evaluate blockers. Resolved -> TODO. A durable undecided item remains
     BLOCKED and surfaces one concrete `WAIT: blocked -- ...` question.
   - Repair duplicated ticket IDs/headings structurally by consulting LOG for
     the true state; keep one canonical ticket line. Never rewrite history.

2. **Orphans**

   Delete an unconnected asset/script only through the recovery gate. Ticket
   ambiguous ownership or use.

3. **Links and paths**

   Repair broken documentation links, imports and references. Moves still owe
   the pre-move sweep and atomic reference update.

4. **Trash and protocol storage**

   - Remove cache, temporary, backup, scaffold and empty-directory residue
     only when recovery/regeneration is named.
   - Protect `.saipen/kitchen/`. Core scratch is stale only after its owner is
     DONE, absent from BOARD, and its durable reasoning lives in LOG/CHANGELOG,
     or later canonical content explicitly supersedes it. SubSaipen scratch
     uses PROTOCOL.md §6's stricter five-class STALE verdict; age or collection
     count never qualifies. `saipen sub clean` also enforces live-work and
     recovery refusals.
   - When active LOG exceeds its soft cap (~300 lines/~64 KB), move it verbatim
     by whole lines to the next `.saipen/logs/LOG-<NNN>.md`; start a fresh
     active tail continuing the same event sequence. Never edit sealed history.
   - Run bounded journal compaction
     (`saipen_engine.journal.compact_committed`). Remove staged bytes only for
     COMMITTED/RESOLVED operations while retaining tombstone identity, status,
     semantic payload hash, target final hashes and timestamp. Never compact
     PREPARED/APPLYING/VERIFIED/CONFLICT/ABORTED evidence.

5. **Freshness**

   Confirm paths and project dependencies are current, clean and aligned.
   Regenerate a stale `KNOWLEDGE/INDEX.md` with `saipen knowledge index` and
   report malformed cards or orphaned supersession links. Age never authorizes
   deleting a card; only evidence-backed explicit supersession retires it.

## Exit

LOG exactly `- DATE [E-###] [parent: E-###] RUN: clean -> done @SHORT-HASH`,
then transition to DONE. Under `execution_intent: converge`, CLEAN is stage G;
CONVERGE.md owns its surrounding order, required post-mutation stages and
ambiguous-cleanup failure route.
