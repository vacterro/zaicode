# Kiro adapter

- Enforcement: ENFORCEMENT_GAP (capability is NOT enforcement). Kiro now
  documents blocking `PreToolUse` hooks: a deterministic command action whose
  nonzero exit blocks the tool. The host CAN therefore block, and the
  registry (`extensions/adapters/registry.json`) truthfully declares
  `blocking_capability: true` with `declared_strength: ENFORCEMENT_GAP`.
  No SAIPEN Kiro adapter exists yet, so nothing is installed, current,
  guard-connected or health-probed -- and until all four hold, effective
  enforcement must never read BLOCKING.
- Kiro adapter plan: a `PreToolUse` hook artifact under
  `extensions/adapters/kiro/`, registry install surfaces, and
  host payload -> adapter translation -> `saipen guard` -> host block with no
  protocol semantics duplicated inside the hook. Prove the block with an
  integration test in which a guard refusal denies the host-level tool
  invocation before changing the declared strength.
- None of that work starts until OpenCode is genuinely blocking
  (T-1317 P1-5).

Boot order: read `saipen/BOOT.md` first -- the cold-start kernel is all a
bare `saipen continue` needs. `saipen/BOOT/INDEX/CORE chain` is the constitution, reached
only when a rule question comes up. `saipen/STYLE.md` is a boot-read: apply it before any output.
Everything else: follow the BOOT/INDEX/CORE loading contract in `saipen/INDEX.md`.
