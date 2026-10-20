# Home navigation and compact quota rows (T-265 / SRC-169)

Creating a task through the root action, including the desktop Ctrl+N command,
must reveal the chat view after validating the target workspace. The App remains
the only owner of its main view; the existing ZAICODE action registry exposes
the shell's chat navigation callback. Invalid and read-only targets retain their
current view. Background runtime and scheduler commands do not call this action.

Recent elapsed labels reserve at least 64px and never break before `ago`; longer
durations take their natural width while the neighboring activity text truncates.
Compact quota rows paint their fresh-quota outline inside their own rectangle.
The supplied overlapping-outline screenshot concerns these adjacent quota rows,
rather than the title-bar meter cells. Other notification outlines keep their
existing appearance and settings.

The composer Board uses the existing project-scoped second sidebar owner. Native
acceptance must exercise Ctrl+N from SAIHOME and repeated Board toggles, at 640px
and desktop widths. SSR regressions cover long Recent labels and two simultaneous
fresh quota rows, with unchanged tests run against the pre-fix source as a control.
