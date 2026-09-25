# ZAICODE fault matrix -- 2026-09-25T17-22-23-730Z

| Scenario | Verdict | ms | Detail |
|---|---|---|---|
| router-crash-restart | PASS | 3946 | 9router dies on its own: the supervisor brings it back, a clean stop stays stopped |
| router-outage | PASS | 30631 | Router down 30 s and back: calls fail fast during the outage, succeed after |
| quota-zero-reset | PASS | 1 | Quota hits zero, then the window resets: blocked -> refill time -> available |
| saimail-malformed-tail | PASS | 10 | SAIMAIL index with a torn last line and junk: the reader keeps every whole row |
| crash-plans | PASS | 0 | App killed: cut-off sessions resume oldest first; leftover workers start again |
| twelve-finish-at-once | PASS | 185 | 12 subscription turns finish in the same instant: 12 results, each once, none crossed |
| project-setup | PASS | 1735 | Fresh SAIPEN project for the protocol faults |
| worker-kill-mid-write | PASS | 6803 | Worker killed mid-write: the next generation resumes the same Work |
| foreign-ownership | PASS | 253 | Another seat tries to move a claimed Work: SAIPEN refuses, ZAICODE still shows the owner's state |
| stale-snapshot | PASS | 6830 | SAIPEN launcher unreachable, then back: ZAICODE falls back to the files and recovers without a file change |
| project-relocate | PASS | 1996 | Project renamed / moved while known: the new path reads the same Work; the old path reads nothing |
| project-switch | PASS | 3732 | Switching projects mid-run: each project keeps its own answer |

## Manual scenarios

- **Kill the ZAICODE renderer** (the renderer is a Chromium process inside the running app). Steps: Task Manager -> Details -> end the ZAICODE process with --type=renderer while a session works. Expected: The window reloads; sessions cut off show INTERRUPTED, never DONE; a window reload never auto-continues (crash resume skips reloads).
- **Kill the whole ZAICODE** (needs the packaged app and its root launcher (agents inside ZAICODE are refused this on purpose)). Steps: Task Manager -> end the ZAICODE process tree under the launcher while two sessions and one worker run. Expected: The launcher restarts it; cut-off sessions show INTERRUPTED; with After a crash on they continue ~30 s after start, oldest first; the worker starts again with the same engine, project and prompt.
- **Windows sleep / resume** (needs the OS power state). Steps: Put Windows to sleep for 10 min with a SCHEDULER entry due during the sleep, then wake it. Expected: Clocks and reset timers show the right time at once; quota is re-read within one sweep; the due entry fires once, or is MISSED when older than the catch-up window.
- **Network disappears during a turn** (needs the machine's network adapter). Steps: Disable the network adapter for 60 s while a SAIFREN session answers, then enable it. Expected: The turn fails with the provider's error or retries; the session is not DONE; SAIHOME Routing shows degraded, then healthy.
- **Worker terminal detached / reattached** (window placement is a GUI action). Steps: Start a worker, move it to its own window, minimize it, dock it back. Expected: Same worker, same PTY (the CLI keeps its screen and PID); nothing restarts.
- **Kill a worker during SAIMAIL delivery** (needs a real seat mid-send; SAIMAIL's own soak suite owns delivery atomicity). Steps: In a worker, start `saimail-local send` of a large telegram and kill the worker at once. Expected: The telegram arrives once or not at all (never torn); the index tail is either complete or skipped by the reader.
