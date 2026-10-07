# Sidebar width reset

Double-clicking the existing sidebar resize separator restores its established
264-pixel default through WorkspaceShellLayout's existing width command.
That owner clamps to available window space, updates its current width/ref
and persists the same pixel preference used by dragging and keyboard resizing.
No additional width state, resize surface or storage key is introduced.

The gesture works on either sidebar placement and after dragging to the compact
rail. Ordinary dragging and existing Home/End/arrow-key semantics continue to
use the same command. A reset survives renderer reload. Storage failure retains
the existing best-effort persistence semantics.

Verify in the actual app with pointer input: widen by dragging, double-click the
separator, assert its width and aria value return to 264 and its saved value
survives reload. Repeat from the compact rail and right placement. The frozen
oracle must discriminate the original package. Build a boot-checked Windows
test bundle, including the follow-up Transcript view request before final
delivery.
