# Phase: PLAN

Convert intent into executable tickets. Analysis stays within eight lines:
callers, edges, migrations, UI states, safe defaults.

## With text

For `saipen plan <text>` / `dd <text>`, the text is the work. Every named item
becomes a recognizable, independently verifiable ticket at the **FRONT of `## TODO`**; board order is priority. Reword for cold execution without
substituting autonomous proposals. Put newly discovered extras below the
user's items.

## Bare proposal mode

For bare `saipen plan`, inspect code, KNOWLEDGE, and Git history; propose
workflow completion, evolutionary gaps, and architectural strengthening.
Write structured proposal tickets, transition to DONE, and halt for choice.
The halt category is `user brake`; the reason may be human wording, for example
`WAIT: user brake -- proposal plan is on the board; pick one or continue`.
**There is no parked `PHASE`**: `PHASE SCOUT T-###` is executable and must not
be written while the phase is ordered to halt. The next user command
supersedes the brake; `continue` selects the top workable ticket.

## Ticket and exit rules

One goal per ticket; add `needs:` dependencies and `| verify:` when known.
Board order is execution order. More than ten tickets become waves; detail the
current wave only.

Size gate: an obvious change of roughly two files may skip detailed planning,
not SCOUT/BUILD/VERIFY/REVIEW/SHIP/DONE correctness gates. LOG the size
decision and route to SCOUT or BUILD.

After non-proposal PLAN, enter SCOUT and do not pause under goal intent.
Increment `goal_waves` and write `DEC: goal_waves N->M` only for a genuinely
new wave. A PLAN entered directly from ADD's `RETURN PLAN` does not increment:
ADD already counted that HUNT->ADD cycle. MAINTENANCE §2.4 owns checkpoint,
caps, stop shape, and `cc` reauthorization.
