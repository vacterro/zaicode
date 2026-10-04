ZAICODE

MASTER EXECUTION ROADMAP — SILO WISHLIST GAP PASS

INPUTS

Wishlist:
silo_bundle_20261004_003004.zip

Current audit snapshot:
_ZAICODE_04.10.26-T00-35-27.zip

IMPORTANT

The audit snapshot does not contain the nested zcode source repository.
Use its SAIPEN machine truth/evidence for recovery, but inspect the real current
local zcode repository before modifying product code.

Do not treat this roadmap as permission to overwrite foreign/operator changes.

ORDER

WAVE 0
Converge/publish T-194 and reconcile duplicated Scheduler work.

WAVE 1
P0 runtime continuity and Worker/session regressions.

WAVE 2
Composer automation controls.

WAVE 3
Settings and Usage UX.

WAVE 4
Completion visibility and Worker empty-state.

WHY THIS ORDER

T-194 already implements seven large wishlist clauses.
Rebuilding them would waste time and risk regressions.

The new preset restart defect is P0 because restarting ZAICODE can interrupt
active autonomous work.

Worker/session correctness comes before new control surface work.

Settings/Usage polish is lower risk and can follow after runtime behavior is
stable.

RULES

- Reuse existing T-197..T-206 tickets.
- Do not create duplicate tickets for those requests.
- Ingest only the genuinely new 23:53/23:54 reports if they do not already have
  canonical receipts.
- Do not rewrite T-194 features.
- Do not weaken existing frozen oracles.
- One logically independent product fix per commit where practical.
- Preserve operator-owned work.
- Use packaged Electron acceptance for Worker/preset/pointer behavior.
- Continue autonomously across waves unless a real operator/external boundary is
  reached.

FINAL ACCEPTANCE

All wishlist items must end in one of:
- DONE with product evidence;
- ALREADY IMPLEMENTED with reused evidence;
- OPERATOR_REQUIRED with an exact manual observation;
- EXTERNAL_REQUIRED with a real unavailable external dependency.

No item may disappear merely because another broader ticket touched similar code.
