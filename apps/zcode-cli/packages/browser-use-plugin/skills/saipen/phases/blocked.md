# Phase: BLOCKED

Session-level BLOCKED means no ticket anywhere is workable; a single blocked
ticket does not qualify.

1. LOG `RUN: BLOCKED -> <specific blocker>` in the Event Graph skeleton.
2. Read STATE `blocker:` and recent LOG. Empty blocker is corruption; record
   the real reason.
3. Recheck every TODO. If one is workable, route to SCOUT/BUILD instead.
4. Otherwise write `WAIT: blocked -- <specific question, credential, or manual action>`.
   Do not spin, guess, or start unrelated maintenance.
5. After the user resolves it, update the affected ticket and route to PLAN,
   SCOUT, or DONE when the board is empty.

CORE owns blocker/WAIT shape and checkpoint mechanics.
