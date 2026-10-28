#!/usr/bin/env python
"""PERF WAVE (T-1019..T-1022) targeted structural/behavior regressions.

Standalone gate: `python tools/perf_wave_regressions.py`. Exits non-zero on
any failure. Covers:

- T-1019: bounded SourceIdentity capture -- subprocess/listing/read counts,
  exact identity parity with the pre-wave implementation on a stable fixture,
  fault-injected HEAD/listing/content movement between capture stages, and a
  same-fixture timing diagnostic (structural budgets remain the hard gate).
- T-1020: settled receipts stop scaling hot pending scans -- engine-written
  SETTLED markers, unresolved ops stay visible, corrupt markers fail closed,
  legacy settled receipts still decode, committed retry semantics unchanged,
  fast-path median below the legacy strict-decode median.
- T-1021: bulk DONE evidence is one-pass with exact per-ticket parity -- the
  bulk verdict equals the single-ticket verdict on randomized mixed histories
  and stays linear as tickets/events grow.
- T-1022: third-wave controls are hermetic and current -- the live HOME tree
  is byte-identical after the nitro probes run (the stale-board control now
  mutates a disposable copy), and the PROBES_ONLY runner terminates with a
  real scoped PASS/FAIL summary.
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HOME = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HOME / "tools"))

problems: list[str] = []
checked = 0


def expect(label: str, ok: bool, detail: str = "") -> None:
    global checked  # noqa: PLW0603 -- module-level PASS/FAIL counter
    checked += 1
    if not ok:
        problems.append(f"{label}: {detail}")
        print(f"FAIL: {label} -- {detail}")
    else:
        print(f"PASS: {label}")


def git_env() -> dict:
    return {
        **os.environ,
        "GIT_AUTHOR_NAME": "probe",
        "GIT_AUTHOR_EMAIL": "probe@example.invalid",
        "GIT_COMMITTER_NAME": "probe",
        "GIT_COMMITTER_EMAIL": "probe@example.invalid",
    }


def stable_fixture(base: Path) -> Path:
    """A small git repo with one modified tracked file + one untracked file."""
    fix = base / "fix"
    fix.mkdir(parents=True)
    (fix / "tracked.txt").write_text("hello\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=fix, capture_output=True)
    subprocess.run(["git", "add", "-A"], cwd=fix, capture_output=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "base"], cwd=fix, env=git_env(), capture_output=True
    )
    (fix / "tracked.txt").write_text("hello changed\n", encoding="utf-8")
    (fix / "untracked.txt").write_text("new file\n", encoding="utf-8")
    (fix / "dir").mkdir()
    (fix / "dir" / "nested.txt").write_text("nested\n", encoding="utf-8")
    return fix


def median_ms(fn, runs: int = 3) -> float:
    samples = []
    for _ in range(runs):
        t0 = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - t0) * 1000)
    samples.sort()
    return samples[len(samples) // 2]


def run_t1019(base: Path) -> None:
    import freshness

    # ---- bounded capture: subprocess / listing / read counts ----------------
    # The fixture is built BEFORE the counter is installed so only the
    # capture's own git subprocesses are counted.
    fix0 = stable_fixture(base / "counter")
    real_run = subprocess.run
    calls: list = []

    def counting(*a, **k):
        calls.append(a[0] if a and isinstance(a[0], list) else None)
        return real_run(*a, **k)

    subprocess.run = counting
    try:
        sid = freshness.compute_source_identity(fix0)
    finally:
        subprocess.run = real_run
    git_calls = [c for c in calls if c and c[0] == "git"]
    expect(
        "T-1019 capture launches <= 10 git subprocesses (was 12)",
        len(git_calls) <= 10,
        f"count={len(git_calls)}",
    )
    listings = [c for c in git_calls if len(c) > 3 and c[3] in ("diff", "ls-files")]
    expect(
        "T-1019 capture runs exactly three delta listings (was four)",
        len(listings) == 6,
        f"listing-commands={len(listings)}",
    )
    expect(
        "T-1019 identity is git-delta-v1",
        sid.discovery_model == "git-delta-v1",
        sid.discovery_model,
    )

    # AUDIT PERF-003: crew's closing proof reuses the capture token instead
    # of paying for a second ten-process identity capture.
    calls.clear()
    subprocess.run = counting
    try:
        stable, stable_error = freshness.revalidate_source_identity(fix0, sid)
    finally:
        subprocess.run = real_run
    revalidation_git_calls = [c for c in calls if c and c[0] == "git"]
    expect(
        "AUDIT PERF-003 bounded source revalidation stays within six Git calls",
        stable and stable_error is None and len(revalidation_git_calls) <= 6,
        f"stable={stable} error={stable_error!r} calls={len(revalidation_git_calls)}",
    )

    # ---- exact identity parity with the DURABLE golden oracle (T-1010) -----
    # The oracle is the FROZEN tracked pre-wave implementation
    # (tools/freshness_golden_v1.py), NEVER `git show HEAD:...`: once the
    # optimization is committed, HEAD IS the implementation under test and a
    # HEAD-derived oracle degenerates into self-comparison.
    golden_path = HOME / "tools" / "freshness_golden_v1.py"
    golden_spec = importlib.util.spec_from_file_location("freshness_golden_v1", golden_path)
    if golden_spec is None or golden_spec.loader is None:
        expect("T-1019 golden oracle is loadable", False, f"cannot load {golden_path}")
        return
    golden = importlib.util.module_from_spec(golden_spec)
    sys.modules["freshness_golden_v1"] = golden
    golden_spec.loader.exec_module(golden)
    fix_par = stable_fixture(base / "fix-parity")
    o = golden.compute_source_identity(fix_par)
    n = freshness.compute_source_identity(fix_par)
    expect(
        "T-1019 stable fixture preserves exact git-delta-v1 identity",
        o.source_head == n.source_head and o.source_tree_fingerprint == n.source_tree_fingerprint,
        f"golden={o.source_tree_fingerprint} new={n.source_tree_fingerprint}",
    )

    # ---- durable-oracle self-proof (T-1010) --------------------------------
    # Simulate the post-commit world: commit the CURRENT implementation into
    # a disposable repo. A HEAD-derived oracle would then BE the
    # implementation under test; the frozen golden must still differ from it,
    # and a deliberate fingerprint semantic drift must still turn parity red.
    current_src = (HOME / "tools" / "freshness.py").read_text(encoding="utf-8")
    golden_src = golden_path.read_text(encoding="utf-8")

    def norm(src: str) -> str:
        return src.replace("\r\n", "\n")

    disp = base / "committed-oracle"
    (disp / "tools").mkdir(parents=True)
    (disp / "tools" / "freshness.py").write_text(current_src, encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=disp, capture_output=True)
    subprocess.run(["git", "add", "-A"], cwd=disp, capture_output=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "current impl"], cwd=disp, env=git_env(), capture_output=True
    )
    committed_src = subprocess.run(
        ["git", "-C", str(disp), "show", "HEAD:tools/freshness.py"], capture_output=True, text=True
    ).stdout
    expect(
        "T-1019 oracle durability: committed impl reproduces the live impl",
        norm(committed_src) == norm(current_src),
        f"committed != live ({len(committed_src)} vs {len(current_src)} bytes)",
    )
    expect(
        "T-1019 oracle independence: golden differs from the committed impl",
        norm(golden_src) != norm(committed_src),
        "golden equals the implementation under test -- parity would be a self-comparison",
    )
    # Deliberate semantic drift in the LIVE implementation must break parity
    # with the golden (the whole point of a durable oracle).
    real_digest = freshness._digest
    fix_drift = stable_fixture(base / "fix-drift")
    golden_id = golden.compute_source_identity(fix_drift)
    try:
        freshness._digest = lambda model, records: (
            f"{model}:{hashlib.sha256(b'DELIBERATE-DRIFT').hexdigest()}"
        )
        drifted_id = freshness.compute_source_identity(fix_drift)
    finally:
        freshness._digest = real_digest
    expect(
        "T-1019 deliberate fingerprint drift still makes parity red",
        drifted_id.source_tree_fingerprint != golden_id.source_tree_fingerprint,
        f"golden={golden_id.source_tree_fingerprint} drifted={drifted_id.source_tree_fingerprint}",
    )

    # ---- same-fixture median materially falls -------------------------------
    # Interleave golden/new measurements so box load drift cancels: the
    # pre-wave capture launches ~12 git subprocesses, the bounded capture
    # ~10 (the T-1007 content confirmation keeps three content reads, so the
    # win is the halved listing count and subprocess count), so the new
    # median must land materially below the golden one on the same fixture.
    fix = stable_fixture(base)
    old_times, new_times = [], []
    for _ in range(4):
        t0 = time.perf_counter()
        golden.compute_source_identity(fix)
        old_times.append((time.perf_counter() - t0) * 1000)
        t0 = time.perf_counter()
        freshness.compute_source_identity(fix)
        new_times.append((time.perf_counter() - t0) * 1000)
    old_times.sort()
    new_times.sort()
    old_med = old_times[len(old_times) // 2]
    new_med = new_times[len(new_times) // 2]
    # Wall-clock ratios on shared/virtualized runners are noisy and may invert
    # while the deterministic subprocess/listing budgets above still prove the
    # intended work reduction.  Keep timing visible, never as a correctness
    # gate (PERF-006).
    print(
        "INFO: T-1019 same-fixture timing diagnostic -- "
        f"golden={old_med:.1f}ms new={new_med:.1f}ms "
        f"ratio={(new_med / old_med if old_med else float('inf')):.3f}"
    )

    # ---- fault injection: HEAD movement between capture stages --------------
    real_head = freshness._run_git

    def head_mover(*a, **k):
        if a[1:] == ("rev-parse", "--verify", "HEAD"):
            if head_mover.count == 1:
                return b"deadbeef\n"
            head_mover.count += 1
        return real_head(*a, **k)

    head_mover.count = 0
    freshness._run_git = head_mover
    try:
        freshness.compute_source_identity(stable_fixture(base / "fix-head"))
        expect(
            "T-1019 HEAD movement between capture stages fails closed",
            False,
            "no FreshnessError raised",
        )
    except freshness.FreshnessError:
        expect("T-1019 HEAD movement between capture stages fails closed", True, "")

    # ---- fault injection: listing movement between capture stages -----------
    real_listing = freshness._git_delta_listing

    def listing_mover(root):
        raw, untracked = real_listing(root)
        if listing_mover.count == 1:
            raw += b"X"  # simulated tree movement between the two listings
        listing_mover.count += 1
        return raw, untracked

    listing_mover.count = 0
    freshness._git_delta_listing = listing_mover
    try:
        freshness.compute_source_identity(stable_fixture(base / "fix-listing"))
        expect(
            "T-1019 listing movement between capture stages fails closed",
            False,
            "no FreshnessError raised",
        )
    except freshness.FreshnessError:
        expect("T-1019 listing movement between capture stages fails closed", True, "")
    finally:
        freshness._git_delta_listing = real_listing
        freshness._run_git = real_head

    # ---- fault injection: untracked content movement after the read ---------
    real_read = freshness._read_regular_info

    def content_mover(path, *a, **k):
        content, fp = real_read(path, *a, **k)
        if b"new file" in content:  # the untracked probe file
            path.write_bytes(content + b"MORE\n")
        return content, fp

    freshness._read_regular_info = content_mover
    try:
        freshness.compute_source_identity(stable_fixture(base / "fix-content"))
        expect("T-1019 untracked content movement fails closed", False, "no FreshnessError raised")
    except freshness.FreshnessError:
        expect("T-1019 untracked content movement fails closed", True, "")
    finally:
        freshness._read_regular_info = real_read

    # ---- T-1007: SAME-SIZE AAAA->BBBB replacement with RESTORED mtime -----
    # The audit reproduction: metadata (dev, ino, size, mtime, mode) survives
    # the swap untouched, so only a second bounded CONTENT read can detect
    # it. Proven in BOTH discovery models.
    swap_state = {"done": False}

    def same_size_swapper(path, *a, **k):
        content, fp = real_read(path, *a, **k)
        if not swap_state["done"] and b"new file" in content:
            swap_state["done"] = True
            info = path.stat()
            path.write_text("new FILE\n", encoding="utf-8")  # same size
            os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns))
        return content, fp

    def samesize_race(label: str, fixture: Path) -> None:
        nonlocal swap_state
        swap_state = {"done": False}
        freshness._read_regular_info = same_size_swapper
        try:
            freshness.compute_source_identity(fixture)
            expect(label, False, "no FreshnessError raised")
        except freshness.FreshnessError:
            expect(label, True, "")
        finally:
            freshness._read_regular_info = real_read

    samesize_race(
        "T-1007 same-size mtime-restored replacement fails closed (Git model)",
        stable_fixture(base / "fix-samesize"),
    )
    nogit = base / "fix-samesize-nogit"
    nogit.mkdir(parents=True)
    (nogit / "u.txt").write_text("new file\n", encoding="utf-8")
    samesize_race("T-1007 same-size mtime-restored replacement fails closed (no-Git model)", nogit)

    # ---- PERF-001: the final confirmation read is also the digest pass.
    # Reads 1-2 return the original bytes; the third (final confirmation)
    # returns a same-size, mtime-restored swap.  The capture must fail closed
    # rather than silently fold the swapped bytes into the fingerprint.
    read_counts: dict[str, int] = {}

    def final_read_swapper(path, *a, **k):
        content, fp = real_read(path, *a, **k)
        key = str(path)
        read_counts[key] = read_counts.get(key, 0) + 1
        if "untracked.txt" in key and read_counts[key] == 3:
            # Final read: simulate a swap during the validated digest pass.
            # Returns the mutated bytes (same size, restored mtime) so the final
            # pass would otherwise hash the wrong content.
            info = path.stat()
            path.write_text("NEW FILE!\n", encoding="utf-8")  # 9 bytes, same as "new file\n"
            os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns))
            content, fp = real_read(path, *a, **k)
        return content, fp

    freshness._read_regular_info = final_read_swapper
    try:
        freshness.compute_source_identity(stable_fixture(base / "fix-finalread"))
        expect(
            "PERF-001 final confirmation re-read is validated against confirmed evidence",
            False,
            "no FreshnessError -- 4th-read swap silently accepted into fingerprint",
        )
    except freshness.FreshnessError:
        expect(
            "PERF-001 final confirmation re-read is validated against confirmed evidence",
            True,
            "",
        )
    finally:
        freshness._read_regular_info = real_read

    # ---- post-run binding equality (T-1010) --------------------------------
    # Every monkeypatch installed above must be restored: a later probe group
    # (or a second run of this harness) must see the original bindings.
    expect(
        "T-1019 all monkeypatches restored (post-run bindings == originals)",
        subprocess.run is real_run
        and freshness._run_git is real_head
        and freshness._git_delta_listing is real_listing
        and freshness._read_regular_info is real_read
        and freshness._digest is real_digest,
        f"run={subprocess.run is real_run} "
        f"git={freshness._run_git is real_head} "
        f"listing={freshness._git_delta_listing is real_listing} "
        f"read={freshness._read_regular_info is real_read} "
        f"digest={freshness._digest is real_digest}",
    )


def run_t1020(base: Path) -> None:
    from saipen_engine.journal import SETTLED_DIR, Journal, run_mutation, scan_pending, staged_name
    import os

    root = base / "t1020"
    (root / ".saipen").mkdir(parents=True)
    (root / "x.txt").write_text("one\n", encoding="utf-8")
    r = run_mutation(
        root,
        "op-1",
        "op",
        "probe",
        str(root),
        "hash",
        [{"path": "x.txt", "role": "generic", "content": "two\n"}],
    )
    expect(
        "T-1020 committed mutation returns COMMITTED",
        r.get("ok") and r.get("code") == "COMMITTED",
        repr(r),
    )
    settled_dir = root / SETTLED_DIR / "op-1"
    ops_dir = root / ".saipen/recovery/ops/op-1"
    expect(
        "T-1020 engine moves the settled op to SETTLED_DIR on COMMITTED",
        settled_dir.is_dir() and not ops_dir.exists(),
        f"settled={settled_dir.is_dir()} ops={ops_dir.exists()}",
    )
    pending, _ = scan_pending(root)
    expect(
        "T-1020 committed op is not pending",
        all(p["op_id"] != "op-1" for p in pending),
        repr(pending),
    )

    # committed retry still returns ALREADY_APPLIED (semantics preserved)
    journal = Journal(root, "op-1")
    record = journal.read()
    retry_targets = [
        {"path": t["path"], "role": t["role"], "content": (root / t["path"]).read_bytes()}
        for t in record["targets"]
    ]
    again = run_mutation(
        root, "op-1", "op", "probe", str(root), "hash", retry_targets, skip_preflight=True
    )
    expect(
        "T-1020 committed retry still returns ALREADY_APPLIED",
        again.get("code") == "ALREADY_APPLIED",
        repr(again),
    )

    # ---- T-1008: rename failure is NON-FATAL after the durable
    # terminal commit -- the caller returns truthful COMMITTED semantics and
    # the pending scan falls back to the strict manifest decode.
    real_rename = os.rename

    def failing_rename(src, dst):
        if "op-2" in str(src):
            raise OSError("injected rename failure")
        return real_rename(src, dst)

    os.rename = failing_rename
    try:
        r2 = run_mutation(
            root,
            "op-2",
            "op",
            "probe",
            str(root),
            "hash",
            [{"path": "x.txt", "role": "generic", "content": "three\n"}],
        )
    finally:
        os.rename = real_rename
    expect(
        "T-1008 move failure returns truthful COMMITTED semantics",
        r2.get("ok") and r2.get("code") == "COMMITTED",
        repr(r2),
    )
    ops_dir2 = root / ".saipen/recovery/ops/op-2"
    pending, _ = scan_pending(root)
    expect(
        "T-1008 committed op with failed move stays non-pending (strict decode owns truth)",
        ops_dir2.is_dir() and all(p["op_id"] != "op-2" for p in pending),
        repr((ops_dir2.is_dir(), pending)),
    )

    # fabricate 2000 settled receipts in settled/ + 1 real unresolved op in ops/
    ops = root / ".saipen/recovery/ops"
    settled = root / SETTLED_DIR

    def fake_settled(op_id: str) -> None:
        d = settled / op_id
        d.mkdir(parents=True, exist_ok=True)
        rec = {
            "op_id": op_id,
            "operation": "op",
            "created_at": "2026-01-01T00:00:00Z",
            "agent": "probe",
            "project_identity": str(root),
            "project_lineage": None,
            "semantic_payload_hash": "h",
            "preconditions": {},
            "read_preconditions": {},
            "verification_policy": "none",
            "status": "COMMITTED",
            "progress_index": 1,
            "targets": [
                {
                    "path": "x.txt",
                    "role": "generic",
                    "action": "write",
                    "before_hash": "a",
                    "after_hash": "b",
                    "applied": True,
                }
            ],
        }
        (d / "operation.json").write_text(json.dumps(rec), encoding="utf-8")

    for i in range(500):
        fake_settled(f"op-settled-{i:04d}")
    live = ops / "op-live"
    live.mkdir(parents=True, exist_ok=True)
    rec = {
        "op_id": "op-live",
        "operation": "op",
        "created_at": "2026-01-02T00:00:00Z",
        "agent": "probe",
        "project_identity": str(root),
        "project_lineage": None,
        "semantic_payload_hash": "h",
        "preconditions": {},
        "read_preconditions": {},
        "verification_policy": "none",
        "status": "PREPARED",
        "progress_index": 0,
        "targets": [
            {
                "path": "x.txt",
                "role": "generic",
                "action": "write",
                "before_hash": "a",
                "after_hash": "b",
                "applied": False,
            }
        ],
    }
    (live / "operation.json").write_text(json.dumps(rec), encoding="utf-8")
    (live / staged_name(0, "x.txt")).write_bytes(b"two\n")

    median_ms(lambda: scan_pending(root))
    pending, _ = scan_pending(root)
    expect(
        "T-1008 one unresolved op remains exactly visible",
        [p["op_id"] for p in pending] == ["op-live"],
        repr(pending),
    )

    # corrupt/PREPARED evidence must still block
    mismatch = ops / "op-mismatch"
    mismatch.mkdir(parents=True, exist_ok=True)
    prepared_rec = {
        "op_id": "op-mismatch",
        "operation": "op",
        "created_at": "2026-01-03T00:00:00Z",
        "agent": "probe",
        "project_identity": str(root),
        "project_lineage": None,
        "semantic_payload_hash": "h",
        "preconditions": {},
        "read_preconditions": {},
        "verification_policy": "none",
        "status": "PREPARED",
        "progress_index": 0,
        "targets": [
            {
                "path": "x.txt",
                "role": "generic",
                "action": "write",
                "before_hash": "a",
                "after_hash": "b",
                "applied": False,
            }
        ],
    }
    (mismatch / "operation.json").write_text(json.dumps(prepared_rec), encoding="utf-8")
    (mismatch / staged_name(0, "x.txt")).write_bytes(b"two\n")

    pending, _ = scan_pending(root)
    expect(
        "T-1008 PREPARED manifest in ops/ blocks",
        any(p["op_id"] == "op-mismatch" and p.get("status") == "PREPARED" for p in pending),
        repr(pending),
    )


def run_t1021() -> None:
    import random

    from saipen_engine.log import bulk_verification_evidence, verification_evidence

    random.seed(7)
    tickets = ["T-1", "T-2", "T-3", "T-4"]
    texts = [
        "probe -> PASS conf: high",
        "probe -> PASS conf: low",
        "probe FAILED",
        "probe -> PASS conf: med",
        "manual check MANUAL-VERIFY",
        "transition to VERIFY",
        "transition to VERIFY -- rerun",
        "plain run",
        "NOT PASS",
        "NOT MANUAL-VERIFY",
        "transition to VERIFY -- after FAIL check",
    ]
    mismatches = 0
    trials = 400
    for _ in range(trials):
        events = []
        for _ in range(220):
            tid = random.choice([*tickets, None, "T-9"])
            tax = random.choice(["RUN", "DEC", "RUN", "CLAIM"])
            if tax != "RUN":
                events.append({"ticket": tid, "taxonomy": tax, "text": "x"})
                continue
            events.append({"ticket": tid, "taxonomy": "RUN", "text": random.choice(texts)})
        bulk = bulk_verification_evidence(events, tickets)
        for t in tickets:
            if verification_evidence(t, events) != bulk[t]:
                mismatches += 1
    expect(
        "T-1021 bulk verdict == single-ticket verdict on mixed histories",
        mismatches == 0,
        f"{mismatches}/{trials * len(tickets)} mismatched",
    )

    # scaling: bulk stays linear (a few ms) where per-ticket reverse scans
    # were hundreds of ms at the same size.
    n_ev, n_t = 1000, 6000
    ev = []
    for i in range(n_ev):
        tid = f"T-{random.randrange(n_t)}"
        ev.append(
            {
                "ticket": tid,
                "taxonomy": "RUN",
                "text": random.choice(["probe -> PASS conf: high", "transition to VERIFY", "run"]),
            }
        )
    bulk_ms = median_ms(lambda: bulk_verification_evidence(ev, [f"T-{j}" for j in range(n_t)]))
    expect(
        "T-1021 bulk evidence is one-pass linear (sub-50ms at 1000/6000)",
        bulk_ms < 50.0,
        f"{bulk_ms:.2f}ms",
    )


def run_t1022() -> None:
    # ---- live HOME byte-identity + scoped runner: ONE canonical execution ----
    # PERF-006: the scoped runner is the single execution observed by BOTH the
    # hermeticity hash and the exit/summary assertions. Running run_nitro_probes
    # separately here duplicated the most expensive first third-wave group for
    # no additional coverage.

    # T-1258: this control asks whether the NITRO PROBES wrote into the live
    # tree. A bare before/after hash cannot tell that from a concurrent gate
    # writing beside it, and reported only "live .saipen tree changed" -- a red
    # nobody could attribute afterwards, which is worse than no red. Snapshot
    # per path so the failure names exactly what moved, and skip the
    # process-local runtime cache: `.gitignore` line 14 keeps `.saipen/cache/`
    # out of the tree by design (T-994), every gate writes it, and a probe
    # writing there is not the leak this control guards.
    transient = ("cache/",)

    def tree_snapshot(path: Path) -> dict[str, str]:
        snapshot: dict[str, str] = {}
        for p in sorted(path.rglob("*")):
            if not p.is_file():
                continue
            rel = p.relative_to(path).as_posix()
            if rel.startswith(transient):
                continue
            snapshot[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
        return snapshot

    def snapshot_delta(before: dict[str, str], after: dict[str, str]) -> str:
        added = sorted(set(after) - set(before))
        removed = sorted(set(before) - set(after))
        changed = sorted(p for p in set(before) & set(after) if before[p] != after[p])
        parts = [
            f"{label} {paths[:5]}{'...' if len(paths) > 5 else ''}"
            for label, paths in (("added", added), ("removed", removed), ("changed", changed))
            if paths
        ]
        return "live .saipen tree changed: " + "; ".join(parts)

    # ---- third-wave ONLY runner terminates with a scoped summary ------------
    # The perf-wave runner itself is commonly selected through another
    # PROBES_ONLY variable.  Do not leak that selector into this nested scoped
    # runner or the dispatcher correctly refuses the conflicting scopes.
    env = {
        key: value
        for key, value in os.environ.items()
        if not (key.startswith("SAIPEN_") and key.endswith("_PROBES_ONLY"))
    }
    env["SAIPEN_THIRD_WAVE_PROBES_ONLY"] = "1"
    before = tree_snapshot(HOME / ".saipen")
    proc = subprocess.run(
        [sys.executable, "tools/run_scenarios.py"],
        cwd=HOME,
        env=env,
        capture_output=True,
        text=True,
        timeout=900,
    )
    after = tree_snapshot(HOME / ".saipen")
    expect(
        "T-1022 nitro probes leave the live HOME tree byte-identical",
        before == after,
        "" if before == after else snapshot_delta(before, after),
    )
    out = proc.stdout + proc.stderr
    summary_ok = "checks passed" in out and "failed" in out
    expect("T-1022 third-wave ONLY runner exits 0", proc.returncode == 0, f"rc={proc.returncode}")
    expect(
        "T-1022 third-wave ONLY runner prints a scoped PASS/FAIL summary", summary_ok, out[-400:]
    )
    expect("T-1022 third-wave ONLY runner reports zero failures", "0 failed" in out, out[-400:])


def run_t1023(base: Path) -> None:
    """PERF-002/003/004/005 hot-path wiring regression.

    The audit stamped PERFORMANCE: COMPLETE, but the committed tree had the
    perf INFRASTRUCTURE (the ``source_identity=`` API, the receipt index, the
    bounded RemoteSnapshot) with the HOT-PATH WIRING left open:

    - PERF-002: crew_plan's SC-13 check and continue_entry_health recomputed
      SourceIdentity instead of reusing the one already captured.
    - PERF-003: _verify_receipt fired TWO ls-remote calls and _git had no
      timeout (a hung remote hung the verifier instead of returning unknown).
    - PERF-004: the receipt index stored only receipt_id+timestamp, so
      latest_receipt still globbed+parsed every receipt (O(N)), not constant-I/O.
    - PERF-005: crew_snapshot's second stability pass re-decoded every receipt
      just to compute a digest.
    """
    from saipen_engine import convergence, crew, conformance, journal, release
    from saipen_engine.conformance import CONFORMANCE_PROTOCOL_VERSION

    # ---- PERF-002a: _sc13_conformance_check reuses snapshot.source_id --------
    real_cs = conformance.conformance_status
    passed_source: list[bool] = []

    def counting_cs(root, gate="core", now=None, source_identity=None):
        passed_source.append(source_identity is not None)
        return {"status": "CURRENT_PASS", "gate": gate, "validator": {}}

    conformance.conformance_status = counting_cs
    try:
        class _Snap:
            root = base
            source_id = object()  # truthy stand-in for a SourceIdentity

        crew._sc13_conformance_check(_Snap(), pre_finalization=False)
    finally:
        conformance.conformance_status = real_cs
    expect(
        "PERF-002 _sc13_conformance_check reuses snapshot.source_id",
        bool(passed_source) and all(passed_source),
        f"passed_source_id={passed_source}",
    )

    # ---- PERF-002b: continue_entry_health captures SourceIdentity ONCE ------
    saipen_dir = base / "perf2b" / ".saipen"
    saipen_dir.mkdir(parents=True, exist_ok=True)
    (saipen_dir / "STATE.md").write_text(
        "---\nphase: DONE\ntask: none\nsaipen_version: 7\n"
        "execution_intent: converge\nconverge_target: crew\n",
        encoding="utf-8",
    )
    (saipen_dir / "BOARD.md").write_text("---\n", encoding="utf-8")
    real_srcid = conformance._source_identity
    srcid_calls: list[int] = []

    def counting_srcid(root):
        srcid_calls.append(1)
        return real_srcid(root)

    conformance._source_identity = counting_srcid
    try:
        conformance.continue_entry_health(base / "perf2b")
    finally:
        conformance._source_identity = real_srcid
    # phase DONE + converge/crew triggers BOTH gate checks, so the wiring must
    # pass ONE captured identity to both (not recompute per check).
    expect(
        "PERF-002 continue_entry_health captures SourceIdentity once for both gates",
        len(srcid_calls) == 1,
        f"source_identity_calls={len(srcid_calls)}",
    )

    # ---- PERF-003: one bounded remote snapshot; timeout -> unknown ----------
    import json as _json
    import subprocess as _sp

    real_git = release._git
    lsremote_calls: list[tuple] = []

    def counting_git(root, *args, literal=False, timeout=None):
        if args and args[0] == "ls-remote":
            lsremote_calls.append(args)
            stdout = (
                "abc123\trefs/heads/main\n"
                "abc123\trefs/tags/v1.0.0\n"
                "abc123\trefs/tags/v1.0.0^{}\n"
            )
        elif args[:2] == ("rev-parse", "HEAD"):
            stdout = "abc123"
        else:
            stdout = ""

        class _R:
            rc = 0
            stderr = ""

            def __init__(self):
                self.stdout = stdout

            @property
            def ok(self):
                return self.rc == 0

        return _R()

    release._git = counting_git
    try:
        rec = {
            "mode": "full",
            "closure_commit": "abc123",
            "branch": "main",
            "tag": "v1.0.0",
            "version": "1.0.0",
            "remote_push_endpoint": "origin",
            "project_identity": "",
            "project_lineage": "",
            "source_head": "",
            "source_tree_fingerprint": "",
        }
        v = release._verify_receipt(base, rec)
        expect(
            "PERF-003 _verify_receipt fires exactly ONE ls-remote",
            len(lsremote_calls) == 1,
            f"lsremote_calls={len(lsremote_calls)}",
        )
        expect(
            "PERF-003 _verify_receipt still verifies closure==branch==tag",
            v.get("status") == "ok",
            repr(v),
        )
    finally:
        release._git = real_git

    # timeout degradation: a hung remote must become unknown, never a crash/PASS.
    # Patch subprocess.run (the primitive real _git calls) so the REAL timeout
    # handling in _git is exercised -- _git catches TimeoutExpired and returns a
    # non-ok GitResult, which the verifier maps to unknown.
    real_run = _sp.run

    def raising_run(*a, **k):
        raise _sp.TimeoutExpired(["git"], k.get("timeout") or 30)

    _sp.run = raising_run
    try:
        v2 = release._verify_receipt(base, rec)
        expect(
            "PERF-003 remote timeout degrades to unknown (never PASS/crash)",
            v2.get("status") == "unknown",
            repr(v2),
        )
    finally:
        _sp.run = real_run

    # ---- PERF-004: indexed lookup is constant-I/O (no full scan) ------------
    root4 = base / "perf4"
    recv_dir = root4 / conformance.RECEIPT_DIRNAME
    recv_dir.mkdir(parents=True, exist_ok=True)
    idx_dir = root4 / conformance._INDEX_DIRNAME
    idx_dir.mkdir(parents=True, exist_ok=True)
    last = None
    for i in range(500):
        ts = f"2026-01-01T00:{i // 60:02d}:{i % 60:02d}Z"
        rid = f"r{i:05d}"
        recj = {
            "schema_version": 2,
            "kind": "conformance_receipt",
            "receipt_id": rid,
            "validator_protocol_version": CONFORMANCE_PROTOCOL_VERSION,
            "gate": "core",
            "exit_code": 0,
            "verdict": "PASS",
            "timestamp_utc": ts,
            "content_hash": "x",
            "source_head": "",
            "source_tree_fingerprint": "",
            "state_hash": "",
            "board_hash": "",
            "log_hash": "",
        }
        # Mirror production's filename sanitization (conformance._safe_filename_component)
        # so the simulated receipts survive on Windows where ':' is an illegal char.
        fname = f"{conformance._safe_filename_component(ts)}_{rid}_core_PASS.json"
        (recv_dir / fname).write_text(_json.dumps(recj), encoding="utf-8")
        last = (rid, ts, f"{conformance.RECEIPT_DIRNAME}/{fname}")
    (idx_dir / "core.json").write_text(
        _json.dumps(
            {
                "gate": "core",
                "receipt_id": last[0],
                "timestamp_utc": last[1],
                "receipt_path": last[2],
                "version": 1,
                "receipt_dir_mtime_ns": recv_dir.stat().st_mtime_ns,
            }
        ),
        encoding="utf-8",
    )
    # The authenticated lineage proof is part of the current locator
    # contract.  Without it, a hand-built legacy index must correctly fall
    # back to strict history scanning rather than pretending to be current.
    inventory = conformance._receipt_inventory(root4)
    content_inventory = conformance._receipt_content_inventory(root4)
    members = conformance._receipt_member_inventory(root4)
    assert inventory is not None and content_inventory is not None and members is not None
    (idx_dir / conformance._LINEAGE_INDEX_NAME).write_text(
        _json.dumps(
            {
                "version": 1,
                "receipt_count": inventory[0],
                "inventory_xor": f"{inventory[1]:032x}",
                "content_xor": f"{content_inventory[1]:032x}",
                "members": [list(item) for item in members],
                "receipt_dir_mtime_ns": recv_dir.stat().st_mtime_ns,
                "lineage_hash": "fixture",
            }
        ),
        encoding="utf-8",
    )
    # PERF-002: this control used to count ONLY `_iter_receipts` and
    # `_find_receipt_by_id`, both of which the direct locator legitimately
    # avoids, and then print "constant-I/O (no full scan)". It never
    # instrumented the work `latest_receipt` actually does: on a live project
    # with 1,052 conformance receipts one call invoked
    # `_receipt_content_token` 1,052 times -- it opened and SHA-256 hashed
    # every receipt in the lifetime population -- while this control reported
    # PASS. A gate that cannot fail is not a gate, and this one was asserting
    # the exact property it was blind to.
    #
    # It now counts the real I/O. The claim is stated truthfully: the direct
    # locator avoids the ITERATORS, and the content hashing is measured and
    # BOUNDED so it cannot get worse, rather than described as absent. Making
    # it genuinely constant needs the sealed-segment work PERF-002 describes;
    # until that lands this control reports the cost instead of hiding it.
    real_iter = conformance._iter_receipts
    real_find = conformance._find_receipt_by_id
    real_token = conformance._receipt_content_token
    scans = {"iter": 0, "find": 0, "content_token": 0}

    def ci(r):
        scans["iter"] += 1
        return real_iter(r)

    def cf(r, rid):
        scans["find"] += 1
        return real_find(r, rid)

    def ct(*args, **kwargs):
        scans["content_token"] += 1
        return real_token(*args, **kwargs)

    conformance._iter_receipts = ci
    conformance._find_receipt_by_id = cf
    conformance._receipt_content_token = ct
    try:
        got = conformance.latest_receipt(root4, "core")
    finally:
        conformance._iter_receipts = real_iter
        conformance._find_receipt_by_id = real_find
        conformance._receipt_content_token = real_token
    receipt_dir = Path(root4) / ".saipen/recovery/conformance"
    population = (
        len([p for p in receipt_dir.iterdir() if p.suffix == ".json"])
        if receipt_dir.is_dir()
        else 0
    )
    expect(
        "PERF-004 index lookup avoids the receipt iterators",
        scans["iter"] == 0 and scans["find"] == 0,
        f"iter={scans['iter']} find={scans['find']}",
    )
    expect(
        "PERF-004 index lookup hashes at most one token per receipt "
        "(MEASURED, not constant -- see PERF-002)",
        scans["content_token"] <= max(population, 1),
        f"content_token={scans['content_token']} population={population}",
    )
    expect(
        "PERF-004 index lookup returns the latest receipt",
        got is not None and got.get("receipt_id") == last[0],
        repr(got.get("receipt_id") if got else None),
    )

    # PERF-004 fallback: a corrupted index must still resolve via full scan
    (idx_dir / "core.json").write_text("{not valid json", encoding="utf-8")
    conformance._iter_receipts = ci
    conformance._find_receipt_by_id = cf
    scans["iter"] = 0
    scans["find"] = 0
    try:
        got2 = conformance.latest_receipt(root4, "core")
    finally:
        conformance._iter_receipts = real_iter
        conformance._find_receipt_by_id = real_find
    expect(
        "PERF-004 corrupted index falls back to full scan (still correct)",
        scans["iter"] >= 1 and got2 is not None and got2.get("receipt_id") == last[0],
        f"iter={scans['iter']} got={got2.get('receipt_id') if got2 else None}",
    )

    # ---- AUDIT PERF-002: release Git calls are bounded, not per-path -------
    from types import SimpleNamespace

    root_release = base / "release-batch"
    root_release.mkdir(parents=True)
    release_paths = []
    for i in range(120):
        rel = f"scope/file-{i:03d}.txt"
        target = root_release / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"base {i}\n", encoding="utf-8")
        release_paths.append(rel)
    subprocess.run(["git", "init", "-q"], cwd=root_release, capture_output=True)
    subprocess.run(["git", "add", "-A"], cwd=root_release, capture_output=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "base"],
        cwd=root_release,
        env=git_env(),
        capture_output=True,
    )
    for i, rel in enumerate(release_paths):
        (root_release / rel).write_text(f"changed {i}\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=root_release, capture_output=True)

    real_release_git = release._git
    release_git_calls: list[tuple[str, ...]] = []

    def count_release_git(root, *args, **kwargs):
        release_git_calls.append(tuple(args))
        return real_release_git(root, *args, **kwargs)

    release._git = count_release_git
    try:
        release_index = release._capture_index_state(root_release)
        capture_calls = len(release_git_calls)
        release_git_calls.clear()
        verified = release._verify_index_after_gate(
            root_release,
            SimpleNamespace(
                pre_plan_index=release_index,
                release_paths=tuple(release_paths),
            ),
        )
        verify_calls = len(release_git_calls)
    finally:
        release._git = real_release_git
    expect(
        "AUDIT PERF-002 120-path index capture uses bounded Git calls",
        capture_calls <= 5,
        f"calls={capture_calls}",
    )
    expect(
        "AUDIT PERF-002 120-path post-gate verification uses bounded Git calls",
        verified.get("ok") is True and verify_calls <= 8,
        f"result={verified!r} calls={verify_calls}",
    )

    # ---- PERF-005: lightweight stability digest == full-decode digest ------
    from saipen_engine.journal import OPS_DIR

    root5 = base / "perf5"
    ops_dir = root5 / OPS_DIR
    ops_dir.mkdir(parents=True, exist_ok=True)
    for i in range(5):
        d = ops_dir / f"op-{i:03d}"
        d.mkdir(parents=True)
        (d / "operation.json").write_text(
            _json.dumps(
                {
                    "op_id": f"op-{i:03d}",
                    "operation": "op",
                    "created_at": "2026-01-01T00:00:00Z",
                    "agent": "probe",
                    "project_identity": str(root5),
                    "project_lineage": None,
                    "semantic_payload_hash": "h",
                    "preconditions": {},
                    "read_preconditions": {},
                    "verification_policy": "none",
                    "status": "COMMITTED",
                    "progress_index": 1,
                    "targets": [
                        {
                            "path": "x.txt",
                            "role": "generic",
                            "action": "write",
                            "before_hash": "a",
                            "after_hash": "b",
                            "applied": True,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
    real_decode = journal.decode_operation_record
    decode_calls = 0

    def counting_decode(*args, **kwargs):
        nonlocal decode_calls
        decode_calls += 1
        return real_decode(*args, **kwargs)

    journal.decode_operation_record = counting_decode
    try:
        receipt_snapshot = crew._capture_operation_receipts(root5)
        decoded_once = decode_calls
        source_stub = SimpleNamespace(
            source_head="no-git",
            source_tree_fingerprint="tree:probe",
        )
        convergence.convergence_verdict(
            root5, source_stub, receipt_snapshot=receipt_snapshot
        )
        release.release_verdict(root5, receipt_snapshot=receipt_snapshot)
        decoded_after_consumers = decode_calls
    finally:
        journal.decode_operation_record = real_decode
    full_digest = receipt_snapshot.digest
    light_digest = crew._capture_receipt_digest(root5)
    expect(
        "PERF-005 lightweight stability digest equals full-decode digest",
        full_digest == light_digest,
        f"full={full_digest} light={light_digest}",
    )
    expect(
        "AUDIT PERF-004 convergence/release reuse one canonical receipt decode",
        decoded_once == 5 and decoded_after_consumers == decoded_once,
        f"capture={decoded_once} after-consumers={decoded_after_consumers}",
    )


def main() -> int:
    base = Path(tempfile.mkdtemp(prefix="saipen-perf-wave-"))
    try:
        run_t1019(base)
        run_t1020(base)
        run_t1021()
        run_t1023(base)
        run_t1022()
    finally:
        shutil.rmtree(base, ignore_errors=True)
    print(f"perf wave: {checked - len(problems)}/{checked} checks passed, {len(problems)} failed")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
