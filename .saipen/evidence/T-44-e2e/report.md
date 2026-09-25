# ZAICODE system E2E -- 2026-09-25T03-30-27-827Z

| Step | Verdict | ms | Detail |
|---|---|---|---|
| cold-start | PASS | 1279 | Fresh Git project gets SAIPEN memory; one Work ticket |
| project-detected | PASS | 1588 | ZAICODE projects SAIPEN's own status; verdict is pending on T-1 |
| engines | PASS | 0 | Engine availability from the persisted cache ZAICODE loads at start |
| start-goal | PASS | 1616 | START's `/goal cc all` verdict keeps the goal running on T-1 |
| work-claimed | PASS | 3632 | Worker generation 1 claims the Work; STATE/BOARD/LOG move; ZAICODE shows working |
| saimail-telegram | PASS | 2636 | A helper seat's telegram reaches the main seat through ZAICODE's SAIMAIL reader |
| worker-kill-recovery | PASS | 3749 | Generation 1 is killed; the Work survives; generation 2 resumes the same ticket |
| router-outage | PASS | 27 | Router down: ZAICODE's Router call fails fast with a clear message; back up: it answers |
| restart | PASS | 2071 | A new process (ZAICODE restarted) reads the same state and verdict |
| verify-done | PASS | 6305 | The Work goes VERIFY -> DONE; ZAICODE shows done; the /goal verdict passes |

## GUI steps for the operator (T-9)

1. Open the project in ZAICODE: the sidebar strip tint and the composer chip show the read-model verdict (pending T-1).
2. Press START on the project row: a primary session opens and sends `/goal cc all` with the selected engine.
3. While the agent works: the composer NEXT/THEN lines and the SAIPEN pane follow each checkpoint within one poll (3 s).
4. SAIMAIL header button rings for the telegram; the desk lists it under the current Work.
5. Close ZAICODE mid-run and start it again: the same project, verdict and SAIPEN state come back; detached workers are listed.
