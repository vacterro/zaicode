# Side-pane policy regression coverage

T-349 repairs a false negative in the T-224 UI suite. The pane owner currently
subscribes to `persistedSidePaneCollapsedFor` through `useZaicodeUiPrefs` and
uses that scalar for initialization and owner changes. Workspace restoration
uses its fresh-snapshot wrapper. Counting wrapper call sites cannot prove
policy precedence: the correct current behavior has only two matching tokens
(declaration and workspace call), while the old test required at least three.

Keep the tests proving one settings writer, canonical owner identity, and no
independent localStorage store. Move read-precedence acceptance to the existing
live `useAppPanels` browser harness. Preserve its five workspace/mode cases and
add session-owner transitions: one owner's closed answer, another's open
answer, and the global answer taking precedence when the owner changes.
Run identical browser scenarios against the preserved defective T-224 pane
owner and the current owner; the former must fail and the latter must pass.
The full UI suite must then pass without changing product implementation,
policy defaults, fixtures' expected outcomes, or acceptance thresholds.

Ownership remains `useAppPanels` plus the existing UI preference store. This
ticket changes tests and documentation only; it introduces no runtime state,
service edge, or delivery protocol.
