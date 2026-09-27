agent: claude-code-01
role: core
model_or_runtime: unknown
project: _zaicode
saipen_version: 8.0.1
protocol_fingerprint: sha256:63ba940f408711410413d3ff33e8c5eabb8063879f10d4b69096de9f02f0ea78
source_head: 078a29f000c8e53059521c78d352ba5abfb10706
source_tree_fingerprint: git-delta-v1:04ab4e10553e23344483c12e3d52420242213c0bd5915ea324406c846f50bbb5
discovery_model: git-delta-v1
context_scope: SAIPEN audit, phase DONE
context_available: partial
report_status: complete

## RUN 1

SAIPEN self-audit at phase DONE, scope: this project's installer documentation and clone sources at source_head 078a29f, git-delta-v1 binding zcode 84a984b. Cycle 19 was aborted because the auditor edited product source mid-audit and the nested binding correctly refused its completion; this cycle is the replacement, and it audited the installer doc against the installer's real defaults rather than against memory.

IMP-001 [P1] [PROJECT_VIOLATION] [observed] [ticket] The installer clones the app source from branch main, which is six commits behind the branch the work actually lands on, so a fresh install does not get T-72 or T-78.
expected: the branch the installer pulls is the branch carrying the current product, so a fresh install matches what the developer runs
actual: ZaicodeInstallLib.ps1:16 sets AppBranch = 'main' and line 285 clones ZaicodeRepo at that branch into zcode\. On the published fork, main is 8cfd4f4 (T-63, SRC-048) while zaicode is 8914bf6 (T-72, SRC-052/053), and `git rev-list --count backup/main..backup/zaicode` is 6. `git merge-base --is-ancestor` answers NO for both 8914bf6 and 84a984b against backup/main, so a fresh install receives neither T-72's user-feedback wave nor the T-78 test entry point
evidence: git ls-remote --heads vacterro/zaicode shows main=8cfd4f43, workspace=fa7385e8, zaicode=8914bf6; the installer's own defaults at ZaicodeInstallLib.ps1:14-17 name the four repos and branches, and the doctor check 'app-source' validates only that zcode\ is a clone, never which branch or how current it is. Two routes and the choice between them is the operator's, not the auditor's: merge zaicode forward into main, or point AppBranch at the branch the work lands on. The auditor did not pick one -- merging six commits into a published branch is an outward-facing release decision, and naming a feature branch as the install source is only correct while that branch is the release branch

IMP-002 [P3] [PROJECT_VIOLATION] [observed] [fix] The install doc still tells a reader to expect a saimail-local warning that no longer happens.
expected: the install document describes the state a fresh install actually reaches
actual: the row still advertises a WARN that a reader will wait for and a maintainer will chase. Nothing in the install path produces it any more

evidence: docs/ZAICODE_INSTALL.md line 36 reads '| saimail-local | SAIMAIL\'s command-line client, which ZAICODE\'s SAIMAIL panels use (WARN until the published SAIMAIL ships it) |'. That parenthetical became false earlier in this session when SAIMAIL was published as b3cc4f6 then d2fa09e, and cycle 18 measured the consequence directly: a layout built from fresh clones of both published repos reports saimail-cli OK, alongside saipen OK, saipen-launcher OK and saimail OK. The other claims on that table were checked rather than assumed and are current: line 32 branch workspace matches RootBranch, line 33 branch main matches AppBranch, and the Node 24.14.0 pin matches ZaicodeInstallLib.ps1:18

Nothing else was found. The rest of the install doc was read against the code and is consistent: the four clone entries match ZaicodeInstallLib.ps1:284-287, the parameter table matches the installer's declared parameters, and the manual-verify steps referenced for T-9 live in ZAICODE_ACCOUNT_INDEPENDENCE_VALIDATION.md. Validator VALID, structural gate pass, exit 0, 0 blocking findings, the 17 warnings unchanged from cycle 3. Board: DOING and TODO empty apart from the two tickets this RUN opens and T-9. The T-78 fix is committed in the nested repo as 84a984b and 364 tests pass through the entry point it added. Both the outer tree and zcode/ were clean when this cycle was admitted.
