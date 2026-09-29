# T-131 -- Ctrl+A in the chat selects only the chat (SRC-094)

Product commit: see the LOG line of the VERIFY pass (zcode branch `zaicode`).

Operator: "I want Ctrl+A in the chat to select only the chat's content for copying, not half the program."

Cause: with no text field focused, the window's select-all takes the whole page (sidebar, title bar, composer). Measured in the built app: plain Ctrl+A on a
blank spot selected 2044 characters of interface.

Now: a capture-phase key listener (installed at app start) takes plain Ctrl+A / Cmd+A when the keyboard is in the chat -- focus inside it, or the selection begins
in it, or the last pointer press was on it -- and it is not in a text field, and selects the contents of the transcript container (`data-v4-timeline-scroll`) only.
In the composer or any text field or editable block, select-all keeps its meaning (that text). Anywhere else it is left to the browser (Shift/Alt combinations too).
The transcript is virtualised (only drawn rows exist in the page), so what is selected and copied is the rows that are drawn, not the whole history.

Checks: verify:pre-push exit 0 (ui 766, services 85, desktop 182 pass 2 skipped, cli 30, oxlint 0 errors, architecture 0 new). New suite zaicodeSrc94ChatSelectAll (5).
Red controls: 6 mutations each turn a named test red (the text-field rule, the last-click rule, the selection rule, the Shift/Alt rule, selecting the page instead of the
chat, the listener not installed). Real Electron (built out/): a stand-in transcript with the real container marker is added next to the real interface: Ctrl+A after a click
in it selects exactly its text (not the second chat, not SAIHOME/ZAICODE/Projects); a click on its blank space counts; in the real composer Ctrl+A takes the composer's text;
outside the chat it still takes the page.
Not done: the real transcript was not opened (a session needs a configured provider); the container marker was checked in the timeline source and by test.
