# SAICRITIC -- the self-critique process (T-603)

SAICRITIC is the periodic full self-critique of SAIPEN against the five proof
levels. It is not a separate phase -- it is a real Improve cycle whose seat
role is `critic` and whose subject is the protocol's own mechanical layer.

## What it does

For every claim a wave made (its tickets' `verify:` clauses and the checks
that implement them), classify the proof as:

| Level | Question |
|---|---|
| UNIT | is the operation locally correct? |
| COMPOSITION | does the predecessor/successor chain work? |
| CANONICAL | do the repository invariants validate? |
| GATE | did the REQUIRED semantic/protocol gates actually occur? |
| PROVENANCE | does the evidence bind the exact source, session, run, finding and result it claims? |

A claim with a missing layer is NOT PROVEN -- record it as such, never PASS.
The permanent invariant: VALID END STATE != PROOF OF REQUIRED PROCESS.
The provenance invariant: VALID RESULT + VALID PROCESS != VALID EVIDENCE LINK.

## How it runs

1. Run `saipen improve --role critic --new-seat` to register a real Improve
   cycle (`cycle_status: active`) with a `critic` seat; the report is written
   like any seat report under
   `.saipen/improve/<cycle>/<seat>/`.
2. The audit targets the wave's mechanical layer: the finish gate, the
   sweep-ticket linkage, the report schema, the reasoning gates, the
   target-aware verifier, the context projection, the command surface.
3. Every finding carries the five-level classification in its `expected/
   actual/evidence` block; a `PROTOCOL_VIOLATION` finding records the
   cross-project recurrence reasoning and the weak-model answer on its
   canonical ticket (IMP-003 spec, T-558).
4. Findings are swept with the normal Core sweep; root-cause dedup produces
   one canonical ticket per root cause.
5. A finding whose subject was ACCIDENTAL_SUCCESS (a wave claim met by luck,
   not by verification) is recorded honestly: either reclassify the gap as a
   real defect (LOGIC_ERROR) or dispose it as unverified -- never flip it to
   PASS in the sweep.
6. The cycle completes (full sweep coverage) and is archived with provenance.

## Permanent lenses

The proof levels are also applied to recurring boundary failures. These names
are audit lenses, not a demand for one new enum per phrase:

- `COMMAND_SURFACE_SPLIT`: declared and executable action sets differ.
- `ROLE_LAUNDERING`: evidence is called critic evidence while its roster or
  report role says otherwise.
- `SESSION_COLLAPSE`: independent workers share one logical seat or report.
- `PROVENANCE_FABRICATION`: runtime or protocol identity comes from a constant
  instead of captured evidence.
- `ERROR_NORMALIZATION_GAP`: expected contention is a stable Result in one
  public domain but escapes as a traceback in another.
- `EVIDENCE_ADVERSARY`: can this currently-green proof stay green after its
  witness is made false while the claimed end-state is left superficially
  valid? Adversarially mutate only the proof linkage of a recent green claim
  -- a stale fingerprint, a wrong seat, a duplicate identity, a missing gate
  receipt, a wrong source, a malformed-but-parseable ledger -- and a gate that
  stays green is a normal finding, never a PASS. A green proof is useful only
  if falsifying its witness makes it red.

The first SAICRITIC run (T-603) found the register-without-executor defect:
`saipen improve` was registered in the command surface but the CLI had no
executor (IMP-001/IMP-003 -> T-606), and the SubSaipen write boundary was
admission-only, not continuously checked (IMP-002 -> T-607).
