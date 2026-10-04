ZAICODE

WAVE 4 — COMPLETION VISIBILITY + WORKERS EMPTY-STATE

Use the existing tickets:
- T-197 / SRC-131
- T-200 / SRC-134

Do not create duplicates.

A. UNSEEN COMPLETION — T-197

Introduce a distinct state for work that has just finished but the operator has
not viewed yet.

The current problem:
recently completed work can look too similar to intentionally idle projects that
have not done anything for a long time.

Define a durable completion-attention marker.

At project and session level:

When work transitions from active -> terminal success/failure:
- mark completion as unseen when the operator is not currently viewing the
  relevant project/session.

When the operator visits the relevant project/session:
- clear that unseen marker according to one explicit rule.

Do not clear merely because a background projection rendered the row.

Visual treatment must be distinct from:
- Working;
- Tests running;
- Waiting;
- Idle;
- Error;
- selected project.

Use theme tokens and Highlights & Motion architecture.

Persist enough state across ZAICODE restart so a completion that happened while
the operator was away is not silently lost.

Do not keep an eternal unread badge after the result has actually been viewed.

B. AUTO-COLLAPSE EMPTY WORKERS PANEL — T-200

When the only visible Worker is collapsed/removed such that the parent WORKERS
panel contains no meaningful visible worker content, collapse the parent panel
too.

Do not leave a large dead empty region.

However, do not fight explicit operator intent:

- if multiple workers remain, keep the panel;
- if the operator deliberately pins/locks an empty panel and such a concept
  exists, preserve it;
- closing/collapsing the visual panel must not stop running workers;
- reappearance of a relevant worker should follow the existing panel-open policy
  rather than spawning duplicate windows.

Cross-check with Wave 1's corrected parent/child collapse semantics.

C. STATUS COHERENCE

Re-run the T-194 Working/Test activity oracles after adding unseen completion.

The final state model must distinguish:

WORKING
TESTING
WAITING
UNSEEN COMPLETED
IDLE
ERROR
SELECTED

No single row should show logically contradictory states unless the combination
is explicitly meaningful, e.g. selected + unseen project may clear unseen on
selection.

WAVE ACCEPTANCE

- newly completed background work becomes visually distinct;
- visiting it clears the unseen state;
- restart preserves legitimate unseen completion;
- old idle projects do not acquire false unseen marks;
- the WORKERS panel does not leave a dead empty cavity;
- active workers survive visual collapse;
- T-194 test/working indicators remain truthful.
