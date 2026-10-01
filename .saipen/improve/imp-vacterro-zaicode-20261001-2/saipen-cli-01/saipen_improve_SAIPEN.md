agent: saipen-cli-01
role: core
model_or_runtime: unknown
project: vacterro-zaicode
saipen_version: 8.0.1
protocol_fingerprint: sha256:ff442546a30e0d955ba9690a8893673c580d2c03cf031277695534796e4f4d38
source_head: b7eb0d2236687fcf57b083047c7217664834987a
source_tree_fingerprint: git-delta-v1:a15d9b96f4cfdac6ce9e7d50825f11e4de6cae063422b350cf95a333332cb421
discovery_model: git-delta-v1
context_scope: SAIPEN audit, phase DONE
context_available: partial
report_status: complete

## RUN 1

IMP-001 [P1] [PROTOCOL_VIOLATION] [reproduced] [ticket] -- Two divergent SAIPEN checkouts; validating against the non-executing one yields a false problem set and a wrong style_contract
  expected: One SAIPEN engine. The validator an agent runs is the validator that governs its checkpoint.
  actual:   bin/saipen.cmd is a shim that runs V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_SAIPEN/tools/saipen.py, so _SAIPEN is the executing engine. C:/Users/vac34/AppData/Local/saipen/scheduled-source/ is a second, byte-different checkout that nothing runs.
  evidence: sha256 of tools/saipen_engine/subs.py: _SAIPEN e21a1f7ee67e4a0e, AppData d537a78bab451bed. Same project root, two validators: _SAIPEN reports 'Validation complete. Agent is conformant', AppData reports 'Validation FAILED: 3 problem(s)'. Their STYLE.md boot markers differ -- ded-71fc58de (executing) vs ded-4ae736e4 (AppData).
  impact:   Acting on the AppData report makes the agent rewrite a correct STATE.md style_contract to the wrong marker; `saipen validate` then refuses the checkpoint as malformed. Reproduced end to end: the edit was made, committed as 706eb3bb's successor, and reverted as b7eb0d22.
  fix:      Either delete the scheduled-source checkout, or make bin/saipen.cmd resolve the engine it runs and have the other path point at it, so no second engine can answer for the session.

IMP-002 [P2] [PROTOCOL_VIOLATION] [reproduced] [ticket] -- phases/clean.md's board-scrub precondition is insufficient: permanent LOG evidence is not enough while an active receipt names the Work
  expected: phases/clean.md action 1: 'Prune old DONE entries only after their permanent LOG evidence exists.'
  actual:   LOG evidence is necessary but not sufficient. Pruning 61 of 82 DONE lines, all of them with permanent sealed LOG evidence, produced FAIL 'source receipts -- active receipt SRC-036 references missing Work T-47' and 9 more of the same shape, all at once.
  evidence: BOARD.md ## DONE pruned 82 -> 21 lines; validator went from 0 FAIL to 10, one per active receipt naming a pruned Work (SRC-036/T-47, SRC-037/T-48, SRC-051/T-71, SRC-052/T-72, SRC-053/T-72, SRC-054/T-82, SRC-055/T-83, SRC-056/T-85, SRC-057/T-86, SRC-058/T-89). Reverted with git checkout; back to 0 FAIL.
  impact:   An agent following CLEAN exactly as written destroys the receipt-to-Work binding and reds the gate. The BOARD line is the Work's existence record; it cannot be retired ahead of the receipt that references it.
  fix:      State the real precondition: a DONE entry may be pruned only when no ACTIVE source receipt names that Work, in addition to the LOG evidence already required.

IMP-003 [P3] [OTHER] [observed] [ticket] -- closure-evidence ordering is undocumented: any tracked-file edit after `work reverify` invalidates the receipt it just wrote
  expected: A reverify receipt is closure evidence for the current tree, and the natural order is commit, then re-verify.
  actual:   current_tree_reverify binds source_head and source_tree_fingerprint, the latter being git-delta-v1 over `git diff HEAD` plus untracked files. Any tracked-file edit after the receipt moves the fingerprint and the receipt stops counting, with the gate reporting 'no current-tree PASS re-verification receipt'. Receipts themselves do not move it -- probed: writing under .saipen/recovery/ leaves the fingerprint unchanged.
  evidence: RV-000029/RV-000030 recorded git-delta-v1:a15d9b96 at HEAD 90cf944e with project_identity, project_lineage and ruleset_fingerprint all matching live; after a single sed edit to .saipen/STATE.md the live fingerprint became c66baf69 and both tickets fell back to FAIL. Commits move it too.
  impact:   Conformance on T-113 and T-145 is only green in the window between the last tracked-file write and the read. The green state cannot be committed, because committing moves HEAD.
  fix:      Document that reverify must be the last mutating act before the gate is read, and that its receipts are expected to be uncommitted at that moment.

IMP-004 [P3] [VAGUE] [observed] [note] -- `ticket compact` answers a board-scrub request with a character-cap message
  expected: An agent reading `ticket compact` after being asked to reduce board size learns whether it worked.
  actual:   The reply was 'reason: T-153 is already within the 1200-character BOARD cap', which describes a per-line cap while the caller wanted the section pruned.
  evidence: `saipen ticket compact T-153` on a 42.9 KB ## DONE section. CLEAN's board scrub is a different operation and has no command; compact does not perform it.
  impact:   Cosmetic, but it sends an agent looking for a command that does not exist instead of to phases/clean.md action 1.
  fix:      Say plainly that compact only trims one ticket line and does not prune closed entries.
