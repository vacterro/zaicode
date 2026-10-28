# Transcript view

The conversation has a visible Transcript control with Compact, Full and
Only text buttons. It applies immediately to loaded and newly streamed rows.
The existing ZAICODE UI preference store owns the persisted mode; malformed
or older preferences fall back to Compact. No execution state or protocol
changes, history fetching, provider calls or new timers.

Compact preserves existing reasoning/Todo settings and manual disclosure.
Full shows reasoning and Todo rows and expands available tool, reasoning and
work-history details. The presentation override does not overwrite manual
compact disclosure choices. Only text displays user and assistant narrative
in original order, including intermediate messages previously inside history;
it hides tools, thoughts, work counters and file summaries. Failed tool names
remain a plain alert. Questions, permission requests, retry/error controls and
the composer remain reachable through their existing bottom dock.

Rows remain owned by the original projection; visibility is a pure rendering
filter and never mutates row identities, persisted history or copy text. The
existing virtualizer discards heights from the previous mode and measures the
changed heights without changing the stored conversation scroll position. The control uses a fixed layout
lane rather than covering text, supports keyboard activation and exposes the
selected mode. Other product modes retain existing rendering.

Verify mode normalization and original-order projection, tool/reasoning Full
disclosure and Compact defaults, plus actual desktop button selection and
reload persistence. Required repository gates and a boot-checked Windows
bundle precede delivery. The already verified T-257 package remains available.
