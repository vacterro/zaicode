ZAICODE

WAVE 1 — P0 RUNTIME CONTINUITY + WORKERS / SESSION REGRESSIONS

This wave addresses three newly observed defects plus the existing T-202 Worker
control bug.

Do not mix unrelated Settings polish into this wave.

PRIORITY 1 — PRESETS MUST NOT RESTART ZAICODE

SEVERITY: P0

User contract:
Applying a Settings preset must not restart the ZAICODE application, renderer,
or runtime in a way that interrupts active projects, sessions or workers.

Reproduce the current behavior first.

Audit every preset family, including at least:
- appearance;
- sound;
- highlights/motion;
- SAIASUI/game settings;
- any section using shared preset infrastructure.

Determine why preset application currently causes an app/runtime restart if that
is the actual observed path.

Required behavior:

- applying a preset updates supported settings live;
- active workers continue;
- active sessions continue;
- project selection remains;
- unsent composer text remains;
- timers/status remain coherent;
- no process-wide restart merely to apply UI/theme/audio configuration.

If one subsystem genuinely requires reinitialization:
- restart only that bounded subsystem;
- preserve active execution state.

Do NOT solve this by queueing a full ZAICODE restart after work completes.
The default behavior must be live application.

Regression:
1. start a real/safe worker;
2. retain its run/session identity;
3. apply multiple presets;
4. prove the application PID/runtime session remains alive;
5. prove the worker continues and its final result remains attached correctly.

PRIORITY 2 — WORKERS COLLAPSE/EXPAND MUST HAVE A REAL EFFECT

New screenshot/report:
the WORKERS header can show expanded/collapsed states while the visible layout
appears unchanged.

Trace:
- panel-expanded state;
- child worker visibility;
- panel height/layout;
- persisted layout state;
- docked/floating modes.

Required invariant:

Expanded:
- configured visible worker rows/terminals are visible.

Collapsed:
- worker body/content is actually removed/collapsed to the compact header;
- no dead blank region remains;
- active workers are not stopped;
- expanding restores the same workers.

Do not conflate:
- collapsing the whole WORKERS panel;
- collapsing one worker terminal;
- closing/killing a worker.

All three need distinct semantics.

Persist the intended panel state if the existing layout system persists it.

PRIORITY 3 — `WORKING FOR` MUST NEVER RENDER EMPTY

Current screenshot shows:

Working for

with no duration.

T-191 already added valid running/completed duration presentation.
This is a new missing/invalid timestamp edge case.

Find the authoritative start source.

Required presentation:

When authoritative start time is known:
`Working for 13m`
or equivalent localized duration.

When the run is not actually active:
do not render Working.

When activity is active but duration cannot yet be proven:
show a truthful neutral state such as `Working` until a valid timestamp exists.

NEVER:
`Working for` with an empty suffix.

Do not invent `0s` merely to fill the UI when the start identity is unknown.

Test:
- normal active run;
- very fresh run;
- restored run;
- detached worker;
- missing start timestamp;
- terminal run;
- restarted ZAICODE;
- T-191 multi-hour cases remain green.

PRIORITY 4 — T-202 WORKERS TOOLBAR BUTTONS CAN BECOME UNRESPONSIVE

Use the existing T-202 / SRC-136 ticket.

The screenshot shows Worker-toolbar controls that visually exist but may ignore
clicks.

Reproduce in the packaged Electron app.

Audit:
- Electron drag regions;
- pointer-events overlays;
- stacking/z-index;
- disabled state;
- stale worker ownership;
- event handlers after dock/resize;
- panel collapse state;
- transparent elements intercepting input.

Do not simply widen hitboxes before finding why the existing control path stops
responding.

Every visible enabled Worker control must:
- receive pointer input;
- perform exactly its advertised action;
- or display an explicit disabled reason.

Add packaged UI regression that clicks every toolbar control relevant to the
fixture and proves state change/action dispatch.

WAVE ACCEPTANCE

- preset application cannot interrupt active work;
- WORKERS expanded/collapsed state visibly behaves differently;
- `Working for` never has an empty value;
- T-202 Worker controls are reliable after panel resize/collapse/reopen;
- focused tests + typecheck + lint + architecture + full relevant UI suite pass;
- production packaged smoke passes.
