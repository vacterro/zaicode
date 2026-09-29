ZAICODE

# Wave 5 — A3 audit system rebuilt to real AUDAPACK Quick3 semantics

## Goal

Make ZAICODE's A3 a durable audit campaign, not a prompt shortcut, implementation-plan generator, or three loosely related messages. Reuse and correct the existing `zaicodeAuditService` architecture rather than creating a fourth audit system.

## Existing ZAICODE baseline to inspect first

Prior evidence for T-66 says ZAICODE already has:
- `packages/services/src/zaicode/zaicodeAuditService.ts`;
- interface/service contract `zaicodeAudits.ts`;
- shared logic `packages/shared/src/zaicode-audits.ts`;
- campaign state under `{appConfig}/zaicode-audits/<id>/campaign.json` with atomic writes;
- ordinary ZAICODE queue jobs for waves;
- `ZaicodeAuditPanel.tsx` and `zaicodeAuditStore.ts`;
- report gates using STATUS + done marker;
- smart mode and campaign persistence.

Treat that as the one implementation to audit and evolve. Do not restore deleted desktop/localStorage duplicates.

The operator reports current behavior still looks like an implementation plan and does not behave like AUDAPACK. Current user observation outranks the old "done" ticket.

## Canonical Quick3 profile

Implement or verify a data-driven profile equivalent to AUDAPACK Quick3 v1.0.0:

### Wave 1 — Core
- id: `core`
- ordinal: 1
- slug: `AUDIT_CORE`
- title: `AUDIT CORE`
- ticket prefix: `CORE-`
- terminal line: `STATUS: AUDIT_CORE: COMPLETE`
- done marker: `CORE_DONE_WHEN:`
- scope: system map, invariants, correctness, state ownership, persistence, validation, error paths, tests.
- finding fields: `EVIDENCE`, `DEFECT`, `REPAIR`, `VERIFY`.
- no-findings marker: `NO VERIFIED CORE DEFECTS.`
- output file: `<Project>__01_AUDIT_CORE.md`

### Wave 2 — Second Wave
- id: `second`
- ordinal: 2
- slug: `AUDIT_SECOND_WAVE`
- title: `AUDIT SECOND WAVE`
- ticket prefix: `W2-`
- terminal line: `STATUS: SECOND_WAVE: COMPLETE`
- done marker: `SECOND_WAVE_DONE_WHEN:`
- depends on `core`.
- scope: lifecycle, startup/shutdown/cleanup, unusual boundaries, multiple writers, duplicate dispatch, cancellation/retry, partial writes, parser/serializer asymmetry, swallowed errors, duplicate truth.
- finding fields: `EVIDENCE`, `DEFECT`, `REPAIR`, `VERIFY`.
- no-findings marker: `NO NEW VERIFIED SECOND-WAVE DEFECTS.`
- output file: `<Project>__02_AUDIT_SECOND_WAVE.md`

### Wave 3 — Performance / Stability / Effectiveness
- id: `performance`
- ordinal: 3
- slug: `AUDIT_PERFORMANCE`
- title: `AUDIT PERFORMANCE / STABILITY / EFFECTIVENESS`
- ticket prefix: `PERF-`
- terminal line: `STATUS: PERFORMANCE: COMPLETE`
- done marker: `PERFORMANCE_DONE_WHEN:`
- depends on `core`, `second`.
- scope: repeated parsing/serialization, O(n^2) paths, reflow/scans, event/listener leaks, async races, unbounded queues/maps/buffers, startup I/O and low-risk hot-path simplification.
- finding fields: `EVIDENCE`, `ISSUE`, `OPTIMIZE`, `GUARDRAIL`, `VERIFY`.
- ticket classification: `PROVEN BOTTLENECK`, `STRONGLY EVIDENCED WASTE`, or `LOW-RISK SIMPLIFICATION`.
- no-findings marker: `NO MATERIAL PERFORMANCE/STABILITY FINDINGS.`
- output file: `<Project>__03_AUDIT_PERFORMANCE.md`

Final combined artifact:
- `<Project>__00_AUDIT_ALL_3.md`

Keep these strings and filenames centralized in profile data, not scattered through UI components.

## Audit role contract

Every wave is a **read-only auditor** pass. The prompt must explicitly tell the model:
- inspect the supplied current project/snapshot deeply;
- identify verified defects/findings;
- return a repair handoff for a separate implementation agent;
- do not modify implementation or project metadata during the audit;
- do not invent evidence when the target cannot be read;
- tests/commands may be run for evidence when safe, but their results must be reported truthfully;
- speculative cleanup is not a finding.

The expected answer is the canonical audit artifact, not an implementation plan. A model response that merely proposes how it would audit/implement must not advance the wave.

## Frozen source identity

At campaign start bind the whole campaign to one source identity.

Preferred behavior:
- capture/reuse one immutable project snapshot artifact for all three waves; or
- if the architecture audits the live tree, persist a full source identity and refuse to mix waves after source drift.

Persist at minimum:
- run/campaign ID;
- project stable ID/name;
- profile ID/version and manifest hash;
- source HEAD / dirty-state digest or snapshot hash;
- selected audit model identity;
- wave ID/index/count;
- predecessor artifact hash;
- completion timestamp;
- current artifact SHA-256.

Wave 2 must be cryptographically chained to the durable Wave 1 artifact. Wave 3 must be chained to Wave 2. A source/campaign artifact from an older run must never satisfy the current run.

## Exactly-once dispatch and recovery

Within one campaign, waves are sequential. Different projects/ordinary jobs may still use the shared queue concurrently.

For each wave:
1. Persist intent/state before dispatch.
2. Dispatch exactly once under a stable run + wave idempotency key.
3. On renderer/app restart, reconstruct the same campaign.
4. If a pre-dispatch crash happened, it may dispatch once after recovery.
5. If a post-dispatch crash happened, recover/observe the existing logical run rather than creating a second Core/Second/Performance turn.
6. Retry a failed/invalid wave as the **same wave** with an explicit attempt number; never silently advance.
7. Cancellation must stop pending campaign progression and leave completed artifacts durable.

Progress must reflect durable state, not optimistic UI:
- `0/3`: no valid durable Core artifact;
- `1/3`: Core saved and hash-verified;
- `2/3`: Second saved and hash-verified;
- `3/3`: Performance saved, combined artifact durably synthesized and hash-verified.

Do not show READY when the final file is missing or hash-mismatched; show SAVING/ERROR truthfully.

## Report validation

A wave counts only when its persisted artifact passes structural validation:
- correct terminal STATUS line;
- correct done marker;
- either at least one correctly formed ticket with required fields or that wave's exact no-findings marker;
- project/campaign identity matches;
- current run/wave identity matches;
- predecessor hash matches where required;
- artifact file exists and SHA-256 matches campaign state.

Reject plan-shaped output that lacks this report contract. Surface the reason and allow same-wave retry/correction.

Do not "fix" malformed output by silently injecting missing status/done markers into the model's report.

## Artifact synthesis

After Wave 3 validates, synthesize `<Project>__00_AUDIT_ALL_3.md` deterministically from the three durable artifacts.

The combined file must contain:
- machine-readable/human-readable campaign header;
- source identity;
- profile ID/version/manifest hash;
- run ID;
- ordered list of wave filenames and SHA-256 values;
- chronological Core -> Second -> Performance contents, byte-stable after normalization rules;
- final combined SHA-256 recorded back into campaign state.

Do not summarize away findings in the combined artifact. It is the implementation handoff source.

Keep run-scoped history so starting a new campaign cannot overwrite the evidence required to understand the previous one.

## Composer command

Add an obvious composer command, preferably `/a3`, using the existing command architecture.

Required semantics:
- active project required;
- one invocation creates/starts one Quick3 campaign for that project using the current audit-model selection policy;
- it does not send a normal chat message containing `/a3` after the command is consumed;
- duplicate Enter/click handling cannot start two campaigns;
- if an active equivalent campaign already exists, show/open its status rather than starting a duplicate unless the user explicitly chooses New run;
- visible progress links to the Audit panel and each saved artifact.

If a planned-only control remains, label it unambiguously (`Prepare A3`) so it cannot be confused with a running audit. `Audit now` and `/a3` should mean actual execution.

## "Fix with SAIPEN" next step

The final combined artifact is for implementation on the next step, not for implementation inside the audit campaign.

Add a clear action after 3/3 such as `Fix with SAIPEN` / equivalent current product language that:
- creates a normal implementation task/session through the existing SAIPEN integration;
- attaches or references the exact durable `<Project>__00_AUDIT_ALL_3.md` artifact by identity/hash;
- tells the implementation agent to verify findings against current source before changing code;
- preserves the original read-only audit artifacts unchanged;
- records source drift between audited snapshot and implementation HEAD;
- never automatically starts destructive implementation merely because an audit completed unless existing user policy explicitly enables such automation.

Do not invent a second SAIPEN parser. Reuse the current project intake/attachment mechanism.

## Tests required

At minimum cover:
- `/a3` exactly once -> one campaign, one Core job;
- button + Enter double event -> one logical campaign;
- full valid 3-wave chain -> final combined file;
- Core missing STATUS -> stays 0/3;
- Core plan-shaped output -> invalid, no advance;
- wrong project/run identity -> invalid;
- wrong predecessor hash -> invalid;
- restart before dispatch -> one dispatch;
- restart after dispatch -> no duplicate Core;
- same-wave retry -> no wave index skip;
- cancel during wave -> no next wave;
- old campaign files cannot satisfy a new run;
- source drift cannot mix live-source waves;
- missing final file -> SAVING/ERROR, never READY;
- hash mismatch -> ERROR;
- final artifact can be handed to existing SAIPEN intake without content loss.

## Wave acceptance

PASS only when a real local test campaign demonstrates:
`/a3 -> Core saved -> Second saved -> Performance saved -> <Project>__00_AUDIT_ALL_3.md saved -> Fix with SAIPEN consumes that exact file`, with no implementation-plan substitution, no duplicate sends, and truthful progress after restart.
