agent: saipen-cli-02
role: core
model_or_runtime: unknown
project: vacterro-zaicode
saipen_version: 8.0.1
protocol_fingerprint: sha256:078e95bc29bd7c0d162bea579431bf3cb7cbae349439feeae4b0d5f2087bf06b
source_head: 491590d66f93cc83aa0e71636b9e0594e37af7db
source_tree_fingerprint: git-delta-v1:a15d9b96f4cfdac6ce9e7d50825f11e4de6cae063422b350cf95a333332cb421
discovery_model: git-delta-v1
context_scope: SAIPEN audit, phase DONE
context_available: partial
report_status: complete

## RUN 1

IMP-001 [P2] [LOGIC_ERROR] [reproduced] [note] -- editing a protocol document while an improve cycle is active invalidates that cycle's submitted report, and the repair costs a whole replacement seat re-audit instead of a re-bind
  expected: a protocol edit landing between an audit's submit and its verify either re-binds the completed report or names a repair that does not discard the submitted findings
  actual: the saipen-cli-01 report carries protocol_fingerprint sha256:0ce0b643..., the installed fingerprint became sha256:078e95bc... the moment ship.md was committed, and both improve verify and improve cycle-complete then refuse; improve reconcile does not re-bind either -- it demands a NEW same-scope seat that re-audits the entire tree before the cycle can close
  evidence: the canonical validator reports exactly one FAIL for this project, the saipen-cli-01 report fingerprint mismatch, and improve reconcile replies 'stale COMPLETE seat saipen-cli-01 has no current same-scope replacement seat; create one with saipen improve --new-seat --role core'
