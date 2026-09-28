ZAICODE

# Master roadmap — bug and feature waves

This archive is a complete roadmap for the operator's 2026-09-28 request. Execute the waves in order. A later wave may inspect earlier work, but it must not silently absorb a failed earlier acceptance gate.

## Wave order

1. **Runtime stability and exactly-once behavior**
   - ProTrail must work immediately after ZAICODE startup.
   - `saipen crew` must not be double-submitted by ZAICODE.
   - elapsed work timers must freeze at terminal completion.
   - dismissible notifications must actually dismiss.
   - commit/push failure must expose and fix the real cause.
   - reproduce and fix the reported overlapping UI.

2. **Session text and composer integrity**
   - make Session text Save/Export/Import real and discoverable.
   - style user messages as well as agent messages.
   - add per-session auto-continue override.
   - preserve, expand and edit large pasted text attachments without replacing the payload with a placeholder.

3. **Audio engine v2 and action feedback**
   - global non-destructive loudness normalization for currently configured user sounds.
   - Soft/Standard/Aggressive normalization modes and user-controlled negative attenuation cap from -24 dB through -48 dB.
   - per-event random sound pools with honest live probability distribution.
   - individual sound/effect mapping for structured agent actions such as read and reasoning.
   - RPG Changes `spawned` feedback for newly created files.

4. **Project organization and model-specific visual identity**
   - virtual project folders with obvious drag/drop organization.
   - project pin/unpin to the top without destroying folder membership.
   - Default/Separate highlight configuration and per-model worker icon overrides, including SAIFREN/SAIOPP.

5. **A3 / AUDAPACK Quick3 parity**
   - replace any plan-shaped or prompt-only approximation with a durable three-wave audit campaign matching AUDAPACK's actual Core -> Second -> Performance contract.
   - expose a composer command that runs and saves the campaign.
   - generate canonical per-wave artifacts and the combined `__00_AUDIT_ALL_3.md` artifact.
   - make the final artifact directly consumable by the next SAIPEN bug-fix step without mixing implementation into the read-only audit campaign.

6. **SAITRANSLATE locale completion and final polish**
   - implement the exact locale set declared by current SAITRANSLATE protocol: 32 language locales plus the DED variant, rather than guessing a list from memory.
   - retain source-key parity in both real UI and CLI surfaces.
   - close any remaining localization-driven clipping/overlap regressions.

## Dependencies

- Wave 1 has no dependency and should run first because it contains execution correctness regressions.
- Wave 2 depends on Wave 1 only for a stable renderer/session lifecycle.
- Wave 3 can start after Wave 1 and may be parallelized with Wave 2 only if separate agents cannot touch the same settings/audio/session files.
- Wave 4 follows Wave 1 and should not share a commit with Wave 3.
- Wave 5 should run after Wave 1 because its correctness depends on exactly-once dispatch and truthful elapsed/progress state.
- Wave 6 is deliberately last. Current SAITRANSLATE evidence measured a very large translation remainder, so it must use the translation producer workflow rather than pretending that a few locale files equal completion.

## Completion definition

The overall request is complete only when every wave has a durable SAIPEN receipt, all deterministic gates pass, platform-only NOT RUN items are explicitly listed, and no user item is silently reclassified as already done merely because an older ticket claimed it.
