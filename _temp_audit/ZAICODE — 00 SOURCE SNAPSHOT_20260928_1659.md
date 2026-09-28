ZAICODE

# Source snapshot and execution law

This handoff set was prepared from `_ZAICODE_28.09.26-T16-59-24.zip`.

Observed snapshot truth:
- Outer project: `_ZAICODE`.
- Branch: `master`.
- Outer HEAD recorded by the archive: `73b62ff2`.
- Working tree was dirty with 6 changed files when the archive was created.
- SAIPEN state: `DONE`, task `none`, next action `saipen continue`, blocker `none`.
- Latest completed user work includes T-105 (SAIASUI / ProTrail invariant and game settings).
- T-94 and T-9 remain operator-blocked and must not be falsely closed by unrelated work.
- The audit export intentionally omits much of the nested `zcode` implementation. At execution time, inspect the real current nested product tree and bind every change to the then-current source HEAD rather than assuming this export is a complete source checkout.

## Mandatory recovery before every wave

1. Read `CLAUDE.md`.
2. Read the current `.claude/skills/saipen/SKILL.md`.
3. Recover from `.saipen/STATE.md`, `.saipen/BOARD.md`, and the current LOG tail.
4. Run the canonical SAIPEN continuation/intake path. Do not edit protocol state manually.
5. Confirm outer repository and nested product branch, HEAD, remotes, and worktree status.
6. Keep `master` as the operator's primary outer working branch unless current repository law says otherwise.
7. Preserve every pre-existing dirty file. Never reset, clean, force-checkout, stash-and-drop, rebase over operator work, or force-push.
8. Convert the wave into normal SAIPEN source receipts/tickets. Do not treat these files as authority to bypass VERIFY/REVIEW/SHIP.
9. Re-check whether a requested item has already changed since this snapshot. Implement the current unmet behavior, not stale line numbers.

## Global quality law

- Reproduce defects before patching where feasible.
- Prefer root-cause fixes over UI masks.
- Add focused RED -> GREEN regressions for every deterministic defect.
- Do not weaken tests or expected output to make a change pass.
- Separate independent fixes into bisectable commits where practical.
- Use existing ZAICODE services/stores/contracts before introducing parallel state systems.
- User-facing state must be truthful. Never display ready/running/complete when the authoritative backend says otherwise.
- For platform-only behavior, automated evidence may establish engineering readiness, but live Windows-only acceptance remains NOT RUN until actually observed.
- Run focused tests plus the repository's current canonical typecheck, lint, architecture, test and pre-push gates relevant to the touched packages.
- Run `git diff --check` before shipping.
