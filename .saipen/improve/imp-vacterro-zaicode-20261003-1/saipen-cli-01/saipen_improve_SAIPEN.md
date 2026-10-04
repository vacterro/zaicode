agent: saipen-cli-01
role: core
model_or_runtime: unknown
project: vacterro-zaicode
saipen_version: 8.0.2
protocol_fingerprint: sha256:c651d575aa5e5fae7b7649d72840cf05b7f12497e9b351ab3c3c7b48ccc41f55
source_head: ab9866d4e25ba7258ca403631b22a1df44eeff9d
source_tree_fingerprint: git-delta-v1:f5edccffb6591fd31a2b9271530ee14e4eeaa119dbe6bbb74e8fba870317b351
discovery_model: git-delta-v1
context_scope: SAIPEN audit, phase DONE
context_available: partial
report_status: complete

## RUN 1

IMP-001 [P2] [PROTOCOL_VIOLATION] [proven] [fix]
expected: first-publish confirmation rests on journaled evidence that the release gate actually fired, not on a free-text STATE field any writer can set.
actual: operations.py gated first-publish-confirm solely on str(state.next_action).startswith('WAIT: first-publish'). That string is prose. A reconcile op wrote one by hand in this very project and it stood in for a gate the engine never ran.
evidence: T-184 traced the canonical WAIT to hand-authored reconcile E-2954: git log -S 'WAIT: first-publish' -- .saipen/STATE.md returns no commits, and no settled journal carries a FIRST_PUBLISH_WAIT code, so _apply_first_publish_wait at release.py:2326, the sole producer, never fired. The same prose routed CONTINUE (entry.py:855) and cold recovery (cold_recovery.py:782) for three continuations. Fixed in T-185 by requiring a journaled LOG event with taxonomy WAIT whose text starts 'first-publish --', the exact shape _plan_first_publish_wait emits; tools/test_first_publish_confirm_evidence.py pins it with 6 cases and is discovered by the CI unit family (unittest discover -p test_*.py, confirmed 6 tests). Bounded: execute_release still recomputes first_publish_wait from the live classification at release.py:1337, so no publication authority over an established remote is granted.
