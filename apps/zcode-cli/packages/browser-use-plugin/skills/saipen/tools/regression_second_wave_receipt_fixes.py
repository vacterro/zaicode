"""Regression tests for the SAIPEN AUDIT SECOND WAVE receipt-scanner fixes.

These pin the W2-001 / W2-002 / W2-003 / W2-005 repairs that the
operations-side (claim/handover/goal) 48/48 suite does not exercise:

  * W2-001 -- journal._scan_receipt_namespace routes every candidate through the
    ONE strict decoder; corrupt evidence is surfaced (not silently skipped);
    a duplicate op_id across ops/settled collapses only when both sides are
    equivalent terminal receipts.
  * W2-002 -- release / subs / journal scanners read BOTH recovery/ops and
    recovery/settled; sub_sync returns the ACTUAL receipt path, not a
    reconstructed recovery/ops guess.
  * W2-003 -- release recovery returns ALREADY_APPLIED only when BOTH the
    generic status AND release_stage are COMMITTED; a split truth is
    RELEASE_STAGE_INCOMPLETE.
  * W2-005 -- compact_committed drops staged payloads and removes the cleanup
    marker only after proving no staged payload remains; a failed drop retains
    the marker for retry.

Run standalone:
    python tools/test_second_wave_receipt_fixes.py

Exit code 0 when every assertion passes; 1 on the first failure batch.
"""

from __future__ import annotations

import datetime
import json
import sys
import tempfile
import unittest.mock as mock
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.journal import (  # noqa: E402
    OPS_DIR,
    SETTLED_DIR,
    compact_committed,
    hash_bytes,
    run_mutation,
    semantic_receipt_snapshot,
)
from saipen_engine.operations import (  # noqa: E402
    finalize_converge_intent,
    set_converge_intent,
)
from saipen_engine.release import (  # noqa: E402
    _committed_release_receipts,
    recover_release_op,
)
from saipen_engine.subs import (  # noqa: E402
    _collect_linkage,
    _latest_sub_sync_inventory,
)
from saipen_engine.state import running_home, running_style_token  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL"), name, ("" if cond else f"-- {detail}"))


# A minimal but strictly-valid target: role "generic" + action "write" with an
# owned .saipen path. A COMMITTED (settled) receipt needs no staged evidence.
_TARGET = {
    "path": ".saipen/kitchen/_receipt_test.json",
    "role": "generic",
    "before_hash": "",
    "after_hash": "x",
    "applied": True,
    "action": "write",
    "content": "{}",
}


def _write_receipt(
    root: Path,
    op_id: str,
    operation: str,
    status: str = "COMMITTED",
    ns: str = "ops",
    extra: dict | None = None,
) -> dict:
    """Write a strictly-valid operation.json under recovery/ops or
    recovery/settled for op_id, returning the record dict."""
    base = root / (OPS_DIR if ns == "ops" else SETTLED_DIR) / op_id
    base.mkdir(parents=True, exist_ok=True)
    # W2-001: a legacy (no-lineage) receipt is usable only at the EXACT
    # runtime identity that created it. Default project_identity to the live
    # runtime identity so the fixture is a same-project legacy receipt rather
    # than an accidental foreign transplant.
    from saipen_engine.paths import runtime_lock_identity

    rec = {
        "op_id": op_id,
        "status": status,
        "operation": operation,
        "semantic_payload_hash": "x",
        "created_at": "2026-08-20T00:00:00Z",
        "agent": "test-agent",
        "project_identity": runtime_lock_identity(root),
        "verification_policy": "none",
        "preconditions": {},
        "progress_index": 0,
        "targets": [dict(_TARGET)],
    }
    if extra:
        rec.update(extra)
    (base / "operation.json").write_text(json.dumps(rec))
    return rec


def test_w2001_scanner() -> None:
    # (a) malformed receipt -> surfaced as error, never trusted as evidence.
    root = Path(tempfile.mkdtemp())
    bad = root / OPS_DIR / "bad1"
    bad.mkdir(parents=True)
    (bad / "operation.json").write_text("}{ not json")
    records, errors = semantic_receipt_snapshot(root)
    check(
        "W2-001 malformed receipt surfaced as error", any("bad1" in e for e in errors), str(errors)
    )
    check(
        "W2-001 malformed receipt not selected as evidence",
        all(r.get("op_id") != "bad1" for r in records),
    )

    # (b) equivalent duplicate across ops+settled collapses to ONE record.
    root2 = Path(tempfile.mkdtemp())
    payload = {"semantic_payload_hash": "h-eq", "created_at": "2026-08-20T01:00:00Z"}
    _write_receipt(root2, "dup", "converge_intent", ns="ops", extra=payload)
    _write_receipt(root2, "dup", "converge_intent", ns="settled", extra=payload)
    records2, errors2 = semantic_receipt_snapshot(root2)
    ops = [r for r in records2 if r.get("op_id") == "dup"]
    check(
        "W2-001 equivalent duplicate collapses to one",
        len(ops) == 1,
        f"count={len(ops)} errors={errors2}",
    )

    # (c) non-equivalent duplicate -> corrupt evidence, NEITHER selected.
    root3 = Path(tempfile.mkdtemp())
    _write_receipt(
        root3, "dup2", "converge_intent", ns="ops", extra={"semantic_payload_hash": "h-a"}
    )
    _write_receipt(
        root3, "dup2", "converge_intent", ns="settled", extra={"semantic_payload_hash": "h-b"}
    )
    records3, errors3 = semantic_receipt_snapshot(root3)
    check(
        "W2-001 non-equivalent duplicate reported corrupt",
        any("dup2" in e for e in errors3),
        str(errors3),
    )
    check(
        "W2-001 non-equivalent duplicate not selected",
        all(r.get("op_id") != "dup2" for r in records3),
    )

    # (d) complete semantic meaning participates, not a small field subset.
    root4 = Path(tempfile.mkdtemp())
    _write_receipt(root4, "meaning", "crew_run", ns="ops")
    _write_receipt(root4, "meaning", "release", ns="settled")
    records4, errors4 = semantic_receipt_snapshot(root4)
    check(
        "W2-004 operation mismatch makes terminal duplicate corrupt",
        any("meaning" in error for error in errors4)
        and all(record.get("op_id") != "meaning" for record in records4),
        str(errors4),
    )

    # (e) persisted metadata is decoded before semantic consumers.
    root5 = Path(tempfile.mkdtemp())
    _write_receipt(
        root5,
        "bad-meta",
        "release",
        extra={"receipt_metadata": "not-a-map", "release_stage": "COMMITTED"},
    )
    records5, errors5 = semantic_receipt_snapshot(root5)
    check(
        "W2-005 malformed receipt_metadata is omitted with structured error",
        not records5 and any("receipt_metadata" in error for error in errors5),
        str(errors5),
    )

    # (f) a malformed twin invalidates the valid release in real consumers.
    root6 = Path(tempfile.mkdtemp())
    _write_receipt(
        root6,
        "release-twin",
        "release",
        ns="ops",
        extra={"release_stage": "COMMITTED", "crew_epoch": "epoch"},
    )
    corrupt = root6 / SETTLED_DIR / "release-twin"
    corrupt.mkdir(parents=True)
    (corrupt / "operation.json").write_text("}{", encoding="utf-8")
    check(
        "W2-007 corrupt twin cannot remain positive release evidence",
        _committed_release_receipts(root6) == [],
    )


def _write_no_ticket_project(root: Path) -> None:
    saipen = root / ".saipen"
    saipen.mkdir(parents=True)
    (saipen / "LOG.md").write_text(
        "# Log\n- 21.08.26 00:00 [E-1] [agent: test-agent] DEC: seed\n",
        encoding="utf-8",
    )
    (saipen / "BOARD.md").write_text(
        "## DOING\n\n## TODO\n\n## DONE\n\n## BLOCKED\n",
        encoding="utf-8",
    )
    (saipen / "STATE.md").write_text(
        "---\n"
        "phase: DONE\n"
        "task: none\n"
        'next_action: "saipen continue"\n'
        'blocker: ""\n'
        "transition_from: DONE\n"
        "saipen_version: 7\n"
        "schema_version: 3\n"
        "last_event: 1\n"
        f"style_contract: {running_style_token()}\n"
        f'saipen_home: "{running_home()}"\n'
        "agent: test-agent\n"
        "mode: full\n"
        'updated: "2026-08-21T00:00:00Z"\n'
        "execution_intent: normal\n"
        "---\n",
        encoding="utf-8",
    )


def test_optional_ticket_receipt_contract() -> None:
    # Backward compatibility: immutable settled receipts may carry explicit
    # JSON null. Decode accepts it and exposes one canonical absence shape.
    legacy = Path(tempfile.mkdtemp())
    _write_receipt(
        legacy,
        "nullable-ticket",
        "converge_intent",
        ns="settled",
        extra={
            "receipt_metadata": {
                "operation": "converge_intent",
                "ticket_id": None,
            }
        },
    )
    records, errors = semantic_receipt_snapshot(legacy)
    check(
        "2026 CORE-002 nullable legacy ticket_id decodes as absence",
        not errors
        and len(records) == 1
        and "ticket_id" not in (records[0].get("receipt_metadata") or {}),
        f"records={records} errors={errors}",
    )

    # Hostile shapes stay rejected; null compatibility must not weaken types.
    for label, hostile in (("number", 7), ("object", {}), ("list", [])):
        root = Path(tempfile.mkdtemp())
        _write_receipt(
            root,
            f"hostile-{label}",
            "converge_intent",
            ns="settled",
            extra={"receipt_metadata": {"ticket_id": hostile}},
        )
        hostile_records, hostile_errors = semantic_receipt_snapshot(root)
        check(
            f"2026 CORE-002 {label} ticket_id remains corrupt",
            not hostile_records and any("ticket_id" in error for error in hostile_errors),
            str(hostile_errors),
        )

    # The real converge writers must omit absence for both targets and both
    # finalizers; this also proves their semantic consumers see zero errors.
    project = Path(tempfile.mkdtemp())
    _write_no_ticket_project(project)
    outcomes = [
        set_converge_intent(project, "test-agent", "ship"),
        finalize_converge_intent(project, "test-agent", "ship", "ship complete"),
        set_converge_intent(project, "test-agent", "crew"),
        finalize_converge_intent(project, "test-agent", "crew", "crew complete"),
    ]
    written_records, written_errors = semantic_receipt_snapshot(project)
    relevant = [
        record
        for record in written_records
        if record.get("operation") in {"converge_intent", "finalize_ship", "finalize_crew"}
    ]
    epoch = json.loads((project / ".saipen" / "kitchen" / "crew_epoch.json").read_text())
    check(
        "2026 CORE-002 no-ticket ship/crew transitions and finalizers succeed",
        all(outcome.ok for outcome in outcomes),
        str([outcome.to_dict() for outcome in outcomes]),
    )
    check(
        "2026 CORE-002 new semantic receipts omit absent ticket_id",
        len(relevant) == 4
        and not written_errors
        and all("ticket_id" not in (record.get("receipt_metadata") or {}) for record in relevant)
        and "ticket_id" not in epoch,
        f"records={relevant} errors={written_errors} epoch={epoch}",
    )

    strict = Path(tempfile.mkdtemp())
    result = run_mutation(
        strict,
        "strict-metadata-finalizer",
        "strict_metadata_probe",
        "test-agent",
        "test-project",
        "strict-metadata-probe",
        [
            {
                "path": "result.txt",
                "role": "generic",
                "action": "write",
                "content": b"result",
                "before_hash": "",
                "after_hash": hash_bytes(b"result"),
            }
        ],
        preconditions={"result.txt": ""},
        receipt_metadata_finalize=lambda _root, _metadata: None,
        _ensure_lineage=False,
    )
    check(
        "2026 CORE-002 metadata finalizer remains dict-only",
        not result.get("ok")
        and result.get("code") == "CONFLICT"
        and "must return a dict" in result.get("detail", ""),
        str(result),
    )


def test_w2001_conformance_crash_stale_index() -> None:
    from saipen_engine import conformance

    root = Path(tempfile.mkdtemp())
    (root / ".saipen").mkdir(parents=True)
    # CORE-002: PASS receipt requires real checkpoint files + source identity.
    (root / ".saipen" / "STATE.md").write_text(
        "---\nphase: DONE\ntask: none\nnext_action: saipen continue\n"
        "blocker: \"\"\ntransition_from: SHIP\nsaipen_version: 7\nagent: t\n"
        "mode: full\nupdated: 2026-08-21T00:00:00Z\n---\n", encoding="utf-8"
    )
    (root / ".saipen" / "BOARD.md").write_text("# BOARD\n## TODO\n\n", encoding="utf-8")
    (root / ".saipen" / "LOG.md").write_text("# Log\n", encoding="utf-8")
    (root / "tracked.txt").write_text("receipt fixture\n", encoding="utf-8")
    import subprocess
    subprocess.run(["git", "init", "-q"], cwd=str(root), check=False)
    subprocess.run(["git", "add", "-A"], cwd=str(root), check=False)
    subprocess.run(
        ["git", "-c", "user.email=t@x", "-c", "user.name=t", "commit", "-q", "-m", "init"],
        cwd=str(root), check=False,
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    older = conformance.generate_conformance_receipt(root, gate="core", exit_code=0, now=now)
    try:
        with mock.patch.object(
            conformance, "_update_receipt_index", side_effect=RuntimeError("index crash")
        ):
            conformance.generate_conformance_receipt(
                root,
                gate="core",
                exit_code=1,
                now=now + datetime.timedelta(microseconds=1),
            )
    except RuntimeError:
        pass
    newest = conformance.latest_receipt(root, "core")
    check(
        "W2-001 crash-stale conformance index cannot hide newer FAIL",
        newest is not None
        and newest.get("verdict") == "FAIL"
        and newest.get("receipt_id") != older.get("receipt_id"),
        repr(newest),
    )


def test_w2002_ops_settled() -> None:
    # (a) settled release receipt is visible to crew finalize.
    root = Path(tempfile.mkdtemp())
    _write_receipt(
        root,
        "rel-1",
        "release",
        ns="settled",
        extra={"release_stage": "COMMITTED", "crew_epoch": "EPOCH-1"},
    )
    out = _committed_release_receipts(root)
    check(
        "W2-002 settled release receipt discovered",
        any(r.get("op_id") == "rel-1" for r in out),
        str(out),
    )

    # (b) ops release receipt still discovered (no regression).
    root2 = Path(tempfile.mkdtemp())
    _write_receipt(
        root2,
        "rel-2",
        "release",
        ns="ops",
        extra={"release_stage": "COMMITTED", "crew_epoch": "EPOCH-2"},
    )
    out2 = _committed_release_receipts(root2)
    check(
        "W2-002 ops release receipt still discovered", any(r.get("op_id") == "rel-2" for r in out2)
    )

    # (c) settled sub_sync receipt found with the ACTUAL settled path.
    inv = [
        {"path": "TEMPLATE", "kind": "directory", "source_hash": "delete-tree-sha256:" + "0" * 64}
    ]
    root3 = Path(tempfile.mkdtemp())
    _write_receipt(
        root3,
        "sync-1",
        "sub_sync",
        ns="settled",
        extra={"receipt_metadata": {"owned_source_inventory": inv}},
    )
    receipt, _inv, lineage = _latest_sub_sync_inventory(root3)
    check(
        "W2-002 settled sub_sync discovered",
        receipt is not None and lineage == "ok",
        f"lineage={lineage}",
    )
    check(
        "W2-002 sub_sync path is the actual settled path",
        receipt is not None and receipt.get("_receipt_path", "").startswith(SETTLED_DIR),
        str(receipt.get("_receipt_path") if receipt else None),
    )

    # (d) ops sub_sync still found (no regression).
    root4 = Path(tempfile.mkdtemp())
    _write_receipt(
        root4,
        "sync-2",
        "sub_sync",
        ns="ops",
        extra={"receipt_metadata": {"owned_source_inventory": inv}},
    )
    receipt4, _inv4, lineage4 = _latest_sub_sync_inventory(root4)
    check(
        "W2-002 ops sub_sync still discovered",
        receipt4 is not None and lineage4 == "ok",
        f"lineage={lineage4}",
    )


def test_resolved_collect_linkage() -> None:
    identity = "sha256:" + "a" * 64
    metadata = {
        "operation": "sub_collect",
        "status": "COMMITTED",
        "package_identities": [identity],
        "producers": ["saihunt"],
        "tickets": ["T-123"],
    }
    resolution = {
        "receipt_metadata": metadata,
        "resolution": "accept_live",
        "resolved_at": "2026-08-20T00:00:01Z",
        "resolver_agent": "test-agent",
        "resolution_applied_targets": [_TARGET["path"]],
        "resolution_skipped_targets": [],
        "resolution_evidence": "live accepted",
    }

    root = Path(tempfile.mkdtemp())
    _write_receipt(
        root,
        "collect-resolved",
        "sub_collect",
        status="RESOLVED",
        ns="settled",
        extra=resolution,
    )
    collected, links = _collect_linkage(root)
    check(
        "collect accept_live with every target applied is durable intake",
        collected == {identity} and links == {identity: "T-123"},
        f"collected={collected} links={links}",
    )

    root2 = Path(tempfile.mkdtemp())
    partial = dict(resolution)
    partial["resolution_applied_targets"] = []
    partial["resolution_skipped_targets"] = [_TARGET["path"]]
    _write_receipt(
        root2,
        "collect-partial",
        "sub_collect",
        status="RESOLVED",
        ns="settled",
        extra=partial,
    )
    collected2, links2 = _collect_linkage(root2)
    check(
        "collect partial accept_live is never durable intake",
        not collected2 and not links2,
        f"collected={collected2} links={links2}",
    )


def test_w2003_terminalization() -> None:
    # (a) fully committed (generic + release_stage) -> ALREADY_APPLIED.
    root = Path(tempfile.mkdtemp())
    _write_receipt(root, "rel-f", "release", ns="ops", extra={"release_stage": "COMMITTED"})
    res = recover_release_op(root, "rel-f")
    check(
        "W2-003 fully committed release returns ALREADY_APPLIED",
        res.get("code") == "ALREADY_APPLIED",
        str(res),
    )

    # (b) split truth (generic COMMITTED, stage not COMMITTED) -> NOT
    # ALREADY_APPLIED; RELEASE_STAGE_INCOMPLETE instead.
    root2 = Path(tempfile.mkdtemp())
    _write_receipt(
        root2, "rel-p", "release", ns="ops", extra={"release_stage": "CONTENT_COMMIT_CREATED"}
    )
    res2 = recover_release_op(root2, "rel-p")
    check(
        "W2-003 partial release is NOT ALREADY_APPLIED",
        res2.get("code") != "ALREADY_APPLIED",
        str(res2),
    )
    check(
        "W2-003 partial release returns RELEASE_STAGE_INCOMPLETE",
        res2.get("code") == "RELEASE_STAGE_INCOMPLETE",
        str(res2),
    )


def test_w2005_cleanup_debt() -> None:
    # (a) success path: staged payload removed, marker cleared, entry compacted.
    root = Path(tempfile.mkdtemp())
    _write_receipt(root, "clean1", "converge_intent", ns="settled")
    entry = root / SETTLED_DIR / "clean1"
    (entry / "leftover.staged").write_text("payload")
    marker_dir = root / SETTLED_DIR / ".cleanup-needed"
    marker_dir.mkdir(parents=True)
    (marker_dir / "clean1").write_text("")
    res = compact_committed(root)
    check("W2-005 staged payload removed on success", not (entry / "leftover.staged").exists())
    check("W2-005 cleanup marker cleared on success", not (marker_dir / "clean1").exists())
    check("W2-005 entry reported compacted", "clean1" in res["compacted"], str(res))

    # (b) debt path: a failed unlink retains the staged payload AND the marker
    # and reports the entry as skipped (never compacted).
    root2 = Path(tempfile.mkdtemp())
    _write_receipt(root2, "clean2", "converge_intent", ns="settled")
    entry2 = root2 / SETTLED_DIR / "clean2"
    staged2 = entry2 / "leftover.staged"
    staged2.write_text("payload")
    marker_dir2 = root2 / SETTLED_DIR / ".cleanup-needed"
    marker_dir2.mkdir(parents=True)
    (marker_dir2 / "clean2").write_text("")

    def _boom(self, *a, **k):
        raise OSError("simulated device busy")

    with mock.patch.object(Path, "unlink", _boom):
        res2 = compact_committed(root2)
    check("W2-005 failed unlink retains staged payload", staged2.exists())
    check("W2-005 failed unlink retains cleanup marker", (marker_dir2 / "clean2").exists())
    check("W2-005 entry reported skipped (debt)", "clean2" in res2["skipped"], str(res2))
    check(
        "W2-005 entry NOT compacted while in debt",
        "clean2" not in res2["compacted"],
        str(res2),
    )


def main() -> int:
    test_w2001_scanner()
    test_optional_ticket_receipt_contract()
    test_w2001_conformance_crash_stale_index()
    test_w2002_ops_settled()
    test_resolved_collect_linkage()
    test_w2003_terminalization()
    test_w2005_cleanup_debt()

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    total = len(RESULTS)
    print(f"\n{passed}/{total} SECOND-WAVE receipt regressions passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
