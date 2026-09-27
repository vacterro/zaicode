# Handoff: make SAIPEN portable across machines and operating systems

| | |
|---|---|
| To | SAIPEN protocol maintainer (`github.com/vacterro/saipen`) |
| From | ZAICODE workspace (`github.com/vacterro/zaicode`, branch `saipen-live`), ticket T-86, source receipt SRC-057 |
| Date | 2026-09-27 |
| Kernel examined | `main` at `3088efffb61de1c4cea9cde2e15daf641654c4dc` (`VERSION` 8.0.1), plus tag `v8.0.1` at `7145548` |
| Status | OPEN. Nothing here was changed in `vacterro/saipen`; this document is the whole request |

## What happened

ZAICODE runs one SAIPEN workspace from two executors: the operator's Windows
machine and a Claude Code Cloud Linux container. They exchange checkpoints over
one Git branch (`docs/ZAICODE_SAIPEN_CLOUD.md`).

The same `.saipen/` bytes got two different verdicts:

- Windows, `V:\___VAC\__K\__CODE\_AI_STUFF_AGENTIC\_ZAICODE`, head `72095ed`:
  core conformance receipt `receipt-e5b4f9583188`, `verdict: PASS`,
  `problem_count: 0`, 2026-09-27T05:44:08Z. The receipt is committed in
  `35054b3`.
- Linux, `/home/user/zaicode`, head `35054b3`, kernel `3088eff`:
  `Validation FAILED: 4 problem(s), 18 warning(s)`, all four
  `closure-evidence` for T-47, T-62, T-76 and T-78.

`35054b3` is `72095ed` plus that one receipt file. STATE, BOARD and LOG are the
same bytes on both sides.

The project was fine on both machines. SAIPEN ties durable evidence to the
absolute path of the checkout, so the evidence is valid only on the machine
that wrote it. The cloud session also found three more things that tie SAIPEN
to one machine. They are listed below in order of severity, and the last
section proposes a gate that keeps them from coming back.

## Findings

### P1-1. Durable evidence is bound to a machine-local path

`tools/saipen_engine/paths.py:826-838` defines

```python
def project_identity(root: Path) -> str:
    return os.path.normcase(os.path.realpath(str(root)))
```

and its own docstring says it "must never be treated as durable portable
evidence: moving the project changes it. Durable portable binding uses
`project_lineage_identity` instead."

Some Git-tracked records still write that value and then require it to match
on read:

| Durable record (tracked under `.saipen/`) | Writes identity | Requires equality on read | Effect on another machine or path |
|---|---|---|---|
| LOG event sidecars, `recovery/log-detail/` | `log_compaction.py:69` | `log.py:366-381` (`_read_detail_text`, key at `:372`) | The compacted event's text is not restored, so `verification_evidence` sees `detail_ref: ...` instead of `PASS ... conf: high`. Result: `closure-evidence` FAIL |
| BOARD compaction details, `recovery/board-compaction/` | `board_compaction.py:445`, `:573` | `board_compaction.py:1036`, `:1109` | "BOARD detail project identity mismatch" |
| Re-verification receipts, `recovery/conformance/reverify/` | `debt.py:1521` | `debt.py:1165` (`REVERIFY_RECEIPT_FOREIGN_PROJECT`), `debt.py:1633` (skipped without a message) | Evidence from `saipen work reverify` is lost when the project is opened from another path |
| Accepted debt | `accepted_debt.py:436` | `accepted_debt.py:169` (`ACCEPTED_DEBT_FOREIGN_PROJECT`) | Refused |
| External-implementation receipts | `external.py:246` | `external.py:299` | Closure-provenance problem |
| Release scope records | `release.py:736` | `release.py:1737` (`PATH_ESCAPE`) | Refused |

What we measured on ZAICODE:

- Every `log-detail`, `board-compaction`, `reverify` and `debt` record carries
  `"project_identity": "v:\\___vac\\__k\\__code\\_ai_stuff_agentic\\_zaicode"`.
- A direct probe of E-1289 (T-78's VERIFY verdict, 1473 bytes) shows it was
  externalized because it exceeds `MAX_NEW_EVENT_BYTES = 1024`
  (`log.py:770`). It parses with `detail_integrity: invalid`, even though the
  sidecar's sha256 `981f4b6f1410ad0de4ce2bc541000da88199836e8c06a49736e8d5bd4dfa7fa4`
  matches the metadata exactly. Only the identity comparison rejects it.
- This makes the harm worse: any verdict over 1 KB gets externalized, so a
  more detailed verification record is more likely to disappear on another
  machine. That is the failure class `_restored_detail_text`'s docstring
  (`log.py:291-307`) says it fixed.

Fix:

1. Every reader of a durable record binds on `project_lineage` and never on
   `project_identity`. The lineage is already checked next to the identity in
   each reader listed above, so the fix is to delete a comparison. No new one
   is needed.
2. Writers can keep the machine path as a diagnostic field with a clear name,
   for example `captured_on`. It must never be used to decide anything.
3. `project_identity` stays what its docstring says it is: a key for locks,
   journals and runtime (`runtime_lock_identity`, `paths.py:841-848`).
   Checks that compare a plan with its execution inside one run, such as
   `release.py:1851`, are machine-local by nature and can stay as they are.
4. No data migration is needed. Existing records already carry
   `project_lineage`.

### P1-2. `STATE.saipen_home` stores a machine path in shared, versioned state

CORE § 1.2 defines the pointer as "the absolute path to the SAIPEN home on the
machine that last checkpointed". In a workspace that travels over Git, that
value is wrong on every other machine, every time.

- `state.py:782-819` (`persisted_home_error`) treats a foreign-OS absolute
  pointer as dead. `operations.py:320-329` then refuses every ordinary
  mutation with `home-dead` until the pointer is converged with
  `saipen rebind-home --auto` or rebound explicitly.
- Kernel `3088eff` repairs the pointer automatically: the continue router
  converges it to the executing engine (`operations.py:8747`; ZAICODE E-1410,
  `saipen_home automatically converged ... previous pointer:
  C:/Users/vac34/.config/opencode/skills/saipen`). This recovers, but every
  switch of executor writes one DEC and one STATE diff. The history fills with
  back-and-forth rebinds. If two executors checkpoint at the same time, the
  `saipen_home:` line in `STATE.md` is a guaranteed merge conflict.
- The kernel at tag `v8.0.1` has no automatic convergence. There,
  `python3 tools/saipen.py continue --json` answered `home-dead ... repair it
  with saipen rebind-home <candidate-home-path>`, and `validate` answered
  `REFUSE [HOME_REQUIRED]`.

Fix:

1. Move the pointer out of versioned state, into a machine-local file. That
   can be an ignored `.saipen/` file or per-user configuration keyed by
   lineage.
2. Resolve the home from the running engine.
3. `STATE.md` keeps only a portable protocol identity: `saipen_version` plus
   the kernel commit or ruleset digest.
4. An absolute home found in STATE becomes a legacy WARN. It is not a reason to
   refuse mutation.

### P1-3. One version string, two very different kernels

- Tag `v8.0.1` points to `7145548` ("closure v8.0.1: ticket T-1298 DONE").
  `main` is `3088eff`. Both say `VERSION` 8.0.1.
  `git diff --stat 7145548 3088eff`: `967 files changed, 184683
  insertions(+), 5543 deletions(-)`.
- The version string does not show how differently the two behave:
  - At `7145548`, `saipen validate` is a phase-trigger verb
    (`tools/saipen.py:5864`, `_PHASE_VERBS` includes `"validate"`, which
    routes to `transition_phase(VALIDATE)`). A consumer who runs "validate"
    gets a state mutation.
  - At `3088eff`, `saipen validate` is the read-only validator
    (`tools/saipen.py:8972`).
  - The `7145548` validator rejects BOARD fields that the later engine writes
    (`closure_mode`, `user_explicit`, `detail_ref`, `blocker_scope`). That
    gave 40 false FAILs on ZAICODE.
- The operator's installed kernel is not byte-identical to any published
  commit. `3088eff` reports 15 `cross-doc-drift` WARNs on ZAICODE, but
  ZAICODE's T-69 recorded 0 against the local install. A second machine has no
  way to fetch "the kernel this project was validated with".

Fix:

1. Bump `VERSION` on every published change to behaviour, validator or
   engine.
2. Tag every release.
3. Refuse to publish unless `VERSION`, the release tag and `HEAD` agree.
4. Record the kernel commit or ruleset digest in each conformance receipt, so
   a second executor can fetch that exact kernel.

### P2-4. The published `bin/` shims work on one machine only

`bin/saipen:2` and `bin/saipen.cmd:2` both hardcode

```
C:\Users\vac34\AppData\Local\Programs\Python\Python311\python.EXE
V:\___VAC\__K\__CODE\_AI_STUFF_AGENTIC\_SAIPEN\tools\saipen.py
```

`bin/saipen` is also a POSIX `sh` script that executes a Windows path, so it
cannot run anywhere.

Fix (either option):

- Generate the shims at install time (`bootstrap/cli_launcher.py` already
  exists) and ignore `bin/` in Git.
- Make the shims relative: `exec python3 "$(dirname "$0")/../tools/saipen.py" "$@"`
  and `py -3 "%~dp0..\tools\saipen.py" %*`.

### P3-5. Byte-bound evidence depends on the consumer's `.gitattributes`

Sidecars are checked by sha256 (`log.py:397-400`). A Windows clone with
`core.autocrlf=true` rewrites their line endings unless the consumer
repository marks them `-text`. ZAICODE's `.gitattributes` does. A new project
created by `saipen init` does not unless someone remembers to add it.

Fix:

1. `init` writes the `-text` block for `.saipen/intake/**`,
   `.saipen/archive/source/**`, `.saipen/recovery/log-detail/**` and
   `.saipen/recovery/board-compaction/**`.
2. The validator WARNs when `git check-attr text` on those paths is not
   `unset`.

## The gate that keeps this fixed

Make portability a release gate that fails when this class of defect comes
back.

1. **Relocation test** (`tools/test_portability.py`, stdlib `unittest`).
   1. Build a fixture project with:
      - a DONE ticket whose only VERIFY PASS event is longer than
        `MAX_NEW_EVENT_BYTES`;
      - a compacted BOARD row;
      - a re-verification receipt and an accepted-debt record;
      - a STATE whose `saipen_home` is a foreign-OS absolute path
        (`C:/Users/x/saipen` on POSIX, `/home/x/saipen` on Windows).
   2. Validate it at root A.
   3. Copy the tree byte for byte to root B, with a different depth, case and
      separator style, and validate again.
   4. Assert both verdicts are PASS and identical, with no `*_FOREIGN_PROJECT`
      refusal, no `detail_integrity: invalid`, and no mutation refused as
      `home-dead`.
2. **Git round-trip.** Clone the fixture repository once with
   `core.autocrlf=true` and once with `false`. Validate both.
3. **CI matrix.** Run `ubuntu-latest`, `windows-latest` and `macos-latest`
   with Python 3.11 and 3.12, over the relocation test and the full
   conformance corpus. A verdict that changes with location blocks the release.
4. **Red control (required, per VERIFY-ORACLE-01).** Put the identity
   comparison back into `_read_detail_text` and show the gate turns red. A
   portability gate that cannot fail proves nothing.
5. **Static guard.** An `audit_checks.py` AST rule fails any comparison of
   `.get("project_identity")` with `==` or `!=` outside an allowlist of
   machine-local modules: locks, journal and runtime. New code then cannot
   reintroduce P1-1 unnoticed.
6. **Release hygiene.** The P1-3 `VERSION`/tag/`HEAD` equality check, plus no
   absolute machine paths in published files outside test fixtures. A grep
   for `[A-Za-z]:\\`, `/home/<user>/` and `/Users/<user>/` over `bin/`,
   `tools/` and `saipen/` would have caught P2-4.

## Acceptance for closure (on the SAIPEN side)

1. ZAICODE `saipen-live` at any head after `86dd3ff`, validated on Linux at
   `/home/user/zaicode`, reports no `closure-evidence` FAIL for T-47, T-62,
   T-76 or T-78, and nothing in ZAICODE's `.saipen/` was edited to get there.
2. The same project on the Windows operator machine is still `CURRENT_PASS`.
3. A fresh clone at a third path gives the same verdict.
4. Switching executor locality does not require a STATE write.
5. A consumer can pin the exact kernel by tag, and no two different kernels
   share one `VERSION`.
6. The portability gate runs in CI, and its red control is recorded.

## Reproduction

```sh
git clone -b saipen-live https://github.com/vacterro/zaicode z && cd z
git clone https://github.com/vacterro/saipen .claude/saipen-protocol
git -C .claude/saipen-protocol checkout 3088efffb61de1c4cea9cde2e15daf641654c4dc
git clone -b zaicode https://github.com/vacterro/zaicode zcode
python3 .claude/saipen-protocol/tools/validate.py --project-root "$PWD"
# Validation FAILED: 4 problem(s) -- closure-evidence T-47, T-62, T-76, T-78
```

The `zcode` clone is needed. ZAICODE declares `zcode/` in
`.saipen/source-nested-repos.json`, so without the clone the validator stops
with a fifth, intentional FAIL:
`source freshness computation BLOCKED -- declared nested repository is missing: 'zcode'`.
That behaviour is correct and is not part of this request. The commands above
were run exactly as written on 2026-09-27 at a scratch path, with and without
the `zcode` clone.

The validator describes itself as read-only, but that run writes one receipt
under `.saipen/recovery/conformance/`. That is worth a look too.

Isolate the cause:

```sh
python3 - <<'EOF'
import sys; sys.path.insert(0, ".claude/saipen-protocol/tools")
from pathlib import Path
from saipen_engine import log
snap, _ = log.read_history_snapshot_and_logs_digest(Path("."))
ev = next(e for e in snap.events if e["event"] == 1289)
print(ev.get("detail_integrity"), ev["text"][:90])
# invalid detail_ref: .saipen/recovery/log-detail/E-1289-981f4b6f1410ad0de4ce2bc5.json
EOF
```

## What ZAICODE does in the meantime

- The cloud executor records the four `closure-evidence` FAILs as a known
  cloud-parity boundary, not a regression. No ZAICODE record is rewritten to
  hide them, and the kernel is not patched locally to turn the gate green.
- ZAICODE's cloud adapter (`.claude/skills/saipen/SKILL.md`) is moving its
  kernel pin from the tag to commit `3088eff`. That change is tracked as a
  separate ZAICODE ticket.
- To avoid creating new cloud-bound sidecars, the cloud executor keeps its LOG
  events under 1 KB until P1-1 lands.
