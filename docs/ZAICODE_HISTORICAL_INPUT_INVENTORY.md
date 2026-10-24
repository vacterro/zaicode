# Historical discarded input inventory (workstream 3, read-only)

Source: the CLI ledger `db.sqlite` under the operator's `%USERPROFILE%\.zcode\cli\db\`,
opened `mode=ro`.
No row was mutated, no queue item was created, nothing was replayed.
Machine-readable form: `.saipen/evidence/historical-input-inventory.json`.

## Why this exists

The production ledger holds 179 `session_input` rows with `status='discarded'`
and `status_reason='session_resumed'`. They predate the T-419 recovery fix: the
old resume path discarded every admitted row it could not promote. That makes
them a plausible recovery surface, and a lethal one if replayed blindly.

## Classification result

| Class | Count | Basis |
| --- | --- | --- |
| UNRECOVERABLE | 149 | protocol control phrase, or owning session gone |
| ALREADY_EXECUTED | 15 | identical text promoted later in the same session |
| RECOVERABLE | 10 | unique actionable text, no duplicate, no cancellation |
| AMBIGUOUS | 5 | too short to identify intent |
| MISSING_ATTACHMENTS | 0 | none of the 179 names a resolvable attachment |
| CONFIRMED_CANCELLED | 0 | no discarded row matches a later explicit cancellation |

## The finding that matters

125 rows are the literal text `/goal cc all` and 26 are `cc`. A further several
carry them as a second line (`cc\n/goal cc all`, `test\n/goal cc all`). Replaying
any of them would not restore lost operator work; it would manufacture operator
authorization for a new governed run. That is why the control-phrase rule
outranks every other signal in the classifier, and why UNRECOVERABLE is the
largest class.

The same objection applies to the `saipen ship`, `saipen collect` and
`Run custom command /saipen` rows: they are protocol commands, not user intent.

## The ten genuinely recoverable rows

Seven of the ten belong to sessions in other projects, so they are shown here
only by queue id and length; recovering them belongs to those projects, not to
this workspace.

| Queue item | Where | Text (truncated) |
| --- | --- | --- |
| `queue_01a1267c-7139-74` | this project | ZAICODE MISSION Eliminate severe CLEAR... |
| `queue_01a1268b-4163-79` | this project | ZAICODE APPEND — MANDATORY LIVE WINDOWS... |
| `queue_01a1672f-7a62-7b` | this project | И исправь когда такая хрень при "cc"... |
| `queue_01a13180-0bdd-75` | another project | FASTPROMPTER GOAL: Replace the limited... |
| `queue_01a131a6-aa41-78` | another project | FASTPROMPTER APPEND — PER-SILO SCROLL... |
| `queue_01a15770-04a7-7f` | another project | И APC должны не приземляться... |
| `queue_01a15771-64f2-7a` | another project | Да, убедись что они кружат как чайки... |
| `queue_01a0d882-54d6-75` | `_SAIPEN` home | Запушь потом на гитхаб как бекап... |
| `queue_01a0f619-3d68-78` | another project | Конечно удалилилось темп... |
| `queue_01a0927e-4d8a-71` | another project | Run custom command /saipen... |

Seven of the ten belong to projects outside this workspace. Recovering them
here would be a cross-project write; they must be recovered from inside their
own project if at all.

The three `_ZAICODE` rows are quoted in full in the JSON inventory. Two are
stale campaign briefs whose goals were superseded by later handoffs; one is a
complaint about the `cc` path itself, which is diagnostic text rather than work.

## What a selective recovery operation must still do

Nothing in this inventory authorises execution. A recovery operation, when it is
built, must:

1. refuse any item classified UNRECOVERABLE, whatever the operator clicks;
2. require an explicit per-item decision and default to doing nothing;
3. write through a recovery journal that keeps the source `session_input.id`,
   instead of mutating the historical row;
4. be idempotent per `(source row id, target session id)`;
5. re-check duplicate text against the target session at commit time, because
   this inventory is a snapshot and the ledger keeps growing.
