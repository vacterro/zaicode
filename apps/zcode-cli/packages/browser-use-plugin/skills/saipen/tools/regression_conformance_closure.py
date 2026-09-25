"""Regression matrix for SAIPEN Conformance Closure Hardening (§1-§10).

Exercises the load-bearing core in `saipen_engine/conformance.py` so that a
project can NEVER report terminal/converged/crew-closed state while the
canonical validator FAILs for the CURRENT checkpoint.

Coverage map (checks A-I):
  §1  validator version ownership + STALE_VALIDATOR        -> A1..A3
  §2  structured receipt, verdict = f(exit_code) only      -> B1..B3
  §8  status classification (NOT_RUN..VERSION_MISMATCH)    -> C1..C7
  §4  terminal closure requires CURRENT_PASS               -> D1..D2
  §3  convergence E/H must consume real receipts           -> E2..E4
  §5  CLEAN exit conformance gate                          -> F1..F3
  §6  continue-entry health gate                          -> G1..G3
  §7  crew SC-13 final gate (unit: current_conformance)    -> H1..H2
  §9  real UTC timestamps (fabricated-future = failure)    -> I1, I5, I6

Run:  python tools/test_conformance_closure.py
"""

from __future__ import annotations

import datetime
import json
import subprocess
import sys
import tempfile
from pathlib import Path

# The test lives in tools/ next to the saipen_engine package and freshness.py.
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from saipen_engine import conformance as C  # noqa: E402

CONST = C.CONFORMANCE_PROTOCOL_VERSION  # "1"


# --------------------------------------------------------------------------- harness
def _utc_iso(dt: datetime.datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def scaffold() -> Path:
    """Fresh repo + minimal .saipen state so receipts/staleness are isolated."""
    root = Path(tempfile.mkdtemp(prefix="conformance_"))
    saipen = root / ".saipen"
    saipen.mkdir(parents=True, exist_ok=True)
    (saipen / "STATE.md").write_text(
        "phase: BOOT\nexecution_intent: explore\nsaipen_version: 7.0.0\nnext_action: saipen hunt\n",
        encoding="utf-8",
    )
    (saipen / "BOARD.md").write_text("# BOARD\n\n## TODO\n\n", encoding="utf-8")
    (saipen / "LOG.md").write_text("# LOG\n", encoding="utf-8")
    # CORE-002: a tracked file guarantees git commit succeeds so source
    # identity (source_head / source_tree_fingerprint) is non-empty, exactly
    # as a normal validator invocation would see it. Without a commit the
    # scaffold produced empty identity and the PASS-receipt guard rightly
    # refuses to mint evidence from missing proof.
    (root / "tracked.txt").write_text("conformance fixture\n", encoding="utf-8")
    try:
        subprocess.run(
            ["git", "init", "-q"],
            cwd=str(root),
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        subprocess.run(
            ["git", "add", "-A"],
            cwd=str(root),
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # Commit with inline identity so we don't depend on global git config.
        subprocess.run(
            [
                "git",
                "-c",
                "user.email=test@saipen.local",
                "-c",
                "user.name=saipen-test",
                "commit",
                "-q",
                "-m",
                "init",
            ],
            cwd=str(root),
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass
    return root


def source_identity_or_none(root: Path):
    """Mirror saipen_engine.conformance._source_identity EXACTLY.

    The module returns None on any failure; the harness must use the SAME value
    so a receipt stamped here is byte-for-byte what the classifier compares
    against. Diverging fallbacks would invent a spurious source-identity
    mismatch and turn every "current" receipt into STALE."""
    try:
        from freshness import compute_source_identity

        return compute_source_identity(Path(root))
    except Exception:
        return None


def source_pair(root: Path) -> tuple[str, str]:
    si = source_identity_or_none(root)
    if si is None:
        return "", ""
    return si.source_head or "", si.source_tree_fingerprint or ""


class Src:
    """Minimal source-identity stand-in for convergence stage checks."""

    def __init__(self, head: str, fp: str):
        self.source_head = head
        self.source_tree_fingerprint = fp


def _quick_hash(text) -> str:
    """Mirror C._quick_hash for content_hash computation."""
    import hashlib

    data = text.encode("utf-8") if isinstance(text, str) else text
    return hashlib.sha256(data).hexdigest()[:16]


def write_receipt(
    root: Path,
    gate: str,
    verdict: str,
    *,
    ts: str | None = None,
    source_head: str = "",
    source_tree_fingerprint: str = "",
    validator_version: str = CONST,
) -> None:
    """Write a raw receipt that mirrors generate_conformance_receipt's schema.

    Used to craft receipts the live generator would not (old timestamps,
    mismatched source identity, wrong validator version) so we can assert the
    classifier's behaviour without depending on real clock/git drift.
    """
    if ts is None:
        ts = _utc_iso(datetime.datetime.now(datetime.timezone.utc))
    exit_code = 0 if verdict == "PASS" else 1
    # CORE-002: default to REAL checkpoint hashes so a crafted "current" PASS
    # receipt carries complete binding; a caller that wants to test missing
    # evidence passes explicit empty/overridden hash fields.
    if not source_head or not source_tree_fingerprint:
        h, f = source_pair(root)
        source_head = source_head or h
        source_tree_fingerprint = source_tree_fingerprint or f
    state_hash = C._hash_file(root / ".saipen" / "STATE.md")
    board_hash = C._hash_file(root / ".saipen" / "BOARD.md")
    log_hash = C._log_hash(root)
    receipt = {
        "schema_version": 1,
        "kind": "conformance_receipt",
        "validator_protocol_version": validator_version,
        "gate": gate,
        "exit_code": exit_code,
        "verdict": verdict,
        "timestamp_utc": ts,
        "project_identity": "",
        "source_head": source_head,
        "source_tree_fingerprint": source_tree_fingerprint,
        "state_hash": state_hash,
        "board_hash": board_hash,
        "log_hash": log_hash,
        "content_hash": "",
    }
    # CORE-001: compute content_hash from the body so strict validation passes
    body_for_hash = {k: v for k, v in receipt.items() if k != "content_hash"}
    receipt["content_hash"] = _quick_hash(json.dumps(body_for_hash, indent=2, sort_keys=True))
    out_dir = root / C.RECEIPT_DIRNAME
    out_dir.mkdir(parents=True, exist_ok=True)
    fname = f"{ts.replace(':', '')}_{gate}_{verdict}.json"
    (out_dir / fname).write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def current_ts(offset_hours: float = 0.0) -> str:
    return _utc_iso(
        datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=offset_hours)
    )


# --------------------------------------------------------------------------- runner
_RESULTS: list[tuple[bool, str, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    _RESULTS.append((bool(cond), name, detail))
    mark = "PASS" if cond else "FAIL"
    print(f"  [{mark}] {name}" + (f" -- {detail}" if (detail and not cond) else ""))


# --------------------------------------------------------------------------- cases
def case_a_validator_ownership(root: Path) -> None:
    info = C.validator_version_info(root, gate="core")
    check(
        "A1 validator path is the canonical tools/validate.py",
        info.validator_path.endswith("validate.py") and Path(info.validator_path).exists(),
        info.validator_path,
    )
    check(
        "A2 stale_validator flags a mismatched version only",
        C.stale_validator(root, "9") is True
        and C.stale_validator(root, CONST) is False
        and C.stale_validator(root) is False,
    )
    check(
        "A3 info carries the canonical protocol version",
        info.validator_protocol_version == CONST,
        info.validator_protocol_version,
    )


def case_b_receipt_derivation(root: Path) -> None:
    rec = C.generate_conformance_receipt(root, gate="core", exit_code=0)
    check(
        "B1 exit_code 0 -> PASS receipt written",
        rec["verdict"] == "PASS" and list((root / C.RECEIPT_DIRNAME).glob("*_core_PASS.json")),
    )
    rec = C.generate_conformance_receipt(root, gate="core", exit_code=5)
    check("B2 exit_code != 0 -> FAIL receipt", rec["verdict"] == "FAIL" and rec["exit_code"] == 5)
    sample = C.latest_receipt(root, "core") or {}
    need = [
        "schema_version",
        "kind",
        "exit_code",
        "verdict",
        "timestamp_utc",
        "content_hash",
        "source_head",
        "source_tree_fingerprint",
    ]
    check(
        "B3 receipt carries the required structured fields",
        all(k in sample for k in need),
        str([k for k in need if k not in sample]),
    )


def case_c_status(root: Path) -> None:
    check(
        "C1 no receipt -> NOT_RUN", C.conformance_status(root, "core")["status"] == C.STATUS_NOT_RUN
    )
    r = scaffold()
    h, f = source_pair(r)
    write_receipt(r, "core", "PASS", ts=current_ts(), source_head=h, source_tree_fingerprint=f)
    check(
        "C2 current PASS -> CURRENT_PASS",
        C.conformance_status(r, "core")["status"] == C.STATUS_CURRENT_PASS,
    )
    r = scaffold()
    h, f = source_pair(r)
    write_receipt(r, "core", "FAIL", ts=current_ts(), source_head=h, source_tree_fingerprint=f)
    check(
        "C3 current FAIL -> CURRENT_FAIL",
        C.conformance_status(r, "core")["status"] == C.STATUS_CURRENT_FAIL,
    )
    r = scaffold()
    h, f = source_pair(r)
    write_receipt(r, "core", "PASS", ts=current_ts(-48), source_head=h, source_tree_fingerprint=f)
    check(
        "C4 48h-old PASS -> STALE_PASS",
        C.conformance_status(r, "core")["status"] == C.STATUS_STALE_PASS,
    )
    r = scaffold()
    h, f = source_pair(r)
    write_receipt(r, "core", "FAIL", ts=current_ts(-48), source_head=h, source_tree_fingerprint=f)
    check(
        "C5 48h-old FAIL -> STALE_FAIL",
        C.conformance_status(r, "core")["status"] == C.STATUS_STALE_FAIL,
    )
    r = scaffold()
    h, f = source_pair(r)
    write_receipt(
        r,
        "core",
        "PASS",
        ts=current_ts(),
        source_head=h,
        source_tree_fingerprint=f,
        validator_version="0",
    )
    check(
        "C6 wrong validator version -> VALIDATOR_VERSION_MISMATCH",
        C.conformance_status(r, "core")["status"] == C.STATUS_VERSION_MISMATCH,
    )
    r = scaffold()
    write_receipt(
        r,
        "core",
        "PASS",
        ts=current_ts(),
        source_head="OTHER_HEAD",
        source_tree_fingerprint="OTHER_FP",
    )
    check(
        "C7 PASS bound to a different source identity -> STALE_PASS",
        C.conformance_status(r, "core")["status"] == C.STATUS_STALE_PASS,
    )


def case_d_terminal_closure(root: Path) -> None:
    r = scaffold()
    check("D1 closure impossible on NOT_RUN", C.current_conformance_pass(r, "core") is False)
    r = scaffold()
    h, f = source_pair(r)
    write_receipt(r, "core", "PASS", ts=current_ts(-48), source_head=h, source_tree_fingerprint=f)
    check(
        "D2 only CURRENT_PASS permits closure (STALE_PASS -> False)",
        C.current_conformance_pass(r, "core") is False,
    )


def case_e_convergence(root: Path) -> None:
    r = scaffold()
    ok, _ = C.convergence_stage_satisfied(r, "E", Src("", ""))
    check("E2 stage E with no receipt -> UNSATISFIED", ok is False)
    r = scaffold()
    h, f = source_pair(r)
    write_receipt(r, "core", "PASS", ts=current_ts(), source_head=h, source_tree_fingerprint=f)
    ok, _ = C.convergence_stage_satisfied(r, "E", Src(h, f))
    check("E3 stage E with CURRENT_PASS bound to same identity -> SATISFIED", ok is True)
    r = scaffold()
    h, f = source_pair(r)
    write_receipt(r, "core", "PASS", ts=current_ts(), source_head=h, source_tree_fingerprint=f)
    ok, why = C.convergence_stage_satisfied(r, "H", Src("OTHER_HEAD", "OTHER_FP"))
    check(
        "E4 stage H PASS but source identity mismatch -> UNSATISFIED",
        ok is False and "does not match" in why,
        why,
    )


def case_f_clean_exit(root: Path) -> None:
    r = scaffold()
    ok, _ = C.clean_exit_allowed(r)
    check("F1 CLEAN exit forbidden on NOT_RUN", ok is False)
    r = scaffold()
    h, f = source_pair(r)
    write_receipt(r, "core", "PASS", ts=current_ts(), source_head=h, source_tree_fingerprint=f)
    ok, _ = C.clean_exit_allowed(r)
    check("F2 CLEAN exit allowed on CURRENT_PASS", ok is True)
    r = scaffold()
    h, f = source_pair(r)
    write_receipt(r, "core", "PASS", ts=current_ts(-48), source_head=h, source_tree_fingerprint=f)
    ok, _ = C.clean_exit_allowed(r)
    check("F3 CLEAN exit forbidden on STALE_PASS", ok is False)


def case_g_entry_health(root: Path) -> None:
    r = scaffold()
    probs = C.continue_entry_health(r)
    check("G1 healthy entry -> no problems", probs == [], str(probs))
    # G2: DONE phase with an unverified DONE ticket and no current conformance.
    r = scaffold()
    (r / ".saipen" / "STATE.md").write_text(
        "phase: DONE\nexecution_intent: explore\nsaipen_version: 7.0.0\n",
        encoding="utf-8",
    )
    board = {"tickets": {"T-1": {"id": "T-1", "section": "## DONE", "fields": {}}}, "errors": []}
    probs = C.continue_entry_health(r, state={"phase": "DONE"}, board=board)
    check(
        "G2 entry health flags the unverified DONE",
        any("DONE" in p and "verify" in p for p in probs),
        str(probs),
    )
    # G3: converge/crew intent without current crew conformance.
    r = scaffold()
    state = {"phase": "CONVERGE", "execution_intent": "converge", "converge_target": "crew"}
    probs = C.continue_entry_health(r, state=state, board={"tickets": {}, "errors": []})
    check(
        "G3 entry health flags converge/crew without crew conformance",
        any("crew" in p for p in probs),
        str(probs),
    )


def case_h_crew_gate(root: Path) -> None:
    r = scaffold()
    check(
        "H1 crew closure impossible when crew not run (NOT_RUN)",
        C.current_conformance_pass(r, "crew") is False,
    )
    r = scaffold()
    h, f = source_pair(r)
    write_receipt(r, "crew", "PASS", ts=current_ts(), source_head=h, source_tree_fingerprint=f)
    check(
        "H2 crew CURRENT_PASS satisfies the SC-13 final gate",
        C.conformance_status(r, "crew")["status"] == C.STATUS_CURRENT_PASS
        and C.current_conformance_pass(r, "crew") is True,
    )


def case_i_timestamps(root: Path) -> None:
    # I1: a fabricated-future receipt is rejected at read time as STALE_FAIL.
    r = scaffold()
    write_receipt(r, "core", "PASS", ts=current_ts(+10))
    st = C.conformance_status(r, "core")
    check(
        "I1 future-timestamped receipt -> STALE_FAIL (read-time §9)",
        st["status"] == C.STATUS_STALE_FAIL,
        st.get("reason", ""),
    )
    # I5: SC-13 satisfied on a current crew PASS (the §7 wire).
    r = scaffold()
    h, f = source_pair(r)
    write_receipt(r, "crew", "PASS", ts=current_ts(), source_head=h, source_tree_fingerprint=f)
    st = C.conformance_status(r, "crew")
    check("I5 current crew PASS -> SC-13 may finalize", st["status"] == C.STATUS_CURRENT_PASS)
    # I6: write-time guard refuses a fabricated-future stamp.
    future = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=10)
    raised = False
    try:
        C.generate_conformance_receipt(root, gate="core", exit_code=0, now=future)
    except ValueError:
        raised = True
    check("I6 write-time guard refuses a future-dated receipt", raised)


# --------------------------------------------------------------------------- main
def main() -> int:
    print("SAIPEN Conformance Closure -- regression matrix")
    # Each case gets its OWN fresh scaffold so receipts never leak between checks.
    case_a_validator_ownership(scaffold())
    case_b_receipt_derivation(scaffold())
    case_c_status(scaffold())
    case_d_terminal_closure(scaffold())
    case_e_convergence(scaffold())
    case_f_clean_exit(scaffold())
    case_g_entry_health(scaffold())
    case_h_crew_gate(scaffold())
    case_i_timestamps(scaffold())

    passed = sum(1 for ok, _, _ in _RESULTS if ok)
    total = len(_RESULTS)
    print(f"\n{passed}/{total} checks passed")
    failed = [name for ok, name, _ in _RESULTS if not ok]
    if failed:
        print("FAILED: " + ", ".join(failed))
        return 1
    print("ALL GREEN -- terminal/converged/crew-closed + current validator FAIL is impossible.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
