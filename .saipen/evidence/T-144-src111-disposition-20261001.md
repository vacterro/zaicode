# T-144 / SRC-111 — disposition of the four parked blockers

SRC-111 (operator, verbatim): «Висячие блокеры кастати можешь закрыть PASS потому что
юзаю норм и без проблем работает, на ночь оставляю и работает, значит гуд.»

Translation: the hanging blockers can be closed PASS, because I use it, it works fine and
without problems; I leave it running overnight and it works, therefore good.

**Not closed. Ticked PASS would be a falsification, not a closure.**

SRC-110's own instruction, in force on this same ticket, forbids exactly this:
«не переписывать историю протокола / не выдумывать закрытие». SRC-111 is one operator
sentence; SRC-110 is another, on the same ticket, and the two are reconciled in favour of
the one that keeps the record true. A PASS written on the strength of "it works for me"
is a claim about the operator's nightly use; the blockers are not about nightly use.

## What each blocker actually is, re-checked at BUILD on 2026-10-01

### T-141 — `EXTERNAL_MAINTENANCE_REQUIRED`, root release inventory

Not in this repository. `release_contract.py:19` in the bound installation enumerates
every `.saipen/saitranslate/kitchen/<dir>/` and constructs `README_<DIR>.md`. Eight of
those directories are producer infrastructure (`cli, docs, drafts, extras, integration,
integration-workspace, outbox, payload`), not locale mirrors. Re-verified: all eight paths
are still MISSING. The real locale READMEs live at `docs/locales/<locale>/README.md`.

Creating eight fake READMEs would make `saipen ship` green while the release inventory is
still wrong — that is the falsification, in the exact place SRC-110 forbids it. The
operator assigned protocol maintenance to the other maintainer (recorded in
`.saipen/evidence/T-141-release-blocker.md`). That instruction is still the operative one.

The product half of T-141 IS closed: `.saipen/evidence/T-141-packaged-boot.json` records
`ok: true`, `window: true`, `noErrorCard: true`, `consoleErrorCount: 0` on a packaged
build. The "Window start failed" screenshot defect is fixed and evidenced. Only the
protocol-home publication gate remains, and it is not this repository's to change.

### T-137 — `EXTERNAL_MAINTENANCE_REQUIRED`, same root, plus T-9/T-94 authority

`blocker:` names T-141's root parity, then T-9 and T-94's verified closure. Same gate.

### T-94 / T-9 — `RELEASE_AUTHORITY_PENDING`, no COMMITTED release receipt

The inherited closure genuinely fails, and its own preview records why:
`saipen ticket done T-94 --closure-mode inherited_verified --implementation-source
release:d359a2a9 --dry-run` returns `VALIDATION_FAILED`: *"no COMMITTED release receipt
names 'd359a2a9e44d082fb842602bdbefd13c4358c583'"*. The single receipt on disk
(`.saipen/kitchen/release_receipt.json`) names `046a5fb4` / T-108, `mode: no-publish`.
There is no receipt for any product head this ticket could bind to.

T-94's human acceptance is already recorded — `T-94-closure-pending-20261001.json` carries
`answer: PASS` for three-monitor placement, click-through and restart at events E-2410 /
E-2420. The *human* half of T-94 is satisfied. What is missing is a machine-checkable
release receipt, which is produced by a publish, which SRC-110 gates on a genuine clean
Windows acceptance run that has not happened.

## What SRC-111 legitimately changes

The operator's statement is real evidence and it is recorded as such: the product runs
overnight without operator intervention. That is worth having on the record and it is the
reason T-141's product half is considered settled.

It is not a substitute for:
- a COMMITTED release receipt (T-94, T-9),
- a protocol-home inventory repair in the other maintainer's tree (T-141, T-137).

Neither of those can be produced from this seat without a human, and neither may be faked.

## What would legitimately lift each one

| Ticket | Lifted by | Who |
|---|---|---|
| T-141, T-137 | repair `locale_readme_paths` discovery in the protocol home, or narrow it to the real locale dirs | the other SAIPEN maintainer |
| T-94, T-9 | a real publish: `release/Publish-Release.ps1` on a clean Windows machine, producing the receipt | operator / release authority |

The `release/` bundle committed this ticket exists to make the second row a command rather
than a project. It has not been run on a clean machine, so the receipt does not exist yet,
and this ticket does not pretend otherwise.

## Verdict

`NOT_CLOSED — blockers real and external`. No ticket was ticked PASS, no receipt was
fabricated, no blocker text was rewritten to look softer. The operator's overnight-use
statement is recorded as supporting evidence, which is what it is.
