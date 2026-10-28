# SAIASUI! — New task aim-training Easter egg

This feature prevents an idle-screen game from intercepting productive input or
changing workspace state. It implements SRC-066 / T-103 entirely in the UI module.

## Ownership and entry

`SessionPane` mounts the host only for a focused, editable ZAICODE draft.
Five primary, unmodified clicks within six seconds on empty draft background,
at least 40 px apart, offer one circle. Composer, greeting, controls, selections,
dialogs, non-draft panes and other games never count. ProTrail already defaults
on; its configuration is independent and is never changed by this game.
An offer does not block work and expires after eight seconds. Hitting it starts
a run. Esc dismisses both offer and run immediately; a fresh gesture is required.

```text
blank clicks → draft host → offer → circle hit → local run engine
                                            ├→ portal + synthesized hit sound
                                            └→ score record on exit
Esc / blur / hidden / route change / unmount → dispose → restore focus + input
```

The engine owns elapsed active time, seeded RNG, circles, score, combo, health,
power-ups and interval grades. React projects it; no services, agents, task
queues, drafts or layout preferences are written. Only game preferences and
best scores persist in a dedicated Zustand store. Settings are snapshottable;
scores are not release defaults. Storage/audio failure leaves the game usable.
No remote protocol or replay changes. Every run gets a fresh UUID seed.

## Rules

- Start at roughly one large circle per 2.8 seconds. Targets span the current
  client area with margins for HUD, approach rings and resizing.
- Successful hits gradually cover the underlying interface over 30 hits.
  The underlying React tree remains mounted and inert during the run.
- Linear pacing increases with hits and active time; step pacing increases at
  two-minute boundaries. Both cap at a sustainable interval (at least 650 ms),
  with seed-specific variation limited to 8%. No unbounded difficulty spiral.
- Hits award reaction grades 300 / 100 / 50, combo, maximum combo and score.
  Each two-minute segment gets its own accuracy grade SS/S/A/B/C/D, retained
  in the HUD until the next grade; the game continues without a modal pause.
- HP starts at 100 on hit 50. Drain grows gently, capped at 4 HP/s; ordinary
  hits heal 7 HP. Missed mandatory circles break combo and cost 6 HP. Wrong
  clicks break combo and cost 2 HP. Zero HP ends the run with score/retry/exit.
- From hit 12, occasional circles grant 3 s god mode, 3 s slow time, full HP,
  or move gently. Tiny +HP circles are optional bonuses: expiration has no
  penalty. Events are seeded, bounded and spaced; motion respects reduced motion.
- No music. Short original synthesized hit sounds respect master mute/volume
  and a separate game sound switch. All voices close on exit.
- Settings → ZAICODE exposes enable, sound and linear/step pacing. Disabling
  ends an active run. No start button outside New task. Bests are per pacing mode.

The requested circles, movement and gradual disappearance explicitly override
SAIPEN's static-UI defaults inside the game; surrounding settings reuse the
existing ZAICODE theme, controls and typography.

## Acceptance and verification

Automated rules tests cover reproducibility/seed diversity, caps and sustained
play, HP threshold/drain/healing, misses and optional bonuses, power durations,
segment grades, movement bounds, and hit idempotency. Interaction scenarios:
background gesture → offer → play → Esc; input/control clicks never trigger;
switching draft/route, blur, hidden tab and unmount cancel; previous focus,
inert state and draft text survive; resize keeps targets reachable; unavailable
storage/audio does not break work. Run `pnpm typecheck`, `pnpm lint`,
`pnpm architecture:check --changed`, and the focused UI tests. Browser evidence
must distinguish the isolated real-component harness from full desktop testing.
