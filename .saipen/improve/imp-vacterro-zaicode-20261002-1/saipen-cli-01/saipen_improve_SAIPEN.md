agent: saipen-cli-01
role: core
model_or_runtime: unknown
project: vacterro-zaicode
saipen_version: 8.0.2
protocol_fingerprint: sha256:e2e83e5b9235858c329823b2b6ad75d5e27f8c21c3e16022c2cae1be5298c36a
source_head: 3e4e1de4e178eb480134be2abbca7cb159d12a4b
source_tree_fingerprint: git-delta-v1:a70a526cf8db410966df756a32508300f75e54bb11af097efda463a525a2a0d0
discovery_model: git-delta-v1
context_scope: SAIPEN audit, phase DONE
context_available: partial
report_status: complete

Audit of the work this seat closed since the last cycle (T-165 soak and its
harness fixes d6aef8f2/19576ff4/23df332f, T-149 dispose reachability
57719324/a2637371, T-163, T-150/157/158), read against the code that enforces
it. Findings are appended through `saipen improve submit`.

## RUN 1

IMP-001 [P2] [LOGIC_ERROR] [proven] [ticket] -- the soak verdict has no coverage gate, so a run that covered minutes reads exactly like a run that covered the horizon
  expected: a PASS verdict asserts that the app held its bounds across the window SRC-116 names, so the artifact distinguishes a run that actually covered the window from one that died early
  actual: buildVerdict receives config.soakHours and never reads it; durationSeconds is computed and only reported, never gated, so 25 samples taken from the healthy middle of the 11.2 h run replay as 'verdict: PASS' -- identical to the full 2341-sample verdict and indistinguishable inside verdict.json
  evidence: scripts/zaicode-soak-verdict.mjs:82-84 gates degradation on samples.length >= 20 and nothing gates coverage; config.soakHours is passed at scripts/zaicode-soak.mjs:394 and referenced nowhere in the verdict module; demonstrated with 'sed -n 1000,1024p .soak/run-2026-10-02/timeline.jsonl > mid_trunc.jsonl && node scripts/zaicode-soak.mjs --replay mid_trunc.jsonl' -> 'verdict: PASS' for 25 samples spanning about six minutes. This compounds with d6aef8f2: the early-exit path makes a dying app fail fast with exit code 1, but the artifact it still writes claims the run passed.

IMP-002 [P3] [LOGIC_ERROR] [proven] [ticket] -- after 57719324 stopped gating dispose on the source triple, the two refusals that mention currency still do
  expected: a refusal names the property it actually tested, so the message can be read as the reason
  actual: selection no longer compares source_head or source_tree_fingerprint, yet the zero-candidate refusal still reads 'no current READY package to dispose' and the multi-candidate refusal still reads 'multiple current READY packages; dispose exactly one by package id'. Neither is current any more -- the honest test is READY, and a weak reader is sent looking for a staleness problem that does not exist, which is the misreading T-149's own weak_model note names
  evidence: tools/saipen_engine/subs.py:4674-4692 (57719324) is the selection loop; the refusals immediately below it were untouched by that commit; the pre-fix run of tools/test_sub_dispose_after_collect.py against 57719324~1 prints exactly 'PACKAGE_INCOMPLETE: saiui: no current READY package to dispose'

IMP-003 [P3] [LOGIC_ERROR] [suspected] [ticket] -- a verdict is built from statSync(APP) after the run, so a binary that disappears mid-soak destroys the evidence instead of describing it
  expected: a harness whose early-exit path exists to preserve the samples already on disk still writes a verdict when the binary under test is replaced or removed during the window
  actual: after the try/finally, buildVerdict is called with app.builtAt computed from statSync(APP).mtimeMs. A replaced or deleted exe makes that throw, main() rejects, and the .catch handler prints the stack and exits 1 -- with no verdict.json and no report, so the timeline survives alone and the artifact the ticket cites is gone
  evidence: scripts/zaicode-soak.mjs:394-397 (statSync(APP) in the verdict config) and the top-level main().catch at the end of the file. Marked suspected, not proven: this needs a live run against a binary deleted mid-window, which was not executed in this cycle -- the code path is read, not run.
