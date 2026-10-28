# Gemini adapter (CLI / AI Pro / Antigravity)

- Global route: `~/.gemini/GEMINI.md` carries the saipen block (injector
  writes it); Antigravity plugins get a copy of `saipen/` per install.
- Enforcement: ADVISORY (instruction-level only), with capability recorded
  truthfully. Gemini CLI exposes `BeforeTool` hooks with system-level
  blocking, so the host CAN block a tool; the registry
  (`extensions/adapters/registry.json`) therefore declares
  `blocking_capability: true` with `declared_strength: ADVISORY`, because no
  SAIPEN Gemini adapter is installed, current, guard-connected or
  health-probed.
  Capability and effective enforcement are separate facts and this host must
  never be reported as BLOCKING until the actual adapter exists. A Gemini
  adapter must return the host's supported hard-block result/exit semantics
  (host payload -> adapter translation -> `saipen guard` -> host block, with
  no protocol semantics duplicated in the hook) and prove the block with an
  integration test before the declared strength changes. That work starts
  only after OpenCode is genuinely blocking (T-1317 P1-5).
- Prefer native file-edit tools over bash for modifications.
- Long background loops: checkpoint doctrine matters double — write as you go.

Boot order: read `saipen/BOOT.md` first -- the cold-start kernel is all a
bare `saipen continue` needs. `saipen/BOOT/INDEX/CORE chain` is the constitution, reached
only when a rule question comes up. `saipen/STYLE.md` is a boot-read: apply it before any output.
Everything else: follow the BOOT/INDEX/CORE loading contract in `saipen/INDEX.md`.
