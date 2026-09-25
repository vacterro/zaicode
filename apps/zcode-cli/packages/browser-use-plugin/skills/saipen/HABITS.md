# Statistical Habits of Modern LLMs

SAIPEN is built on the premise that an agent's default behaviour is driven by statistical habits that optimize for conversational compliance rather than engineering correctness. Every rule in SAIPEN that survives is one that pushes back on a specific default behaviour.

This document enumerates these habits and maps them to the mechanisms that counter them.

## The Habits

1. **Drifting to polite consultant prose**
   Producing filler, apologies, and hedging instead of terse, actionable output.
   *Counter-mechanism*: saipen/STYLE.md and the style_contract field in STATE.md, which pins the active voice (e.g., ded) and forbids consultant prose.

2. **Agreeing with whoever spoke last**
   Abandoning canonical state or rules if the user's prompt implies otherwise.
   *Counter-mechanism*: CORE.md § 1.10 (memory ban) and tools/validate.py cross-doc drift checks which ensure authoritative documents overrule memory or recent chat.

3. **Hedging instead of deciding**
   Proposing multiple options instead of picking one and executing it, or guessing instead of stopping.
   *Counter-mechanism*: CORE.md § 1.11 (Insufficient information is a stop, not a guess) and CORE.md § 1.6 Phase Transitions that force a single deterministic next action.

4. **Claiming a read or a verification that never happened**
   Hallucinating tool output or test success.
   *Counter-mechanism*: CORE.md § 1.11 (A session MUST leave a trace) and tools/audit_checks.py, which require an agent to actually run the checks and parse the logged proof.

5. **Inventing plausible detail**
   Making up paths, versions, line numbers, or shortcut keys that look correct statistically but do not exist.
   *Counter-mechanism*: CORE.md § 1.10 (strict shortcut table enforcement) and tools/validate.py strictly enforcing CONFORMANCE.md row IDs and explicit path validations.

6. **Copying an example instead of applying the rule**
   Treating a documented example as a template and ignoring the normative rule text.
   *Counter-mechanism*: tools/validate.py checks that ensure examples in the docs strictly conform to the normative rules (implemented via T-435).

7. **Declaring success at the first green**
   Stopping verification after one passing test while ignoring edge cases or other platforms.
   *Counter-mechanism*: the SHIP phase gates which enforce that all validation passes before closing (audit_parity.py only verifies shell portability).

8. **Summarising work instead of doing it**
   Describing what should be done instead of invoking the tools to modify the files.
   *Counter-mechanism*: two, both older than the ticket that was filed to invent one. This habit has two shapes and each has its own. **Produced nothing and talked about it**: § 1.11's session-trace rule -- a session that did anything ends having produced a LOG line, a BOARD change, a STATE change or a change to the project's own files, and one that produced none of those MUST say exactly that "rather than summarising activity in chat". **Produced a trace that is itself a plan**: § 1.2's LOG rule -- an entry records what already happened, never what is about to, and its first clause MUST NOT be written as an intention. That second one is mechanically enforced in tools/validate.py, which rejects `will`, `going to`, `about to`, `plans to` and their relatives in that position. That gate has its own standing red control in tools/audit_checks.py, which is what keeps this citation honest -- a counter-mechanism named in prose is only as real as the control behind the check it names. The gap this line used to claim did not exist, and claiming one is its own defect: it sends the next agent to build a duplicate of a rule that is already enforced.

9. **Truncating context and assuming the end**
   Reading only the first N lines of a file, queue, or command output, and acting as if the unread remainder is empty.
   *Counter-mechanism*: CORE.md § 1.11 (Read to the end, never truncate), which forbids declaring a list or queue empty without reading to End-Of-File.
