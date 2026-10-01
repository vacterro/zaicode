agent: saipen-cli-01
role: core
model_or_runtime: unknown
project: vacterro-zaicode
saipen_version: 8.0.1
protocol_fingerprint: sha256:078e95bc29bd7c0d162bea579431bf3cb7cbae349439feeae4b0d5f2087bf06b
source_head: 2905f3b230d55187fa354ff6580c52e8d7638b1f
source_tree_fingerprint: git-delta-v1:a15d9b96f4cfdac6ce9e7d50825f11e4de6cae063422b350cf95a333332cb421
discovery_model: git-delta-v1
context_scope: SAIPEN audit, phase DONE
context_available: partial
report_status: complete

## RUN 1

IMP-001 [P2] [LOGIC_ERROR] [proven] [ticket] -- the verified-stable tag is pushed to the public remote before the release assets exist, so a failed publish leaves a public tag asserting verified distribution with nothing behind it
  expected: the durable public claim about verification is made only when the thing it describes exists, or a failure removes the claim
  actual: the script creates the annotated tag, pushes it to origin, and only then runs gh release create; when that call fails the script throws 'tag exists, inspect before retry' and the pushed tag survives as the public artifact, carrying the message 'ZAICODE <version> verified stable distribution' while no release, installer or manifest is attached
  evidence: release/Publish-Release.ps1:46-51 in that order; the ordering is forced by gh release create --verify-tag on line 50, which refuses to run unless the tag already exists on the remote, so the remedy is a decision about remote state -- delete the tag on failure, or keep it and accept a claim with no artifacts -- and that decision belongs to the release authority, not to the script

IMP-002 [P3] [VAGUE] [proven] [note] -- the published manifest's approval flag is asserted by the publisher itself one line before the check that tests it, so it carries no independent evidence for whoever reads it later
  expected: an approval field in a published artifact records an approval that an independent party made
  actual: Publish-Release.ps1 reads stable.json, sets $manifest.approved = $true, and then calls Assert-ReleaseManifest, whose identity check requires approved to be true; the published stable.json therefore always says approved: true by construction, whatever the incoming manifest said
  evidence: release/Publish-Release.ps1:24-26 sets and validates in that order; release/ReleaseLib.ps1:52 tests $Manifest.approved -ne $true
