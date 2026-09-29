ZAICODE

# AUDAPACK Quick3 behavioral reference used for Wave 5

This is a compact implementation reference derived from the operator's current AUDAPACK archive `_AUDAPACK_28.09.26-T11-17-03.zip`. It exists so the ZAICODE implementation agent does not reduce "like AUDAPACK" to visual resemblance.

## What Quick3 actually means

AUDAPACK models Quick3 as a declarative campaign profile, not three hard-coded button clicks:
- profile ID `quick3`, version `1.0.0`;
- Core -> Second -> Performance dependency order;
- each wave has its own ID, ordinal, prompt focus, required ticket fields, terminal status line, done marker, no-findings marker and canonical output filename;
- Performance is the finalizer;
- final artifact kind is `quick3_combined`;
- final basename is `__00_AUDIT_ALL_3`.

## Durable campaign facts

AUDAPACK's current design includes:
- unique run identity;
- clean-slate run boundary;
- persistent wave/run state;
- predecessor SHA-256 chaining;
- project identity and profile/manifest identity in payloads;
- same-wave recovery/retry rather than skipping forward;
- final synthesis only after all required wave artifacts are durable and verified;
- progress badges are campaign state, not inference from how many messages happen to be visible.

Tests in the current AUDAPACK archive explicitly defend:
- start exactly once;
- restart recovery around dispatch;
- no duplicate Core after post-start recovery;
- current-run/project/campaign matching;
- completed wave files and final handoff must exist and match hashes before READY;
- old campaign progress cannot leak into a new campaign;
- missing final handoff is SAVING/not READY.

## Canonical profile fields

Core:
- `STATUS: AUDIT_CORE: COMPLETE`
- `CORE_DONE_WHEN:`
- ticket `CORE-*`
- fields: EVIDENCE / DEFECT / REPAIR / VERIFY

Second:
- `STATUS: SECOND_WAVE: COMPLETE`
- `SECOND_WAVE_DONE_WHEN:`
- ticket `W2-*`
- fields: EVIDENCE / DEFECT / REPAIR / VERIFY

Performance:
- `STATUS: PERFORMANCE: COMPLETE`
- `PERFORMANCE_DONE_WHEN:`
- ticket `PERF-*`
- fields: EVIDENCE / ISSUE / OPTIMIZE / GUARDRAIL / VERIFY
- classification: PROVEN BOTTLENECK / STRONGLY EVIDENCED WASTE / LOW-RISK SIMPLIFICATION

## Key parity principle

Port the campaign semantics and verification rules. Do not copy AUDAPACK's browser-click transport or bridge implementation if ZAICODE already has a safer native queue/service boundary. ZAICODE should reuse its own queue and services while matching the durable campaign contract.
