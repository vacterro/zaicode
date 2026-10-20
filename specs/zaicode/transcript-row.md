# ZAICODE transcript controls and native font acceptance

Existing T-277 / SRC-180 asks for transcript choices, earlier-history loading,
and latest-user/latest-answer navigation at the Transcript row, distributed
evenly, installed Windows fonts in the existing pickers, and contained worker
labels. Preserve the existing action paths and the status dock's reserved lane.

The 640px packaged acceptance has a 366px conversation frame. Reducing mode
button padding fixes the empty draft but a real 440-message session still paints
the older-history and navigation controls past the frame. With a populated Git
dock the available row is smaller again. Size controls against the row's content
width after its measured status-lane reservation, rather than the viewport.

The transcript row owns an inline-size CSS container. Above 620px of available
content it shows the existing four mode buttons. At 620px or below the same
mode owner renders one native select with all four full option names. Both
controls write the same existing preference; there is no second state or model.
The Transcript label remains visible. Earlier-history text can truncate while
its full accessible name and tooltip remain available. Both jump buttons remain
visible, with their existing accessible targets. All groups stay on one row,
spread evenly, and stay clear of the real dock. Clipping a whole action is not
an accepted containment repair.

Font capability follows the T-278 `IPlatformService` repair and existing native
font owner; installed faces retain `custom` plus their family name. Worker
labels and their hover actions retain the existing single record and placement
owner. No session, credential, account or persistent user state is removed.

Required evidence: identical failing/passing native containment oracle at
640/1280/1920, mounted controls and status-lane changes, real worker-label/hover
containment, actual installed-font selection and normal restart persistence,
typecheck, lint, architecture and the full repository pre-push suite. Keep native
and browser-fixture results separate. Stage into a fresh output directory and
test isolated profiles; do not overwrite or restart the operator's application.

Delivery ordering amendment (SRC-186): complete independently fixable source
tickets and their source/integration checks before assembling the final test
distribution. Accumulate this ticket's native checks for that final artifact.
Deferred native acceptance remains outstanding and cannot be reported as PASS
or used to declare release readiness. This changes delivery order, not the
containment, font, worker or persistence acceptance criteria above.
