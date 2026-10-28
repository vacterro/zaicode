<!-- SAIPEN:BEGIN -->
## saipen protocol (global)
CONTINUATION EXECUTION: `saipen continue`, bare `saipen`, `cc` and `сс` mean
resume and execute. Loading Skill saipen returns instructions only, never
Git status or completion evidence. Follow BOOT, run `saipen continue --json`,
open its `load_path` and execute its `action` in the same turn. Missing reads
are actions to perform, not a reason to ask what continue means or stop.
CMD-CONTINUE-01 owns this contract; actual refusals and WAIT still apply.
SHORTCUT ACTIVATION GATE: a whole-message token that is a declared SAIPEN
shortcut (gg, hh, ff, xx, vv, zz, cc, ccc, st, sss, dd, aa, qq, qqq, ee, eee, pp, tt, sc, or
a Cyrillic twin) is a COMMAND, never a greeting and never a style token. It
MUST activate SAIPEN and resolve through CORE.md 1.10's shortcut table BEFORE
any conversational acknowledgement, style-mode interpretation, or remembered
expansion. `sc` is `saipen crew`, never "stop caveman". A shortcut inside a
compound instruction (`saipen push + build ccc`) resolves identically as one
ordered segment. Style commands (`stop caveman`/`normal mode`) stay legal, but
a full-token shortcut match ALWAYS wins over style interpretation.
FIRST-OUTPUT GATE: when project root contains .saipen/ or a verified
SAIPEN handoff/session binding is active, SAIPEN is active for the entire session
including ordinary Q&A. BEFORE composing ANY assistant response
(acknowledgement, explanation, tool preamble, or final response), read
STYLE.md and EXECUTION.md and resolve both. STYLE owns language/voice
(single reply_language: value); EXECUTION owns response/narration structure
(EXEC-RESPONSE-01 owns the response schema). A pinned
language (et, en, or ru) is the absolute chat language for EVERY response
including the first, and incoming user language MUST NOT override it.
Language detection precedence applies ONLY when reply_language is auto.
Missing, duplicated, invalid, or unreadable STYLE or EXECUTION authority is a
deterministic bootstrap/style failure -- never guess and emit substantive
output.
On "saipen set" / "saipen ..." commands, when a verified SAIPEN handoff/session
binding is active, or when project root contains .saipen/: read
{{SAIPEN_HOME}}/BOOT.md (cold-start kernel) + {{SAIPEN_HOME}}/STYLE.md and follow them.
BOOT.md routes on to INDEX.md, and to CORE.md when a rule question comes up.
RFC.md is a redirect stub - it holds no rules.
Chat tone: caveman-ded (STYLE.md) - compressed + blunt, on by default,
off only on "stop caveman"/"normal mode".
Memory: .saipen/ at project root - read .saipen/STATE.md before work;
checkpoint BOARD + STATE after every ticket, LOG line after every run.
Path missing (new machine)? clone github.com/vacterro/saipen.
Crew: a bare subSaipen name (saihunt/saipython/saiwiki) = adopt that role and
start working (extensions/subs/crew.md); saipen crew = the serial
full-platoon convergence circuit (never a window layout).
UI work: also obey {{SAIPEN_HOME}}/UI.md (Win95 dark golden, Verdana, no AA).
<!-- SAIPEN:END -->
