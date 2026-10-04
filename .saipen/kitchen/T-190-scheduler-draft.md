# Scheduler continuation (SRC-125 / T-190) — discovery draft

Current defects: a worker can wait for hours at Claude's hook-trust menu;
the watchdog recognizes only folder trust and refuses after two replies or
15 minutes. Limit handling uses generic text, defaults to keeping the blocked
worker, and can only create a new one-shot reset schedule. Pool schedules do
not reliably carry the chosen pool into an existing MAIN session.

The existing scheduler owns persisted automation. Worker records retain run
identity; terminal observations feed that owner. Vendor quota snapshots remain
the desktop engines owner's facts. Conversation commands remain v4 commands.
No parallel agent loop or alternative project state is introduced.

Required behavior:

- Known folder and hook trust prompts receive the approved trust answer at
  any point in a live worker's run, including the illustrated three-choice
  menu. Remove startup-age and total-answer caps. Select the trust option
  from the actual displayed menu, prevent duplicate redraw replies, and
  recheck the live worker/generation before delayed terminal input.
- A schedule offers an ordered continuation chain of configured subscription
  accounts and SAIFREN, a delay after a limit, and return on subscription
  recovery. Preserve the same project and objective through every handoff.
- Recognize vendor-specific quota signals separately from authentication,
  transport faults and prose mentioning limits. Use the exact account and
  pool/window when known. Refresh its real quota before deciding availability.
- Persist limit observation, the current runner and pending continuation before
  launching. A delayed retry must survive restart and must not launch duplicate
  workers or MAIN sessions. Stop only the schedule's own replaced run.
- Try available selected accounts in order; use the chosen SAIFREN pool when
  subscriptions are exhausted. A recorded limit remains blocked until a fresh
  vendor read proves recovery. Unknown/stale readings do not prove recovery.
- Return from fallback after the subscription refills and the configured delay;
  continue cycling on later limits until the project's work completes. Explicit
  project disable, Autopilot pause, schedule pause and cancel remain effective.
- An absent pool, unavailable runner or failed launch produces a truthful
  retry/result rather than successful progress or a second unowned schedule.

Validation must include the illustrated hooks menu after five hours; split
terminal output; duplicate redraws; vendor windows and false positives;
delay, ordered fallback, fresh reset recovery, restart idempotency, stopping
the owned run, exact pool routing, and actual renderer/terminal interaction.
Use repository typecheck/lint/architecture/tests and staged boot for publication.

Primary references consulted:

- https://code.claude.com/docs/en/permission-modes — bypass launch flags and
  the separate first-use confirmation setting.
- https://code.claude.com/docs/en/hooks-guide — hooks and permission modes are
  separate; use the vendor's displayed trust choice rather than disabling hooks.

This draft is discovery, not implementation or acceptance evidence.
