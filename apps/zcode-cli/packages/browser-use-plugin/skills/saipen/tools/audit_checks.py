#!/usr/bin/env python3
"""Proves the canonical validator's checks can still go red.

`tools/audit_floor.py` does this for the checks in the frozen portable
floor. Nothing did it for `tools/validate.py`, which now carries around 160
failure paths -- and measuring it is unpleasant reading: the inputs this
repository ships (its own `.saipen/` plus 15 executable fixtures) produce 17
distinct FAIL/WARN lines between them. Every other check rests on a hand test
from the day it was written.

That is not a hypothetical risk here. A check in this file lay dead from
`feae149` to v7.99.0 because its regex never matched a LOG line, and the first
draft of the portable-floor check could not go red at all. The repository's own
rule is that a hand test proves a check worked once and a fixture proves it
still works -- and the sixteen releases before this tool red-tested roughly
twenty-five checks in scratch directories that were deleted immediately after.
This is those tests, kept.

Each case breaks a known-good copy of this repository in exactly one way and
asserts the validator names that specific failure. A case that stops firing is
a check that has gone dead, and it fails here rather than being discovered
years later.

Exit 0 when every case still goes red, 1 otherwise.

Single file per case, deliberately. A validator condition whose trigger spans
MORE than one project file cannot be red-tested here: mutate `STATE.md` alone
and the board still disagrees, mutate `BOARD.md` alone and `next_action` is
still legal, and every single-file attempt goes not-red. Those belong in
`tests/scenarios/`, which constructs a whole `.saipen/` and is therefore the
canonical route for a compound condition -- no new mechanism was needed for it,
only the observation that this one is the wrong tool (T-457). The DONE-wait
deadlock under both goal modes is the worked pair:
`tests/scenarios/done-wait-deadlock/` and `-goal-mode/`.
"""

from __future__ import annotations

import ast
import contextlib
import datetime
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

import fail_site_inventory as inventory
from freshness import compute_role_revision, compute_source_identity
from saipen_engine.paths import project_lineage_identity
from saipen_engine.release_contract import locale_readme_paths

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

HOME = Path(__file__).resolve().parent.parent
IGNORE = shutil.ignore_patterns(".git", ".venv", "__pycache__", ".freebuff", "node_modules", "nul")

STATE = ".saipen/STATE.md"
BOARD = ".saipen/BOARD.md"
LOG = ".saipen/LOG.md"
IDENTITY = ".saipen/IDENTITY.md"
DIGEST = ".saipen/kitchen/digest.md"
MANIFEST = ".saipen/kitchen/markhunt_progress.md"
SUB = ".saipen/extensions/subs/saiwiki/STATE.md"
CHANGELOG = "CHANGELOG.md"
CORE = "saipen/CORE.md"
IMPROVE = "saipen/IMPROVE.md"
INDEX = "saipen/INDEX.md"
ACTIVATION = "saipen/ACTIVATION_BLOCK.md"
CONVERGE = "saipen/CONVERGE.md"
COMMANDS = "saipen/COMMANDS.md"
RUNTIME_SURFACE = "tools/saipen_engine/runtime_surface.py"
AUTOINJECT = "tools/autoinject.py"
CREW_BACKLOG = ".saipen/KNOWLEDGE/crew-v8-backlog.md"
KNOWLEDGE_CARD = ".saipen/KNOWLEDGE/cards/red-control-before-green.md"
STATE_SCHEMA = "extensions/schemas/state.schema.json"
IMPROVE_REPORT = ".saipen/improve/imp-key-20260808/seat01/saipen_improve_PROJ.md"
IMPROVE_MANIFEST = ".saipen/improve/imp-key-20260808/MANIFEST.md"
PHASE_IMPROVE = "saipen/phases/improve.md"
TAG_QUERY = ("git", "tag", "-l", "v*")
AUDIT_TAGS_GIT_SHIM = "SAIPEN_AUDIT_TAGS_GIT_SHIM"
AUDIT_TAGS_MODE = "SAIPEN_AUDIT_TAGS_MODE"

#: The adjudicated fail surface of `tools/validate.py`, by identity. Owned by
#: `tools/fail_site_inventory.py` and recorded in `tools/validator_fail_sites.json`.
#:
#: This used to be one integer. A scalar binds VOLUME, not identity: the
#: KNOWLEDGE structured-surface check landed in v7.254.0 and the closing sweep
#: line read the same total before and after a check arrived with no control
#: (T-1292), and a change that removes one check while adding another keeps the
#: total forever. `test_check_inventory.py` proved that blind spot instead of
#: closing it. T-1359 closed it: every fail site now carries a semantic id, and
#: an added, removed or same-count SWAPPED site is named individually.
VALIDATOR_FAIL_SITE_LEDGER = inventory.LEDGER_REL

#: The honest half, restated for what the gate now actually binds. Identity
#: says WHICH checks exist and refuses a surface that silently became a
#: different surface. It still does not claim every check has a control: a
#: `BASELINE` record is inherited and never individually adjudicated, and the
#: ledger says so per site rather than hiding it behind a total.
CHECK_INVENTORY_LIMITATION = (
    "identity binds WHICH fail sites tools/validate.py declares, so an added, "
    "removed or same-count swapped site is named -- but a BASELINE record is "
    "inherited surface that was never individually adjudicated, which is "
    "recorded per site and is NOT detected here as missing coverage"
)


def freshen_synthetic_outboxes(tree: Path) -> None:
    """Make copied producer packages valid without touching live OUTBOXes."""
    identity = compute_source_identity(tree)

    def upsert_bold(text: str, field: str, value: str) -> str:
        pattern = rf"(?m)^- \*\*{re.escape(field)}:\*\*.*$"
        line = f"- **{field}:** {value}"
        if re.search(pattern, text):
            return re.sub(pattern, line, text, count=1)
        return text.replace("- **producer:**", line + "\n- **producer:**", 1)

    wiki = tree / ".saipen/extensions/subs/saiwiki/kitchen/OUTBOX.md"
    wiki_charter = tree / "extensions/subs/saiwiki.md"
    if wiki.is_file() and wiki_charter.is_file():
        text = wiki.read_text(encoding="utf-8-sig")
        first_entry = text.find("\n## ")
        if first_entry >= 0:
            text = "# OUTBOX\n" + text[first_entry:]
        text = upsert_bold(text, "source_head", identity.source_head)
        text = upsert_bold(text, "source_tree_fingerprint", identity.source_tree_fingerprint)
        text = upsert_bold(text, "role_revision", compute_role_revision(wiki_charter))
        wiki.write_text(text, encoding="utf-8", newline="\n")

    translate = tree / ".saipen/saitranslate/kitchen/OUTBOX.md"
    translate_charter = tree / "extensions/subs/saitranslate.md"
    if translate.is_file() and translate_charter.is_file():
        text = translate.read_text(encoding="utf-8-sig")
        fields = {
            "source_head": identity.source_head,
            "source_tree_fingerprint": identity.source_tree_fingerprint,
            "role_revision": compute_role_revision(translate_charter),
            "summary": "synthetic audit control package",
            "critical": "false",
        }
        for field, value in fields.items():
            pattern = rf"(?m)^{re.escape(field)}:.*$"
            line = f"{field}: {value}"
            if re.search(pattern, text):
                text = re.sub(pattern, line, text, count=1)
            else:
                text = text.replace("producer:", line + "\nproducer:", 1)
        translate.write_text(text, encoding="utf-8", newline="\n")

    derived_translate = tree / ".saipen/extensions/subs/saitranslate" / "kitchen/OUTBOX.md"
    if derived_translate.is_file():
        derived_translate.write_text("# OUTBOX\n", encoding="utf-8", newline="\n")


#: T-1446: the operator's host-session carriers must never reach a probe child.
#:
#: Measured: with `SAIPEN_PROJECT_ROOT`/`SAIPEN_PROJECT_LINEAGE` present, a
#: probe's `cwd=<copy>` was outranked by the ambient carrier (the resolver ranks
#: the carrier above the working directory), so phase-rename, warn-ownership,
#: release-ledger and validator-baseline judged the LIVE repository instead of
#: the copy under test -- the copy's own renaming and mutations were never
#: read, and the verdicts moved with the operator's session rather than with
#: the tree. This is the class `tools/test_hermetic_env.py` closes one level
#: down; the tool that JUDGES fixtures isolates its children the same way.
HOST_SESSION_VARIABLES = (
    "SAIPEN_PROJECT_ROOT",
    "SAIPEN_PROJECT_LINEAGE",
    "SAIPEN_AGENT",
    "SAIPEN_CAPABILITY",
    "SAIPEN_HOST_SESSION",
    "SAIPEN_HOST_ENFORCEMENT",
    "SAIPEN_RUNTIME_INFO",
    "SAIPEN_SKILL_ROOT",
)


def hermetic_child_env(**overrides: str) -> dict[str, str]:
    """A child-process environment with no host-session carrier.

    Every probe child is addressed by its `cwd`, so no carrier is ever input;
    `overrides` are applied last for probes that deliberately set a shim.
    """
    env = dict(os.environ)
    for key in HOST_SESSION_VARIABLES:
        env.pop(key, None)
    env.update(overrides)
    return env


def root_device_ignore_probe(tmp: Path) -> str | None:
    """Prove a real `nul` entry cannot poison an audit snapshot.

    On Windows, ordinary APIs resolve `nul` to the character device instead
    of creating a directory entry. The extended path creates the same real
    NTFS artifact an external shell/agent left in this repository. POSIX can
    create the name normally, so CI still exercises the ignore contract.
    """
    source = tmp / "root-device-source"
    destination = tmp / "root-device-copy"
    source.mkdir()
    (source / "kept.txt").write_text("kept\n", encoding="utf-8")
    reserved = source / "nul"
    native = "\\\\?\\" + str(reserved.resolve()) if os.name == "nt" else str(reserved)
    try:
        with open(native, "wb") as stream:
            stream.write(b"external agent artifact")
        shutil.copytree(source, destination, ignore=IGNORE)
        copied = {entry.name.casefold() for entry in destination.iterdir()}
        if copied != {"kept.txt"}:
            return "snapshot did not preserve only the ordinary control file"
    except (OSError, shutil.Error) as exc:
        return f"snapshot raised {type(exc).__name__}: {exc}"
    finally:
        # Cleanup of this synthetic probe is not evidence: on hosts where
        # `os.unlink` is intercepted (trash / safe-delete shims) removing a
        # reserved-name artifact raises OSError rather than FileNotFoundError,
        # and letting that escape a `finally` aborts the whole harness before
        # a single evidence case runs. The probe's verdict is already decided
        # by the copytree above; the trees are removed best-effort.
        with contextlib.suppress(OSError):
            os.unlink(native)
        shutil.rmtree(source, ignore_errors=True)
        shutil.rmtree(destination, ignore_errors=True)
    return None


def symlink_restore_probe(tmp: Path) -> str | None:
    """Prove mutation restoration removes the link, not its target bytes."""
    probe = tmp / "symlink-restore-probe"
    probe.mkdir()
    path = probe / "IDENTITY.md"
    external = probe / "external.md"
    original = b"original authority\n"
    path.write_bytes(original)
    external.write_bytes(b"external authority\n")
    saved = [(path, path.read_bytes())]
    path.unlink()
    try:
        os.symlink(external, path)
    except (OSError, NotImplementedError) as exc:
        return f"cannot construct symlink red control: {exc}"
    restore_case_files(saved)
    if path.is_symlink() or path.read_bytes() != original:
        return "restoration followed or retained the mutated symlink"
    if external.read_bytes() != b"external authority\n":
        return "restoration overwrote the external symlink target"
    return None


def rebind_synthetic_milestones(tree: Path) -> None:
    """Upgrade an in-flight legacy runtime binding in copied test evidence."""
    for manifest_path in tree.glob(".saipen/milestones/CP-*/manifest.json"):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if "project_identity" not in manifest or "project_lineage" in manifest:
            continue
        manifest.pop("project_identity", None)
        manifest["project_lineage"] = project_lineage_identity(tree)
        manifest["schema_version"] = 2
        body = {key: value for key, value in manifest.items() if key != "integrity_hash"}
        encoded = (
            json.dumps(body, sort_keys=True, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")
        manifest["integrity_hash"] = hashlib.sha256(encoded).hexdigest()
        manifest_path.write_text(
            json.dumps(manifest, sort_keys=True, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )


def release_ledger_probe(source: Path, destination: Path) -> str | None:
    """Execute clean, new-divergence, and stale-baseline ledger controls."""
    tree = destination / "release-ledger"
    shutil.copytree(source, tree)

    # This probe tests release-ledger divergence, not handoff freshness. The
    # live repository may deliberately carry producer-owned ready packages
    # awaiting another model; make those historical in the synthetic clone so
    # unrelated OUTBOX failures cannot mask this probe's own red controls.
    outboxes = list(tree.glob(".saipen/extensions/subs/*/kitchen/OUTBOX.md"))
    translate_outbox = tree / ".saipen" / "saitranslate" / "kitchen" / "OUTBOX.md"
    if translate_outbox.is_file():
        outboxes.append(translate_outbox)
    for outbox in outboxes:
        text = outbox.read_text(encoding="utf-8-sig")
        text = text.replace("**status:** ready", "**status:** stale")
        text = re.sub(r"(?m)^status:\s*ready\s*$", "status: stale", text)
        outbox.write_text(text, encoding="utf-8", newline="\n")

    # Restore milestones are deliberately bound to a canonical project
    # identity.  This probe copies a real project to a different root, so make
    # that copied evidence belong to the synthetic project before its initial
    # commit.  Otherwise the milestone validator correctly rejects the fixture
    # before the release-ledger controls this probe exists to exercise.
    rebind_synthetic_milestones(tree)

    def git(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *args], cwd=tree, capture_output=True, text=True, errors="replace"
        )

    for args in (
        ("init", "-q"),
        ("config", "user.name", "SAIPEN ledger probe"),
        ("config", "user.email", "ledger-probe@example.invalid"),
        # The committed tree, not just present: the runtime
        # manifest now requires its files to be tracked, and a probe
        # whose repository contains one empty commit has every file
        # untracked. That made this fixture fail for a reason it does
        # not test -- a synthetic repository has to resemble a real
        # clone in every way the validator can see.
        ("add", "-A"),
        ("commit", "--allow-empty", "-m", "ledger probe"),
    ):
        result = git(*args)
        if result.returncode:
            return f"git {' '.join(args)} failed: {(result.stderr or result.stdout).strip()}"

    # The copied real `.saipen/LOG.md` carries `hunt -> clean @<hash>` marks
    # that name this repository's real commits. In this synthetic repo only
    # the probe's own commit exists, so the hunt-mark gate (tools/validate.py)
    # FAILs the fixture before any release-ledger control has run -- a reason
    # the probe does not test. Re-point the active marks at the synthetic
    # commit and commit the sanitization, so the fixture again resembles a
    # real clone in every way the validator can see.
    active_log = tree / ".saipen" / "LOG.md"
    if active_log.is_file():
        short = git("rev-parse", "--short", "HEAD").stdout.strip()
        text = active_log.read_text(encoding="utf-8-sig")
        sanitized = re.sub(r"hunt -> clean @[0-9a-f]{7,40}\b", f"hunt -> clean @{short}", text)
        if sanitized != text:
            active_log.write_text(sanitized, encoding="utf-8", newline="\n")
            for args in (
                ("add", ".saipen/LOG.md"),
                ("commit", "-q", "-m", "re-point synthetic hunt marks"),
            ):
                result = git(*args)
                if result.returncode:
                    return (
                        f"git {' '.join(args)} failed: " + (result.stderr or result.stdout).strip()
                    )

    baseline = json.loads(
        (tree / "tools" / "release_ledger_baseline.json").read_text(encoding="utf-8")
    )
    changelog_only = set(baseline["changelog_only"])
    changelog_versions = set()
    for name in ("CHANGELOG.md", "CHANGELOG_ARCHIVE.md"):
        path = tree / name
        if path.is_file():
            changelog_versions |= set(
                re.findall(
                    r"^## (\d+\.\d+\.\d+)", path.read_text(encoding="utf-8-sig"), re.MULTILINE
                )
            )
    for version in sorted(changelog_versions - changelog_only):
        result = git("tag", f"v{version}")
        if result.returncode:
            return f"could not seed ledger tag v{version}: {result.stderr.strip()}"

    def validate() -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(tree / "tools" / "validate.py")],
            cwd=tree,
            env=hermetic_child_env(),
            capture_output=True,
            text=True,
            errors="replace",
        )

    control = validate()
    control_text = control.stdout + control.stderr
    if control.returncode or "WARN [release-ledger]" in control_text:
        first = next(
            (
                line
                for line in control_text.splitlines()
                if line.startswith(("FAIL", "WARN [release-ledger]"))
            ),
            "validator exited without a focused line",
        )
        return f"clean synthetic ledger is not clean: {first}"

    tag_only = "7.83.9"
    if git("tag", f"v{tag_only}").returncode:
        return "could not create tag-only red-control"
    tag_result = validate()
    tag_text = tag_result.stdout + tag_result.stderr
    if tag_result.returncode != 0 or f"git tag but no CHANGELOG entry: v{tag_only}" not in tag_text:
        return "new tag-only divergence did not produce its focused warning"
    if git("tag", "-d", f"v{tag_only}").returncode:
        return "could not remove temporary tag-only red-control"

    changelog_version = "7.83.8"
    changelog = tree / "CHANGELOG.md"
    changelog.write_text(
        changelog.read_text(encoding="utf-8-sig")
        + f"\n## {changelog_version} -- 2026-07-31 -- ledger red-control\n",
        encoding="utf-8",
        newline="\n",
    )
    changelog_result = validate()
    changelog_text = changelog_result.stdout + changelog_result.stderr
    if (
        changelog_result.returncode != 0
        or f"CHANGELOG entry but no git tag: v{changelog_version}" not in changelog_text
    ):
        return "new changelog-only divergence did not produce its focused warning"

    original = next(iter(sorted(changelog_only)))
    if git("tag", f"v{original}").returncode:
        return "could not create stale-baseline red-control"
    stale_result = validate()
    stale_text = stale_result.stdout + stale_result.stderr
    if stale_result.returncode == 0 or f"baseline is stale for: v{original}" not in stale_text:
        return "resolved historical exception did not make stale baseline fail"
    return None


# T-1247: the probe's own BOARD insertion must not move the board across
# validate.py's 16 KB `board-soft-cap` threshold between legs. Ownership is a
# substring test over live board lines, so slug PRESENCE and board SIZE are
# independent dimensions -- varying them together let a fixture board sitting
# within one ticket line of the cap gain `board-soft-cap` in the green leg
# only, and the set-delta assertion reported that as an ownership break the
# probe never tested. The owning line is therefore present in every leg and
# only its slug token changes, so the three boards are byte-identical in
# length by construction.
#: T-1359: this used to name `log-missing-date` outright, and a live BLOCKED
#: ticket (T-1313) now names that slug in its own prose -- so the RED leg's
#: "aged AND unowned" condition became unreachable and the probe proved
#: nothing. The slug is DERIVED per run instead: whatever this copy actually
#: emits and no live board line owns. A hard-coded subject of a control is a
#: bet that the repository will not change around it, and this one lost.
WARN_PROBE_OWNER_SLUG = "log-missing-date"

#: The agent name the probe's own journal entry is attributed to.
WARN_PROBE_AGENT = "claude"

#: The ticket the probe files to own a slug. Hand-filed, so it needs its own
#: allocation event -- see `journal_probe_allocation`.
WARN_PROBE_TICKET = "T-990"
WARN_PROBE_NEUTRAL_SLUG = "zzz-absent-slug0"

#: Width the slug token is padded to inside the owning line, so ANY derived
#: slug leaves the board byte-identical across all three legs (T-1247) without
#: the neutral and owner slugs having to be the same length by hand.
WARN_PROBE_SLUG_FIELD = 32

#: How many consecutive releases a WARN slug must survive before it is
#: standing debt. Mirrors `tools/validate.py`'s `WARN_OWNER_SPAN`; the probe
#: only needs it to refuse a fixture whose history is too short to age one.
WARN_OWNER_SPAN = 3

#: Slugs the probe must not adopt: each is already tracked with its own
#: rationale, and re-aging one would rewrite a real ledger record rather than
#: measure this control.
WARN_PROBE_RESERVED_SLUGS = frozenset({"board-soft-cap", "log-soft-cap"})


def live_board_slug_lines(board_text: str) -> list[str]:
    """The board lines the ownership check reads: DOING, TODO and BLOCKED."""
    live: list[str] = []
    section = ""
    for line in board_text.splitlines():
        if line.startswith("## "):
            section = line.strip()
            continue
        if section in ("## DOING", "## TODO", "## BLOCKED") and line.startswith("- ["):
            live.append(line)
    return live


def select_warn_probe_slug(emitted: set[str], board_text: str, tracked) -> str | None:
    """An emitted WARN slug no live BOARD line already owns.

    Deterministic (sorted), so two runs of this gate choose the same subject.
    Returns None when every emitted slug is already owned -- which the caller
    must report, because a control with no available subject has to be loud
    rather than quietly green.
    """
    live = live_board_slug_lines(board_text)
    candidates = [
        slug
        for slug in sorted(emitted)
        if slug not in tracked
        and slug not in WARN_PROBE_RESERVED_SLUGS
        and len(slug) <= WARN_PROBE_SLUG_FIELD
        and not any(slug in line for line in live)
    ]
    return candidates[0] if candidates else None


def warn_probe_ticket(slug: str) -> str:
    """The probe's owning-ticket line for `slug`.

    The owning ticket lives under ## BLOCKED, not ## TODO. Ownership reads any
    live line (DOING/TODO/BLOCKED), but workability is TODO-only -- so a
    BLOCKED fixture can never become the Pick Rule's topmost workable ticket,
    which on a real `phase: BLOCKED` session state would trip the DONE-wait
    deadlock FAIL and mask the behavior under test.

    Every leg gets a line of this exact shape; `WARN_PROBE_NEUTRAL_SLUG` is the
    same length as `WARN_PROBE_OWNER_SLUG` and names no tracked slug, so
    swapping one for the other changes ownership without changing one byte of
    board size.
    """
    return (
        f"- [ ] {WARN_PROBE_TICKET} [P2] Own the persistent "
        f"`{slug.ljust(WARN_PROBE_SLUG_FIELD)}` warning: "
        "125 sealed pre-DATE entries are immutable by append-only, so it "
        "warns forever; keep this ticket live while it emits. | "
        "verify: warn ownership probe passes with this ticket live | "
        "blocker: warn-ownership-probe fixture -- permanently held\n"
    )


def journal_probe_allocation(tree: Path, ticket: str) -> str | None:
    """Give a copied tree an allocation event for a hand-filed fixture ticket.

    CORE-003 made every BOARD record need a structured `[T-###]` event in the
    complete history, so a probe that hand-files its own ticket -- which this
    one must, because RED and GREEN have to differ by one slug and nothing
    else -- files a record the validator correctly refuses. The event is
    appended the way a checkpoint appends one: next id, parent the current
    tail (T-1359).
    """
    log = tree / LOG
    if not log.is_file():
        return f"copied tree has no {LOG} to journal {ticket} into"
    text = log.read_text(encoding="utf-8-sig")
    events = re.findall(r"(?m)^- (\d\d\.\d\d\.\d\d \d\d:\d\d) \[E-(\d+)\]", text)
    if not events:
        return f"copied {LOG} carries no parsable event to continue from"
    stamp, last = events[-1]
    entry = (
        f"- {stamp} [E-{int(last) + 1}] [parent: E-{last}] [{ticket}] "
        f"[agent: {WARN_PROBE_AGENT}] [op: alloc-{'0' * 32}] "
        f"DEC: allocated for the warn-ownership probe fixture\n"
    )
    log.write_text(text.rstrip("\n") + "\n" + entry, encoding="utf-8", newline="\n")
    return None


def warn_probe_board(board_text: str, slug: str) -> str | None:
    """Return `board_text` with the probe's owning ticket for `slug` filed at
    the END of ## BLOCKED, or None when the board has no such section.

    Appended at the END of its section: board order is priority (RFC section
    1.11) and STATE's next_action names the topmost workable ticket, so a probe
    that files its own ticket first invalidates that pick and then fails for a
    reason it does not test. Heading-aware insertion: an EMPTY ## TODO directly
    abutting ## DONE made a raw newline-anchored `find` from inside the section
    line skip the very next heading, dropping the owning ticket into ## DONE --
    where its open box and missing closure evidence failed the green leg for
    reasons unrelated to warn ownership.
    """
    if "## BLOCKED" not in board_text:
        return None
    lines = board_text.splitlines(keepends=True)
    section = next(i for i, ln in enumerate(lines) if ln.strip() == "## BLOCKED")
    following = next(
        (j for j in range(section + 1, len(lines)) if lines[j].startswith("## ")),
        len(lines),
    )
    return "".join(lines[:following]) + warn_probe_ticket(slug) + "".join(lines[following:])


def warn_ownership_probe(source: Path, destination: Path) -> str | None:
    """T-401: a WARN slug aged past the owner span FAILs unless a live
    BOARD ticket names it; the identical aged slug with a live naming
    ticket passes. The red control mutates baseline DATA, never validator
    wording."""
    tree = destination / "warn-ownership"
    shutil.copytree(source, tree)
    rebind_synthetic_milestones(tree)

    baseline_path = tree / "tools" / "release_ledger_baseline.json"
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))

    def git(*args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *args], cwd=tree, capture_output=True, text=True, errors="replace"
        )

    # A copied pre-release worktree has no `.git/`, while VERSION/CHANGELOG
    # intentionally lead the last shipped digest.  Give this unrelated WARN
    # ownership fixture a complete synthetic release ledger so that the
    # release validator does not mask its actual red control.
    version = (tree / "VERSION").read_text(encoding="utf-8").strip()
    (tree / DIGEST).write_text(
        f"done: ship v{version} (synthetic warn-ownership fixture)\n"
        "remaining: nothing\n"
        "awaiting: nothing\n",
        encoding="utf-8",
        newline="\n",
    )
    for args in (
        ("init", "-q"),
        ("config", "user.name", "SAIPEN warn probe"),
        ("config", "user.email", "warn-probe@example.invalid"),
        ("add", "-A"),
        ("commit", "--allow-empty", "-m", "warn ownership probe"),
    ):
        result = git(*args)
        if result.returncode:
            return f"git {' '.join(args)} failed: {(result.stderr or result.stdout).strip()}"

    active_log = tree / LOG
    short = git("rev-parse", "--short", "HEAD").stdout.strip()
    text = active_log.read_text(encoding="utf-8-sig")
    sanitized = re.sub(r"hunt -> clean @[0-9a-f]{7,40}\b", f"hunt -> clean @{short}", text)
    if sanitized != text:
        active_log.write_text(sanitized, encoding="utf-8", newline="\n")
        for args in (("add", LOG), ("commit", "-q", "-m", "re-point synthetic hunt marks")):
            result = git(*args)
            if result.returncode:
                return f"git {' '.join(args)} failed: {(result.stderr or result.stdout).strip()}"

    changelog_only = set(baseline["changelog_only"])
    changelog_versions: set[str] = set()
    for name in ("CHANGELOG.md", "CHANGELOG_ARCHIVE.md"):
        path = tree / name
        if path.is_file():
            changelog_versions |= set(
                re.findall(
                    r"^## (\d+\.\d+\.\d+)",
                    path.read_text(encoding="utf-8-sig"),
                    re.MULTILINE,
                )
            )
    for release in sorted(changelog_versions - changelog_only):
        result = git("tag", f"v{release}")
        if result.returncode:
            return f"could not seed warn-probe tag v{release}: {result.stderr.strip()}"

    def validate() -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(tree / "tools" / "validate.py")],
            cwd=tree,
            env=hermetic_child_env(),
            capture_output=True,
            text=True,
            errors="replace",
        )

    # T-1359: and the ticket this probe files needs the allocation event
    # CORE-003 requires of every BOARD record, or the control leg fails on the
    # fixture's own hand-filed line instead of on warn ownership.
    alloc_error = journal_probe_allocation(tree, WARN_PROBE_TICKET)
    if alloc_error:
        return alloc_error

    # T-1247: file the ownership-neutral line first, so CONTROL, RED and GREEN
    # all measure a board of the same size and the only thing the green leg
    # changes is which slug that line names.
    board = tree / ".saipen" / "BOARD.md"
    neutral_board = warn_probe_board(
        board.read_text(encoding="utf-8-sig"), WARN_PROBE_NEUTRAL_SLUG
    )
    if neutral_board is None:
        return "BOARD copy has no ## BLOCKED section to host the owning ticket"
    board.write_text(neutral_board, encoding="utf-8", newline="\n")

    control = validate()
    if control.returncode:
        return (
            "control copy with calibrated warn_slugs is not clean: "
            + (control.stdout + control.stderr).strip()[-300:]
        )

    def _warn_slugs(output: str) -> set[str]:
        """The set of WARN slugs the validator reports, for set-delta proof
        (T-639): RED must differ from CONTROL only by the target ownership
        failure, and GREEN must remove only that failure."""
        return {
            ln.split("[", 1)[1].split("]", 1)[0]
            for ln in output.splitlines()
            if ln.startswith("WARN [")
        }

    control_slugs = _warn_slugs(control.stdout + control.stderr)

    # T-1359: the subject is whatever THIS copy emits and no live board line
    # already owns, chosen from the control run rather than named in advance.
    # The window is the copy's own release history for the same reason: a
    # hand-written `7.1.0 -> 7.160.0` ages out of the ledger the day those
    # releases stop being in it, and an age below the span silently skips the
    # check instead of failing it.
    owner_slug = select_warn_probe_slug(control_slugs, neutral_board, baseline["warn_slugs"])
    if owner_slug is None:
        return (
            "no emitted WARN slug is available as this probe's subject: every "
            f"one of {sorted(control_slugs)} is already tracked, reserved, or "
            f"named by a live BOARD line, so the aged-and-unowned condition "
            f"cannot be built"
        )
    releases = sorted(tuple(int(part) for part in v.split(".")) for v in changelog_versions)
    if len(releases) < WARN_OWNER_SPAN:
        return (
            f"copied release history holds {len(releases)} version(s), fewer "
            f"than the {WARN_OWNER_SPAN} an aged slug needs"
        )
    baseline["warn_slugs"][owner_slug] = {
        "first_seen": ".".join(str(part) for part in releases[0]),
        "last_seen": ".".join(str(part) for part in releases[-1]),
        "rationale": "ownership probe: aged, unowned",
    }
    baseline_path.write_text(
        json.dumps(baseline, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n"
    )
    red = validate()
    red_text = red.stdout + red.stderr
    if (
        red.returncode == 0
        or "no live BOARD ticket names it" not in red_text
        or owner_slug not in red_text
    ):
        return (
            f"aged unowned slug {owner_slug!r} did not fail the validator: "
            + red_text.strip()[-300:]
        )
    # T-639: aging the target slug must not disturb the WARN slug set beyond
    # the target slug itself -- the probe's own mutation introduces no
    # unrelated warning.
    red_slugs = _warn_slugs(red_text)
    if red_slugs != control_slugs:
        return (
            f"aging the target slug changed the WARN slug set: {sorted(control_slugs ^ red_slugs)}"
        )

    # The identical aged slug with a live naming ticket must pass. Only the
    # slug token moves: the line, its position and the board's byte size are
    # the ones CONTROL and RED already measured (T-1247).
    owned_board = neutral_board.replace(
        warn_probe_ticket(WARN_PROBE_NEUTRAL_SLUG),
        warn_probe_ticket(owner_slug),
    )
    if len(owned_board) != len(neutral_board):
        return (
            "warn-probe owning line changed the board size "
            f"({len(neutral_board)} -> {len(owned_board)}); the neutral and "
            "owner slugs must be the same length or the probe varies board "
            "size together with ownership"
        )
    board.write_text(owned_board, encoding="utf-8", newline="\n")
    green = validate()
    green_text = green.stdout + green.stderr
    if green.returncode:
        return "aged slug with live owning ticket still fails: " + green_text.strip()[-300:]
    # T-639: the green leg (the line now names the aged slug) must not create a
    # SECOND failing warn slug, and must not disturb the WARN slug set. Assert
    # the slug SET, not just the returncode. Since T-1247 the board is
    # byte-identical across all three legs, so a difference here is a real
    # ownership effect and never the probe's own board growth.
    green_slugs = _warn_slugs(green_text)
    if green_slugs != red_slugs:
        return (
            "naming the aged slug on the live board changed the WARN slug set: "
            f"{sorted(red_slugs ^ green_slugs)}"
        )
    green_fails = [ln for ln in green_text.splitlines() if ln.startswith("FAIL: warn ownership")]
    if green_fails:
        return "owning ticket created another failing warn slug: " + "; ".join(green_fails)
    return None


def phase_rename_probe(source: Path, destination: Path) -> str | None:
    """T-426 verify: renaming a phase consistently across every copy the
    validator reads stays green. The new edge gates exist to catch drift,
    not to forbid a deliberate rename: SCOUT -> SCOUTX (and scout -> scoutx,
    word-boundary, so the phase doc file and its citations move too) across
    the whole tree -- DFA, RFC table and enum sentence, schema enum, the
    phase doc and its exit line, STATE references -- must validate clean.
    """
    tree = destination / "phase-rename"
    shutil.copytree(source, tree)
    rebind_synthetic_milestones(tree)
    milestone_root = tree / ".saipen" / "milestones"
    immutable_source_roots = (
        tree / ".saipen" / "intake",
        tree / ".saipen" / "archive" / "source",
    )
    changed = 0
    for path in tree.rglob("*"):
        if not path.is_file():
            continue
        # Restore evidence is historical, content-addressed exact bytes.  A
        # semantic rename of the live protocol must not rewrite its archived
        # payloads or their immutable manifests.
        if path.is_relative_to(milestone_root) or any(
            path.is_relative_to(authority_root) for authority_root in immutable_source_roots
        ):
            continue
        try:
            text = path.read_text(encoding="utf-8-sig")
        except (UnicodeDecodeError, OSError):
            continue
        new = re.sub(r"\bSCOUT\b", "SCOUTX", text)
        new = re.sub(r"\bscout\b", "scoutx", new)
        if new != text:
            path.write_text(new, encoding="utf-8", newline="\n")
            changed += 1
    old_doc = tree / "saipen" / "phases" / "scout.md"
    if old_doc.is_file():
        old_doc.rename(tree / "saipen" / "phases" / "scoutx.md")
    # The probe deliberately changes README.md prose and every translated
    # copy.  Restamp the synthetic translations to that renamed English
    # source; otherwise the translation freshness gate correctly reports the
    # probe's own stale metadata and this intended-green control is unusable.
    renamed_english = tree / "README.md"
    translated_root = tree / ".saipen" / "saitranslate" / "kitchen"
    if renamed_english.is_file() and translated_root.is_dir():
        renamed_digest = hashlib.sha256(
            re.sub(
                r"\d+\.\d+\.\d+",
                "VERSION",
                renamed_english.read_text(encoding="utf-8-sig"),
            ).encode("utf-8")
        ).hexdigest()
        for locale_readme in locale_readme_paths(translated_root):
            if not locale_readme.is_file():
                continue
            locale_text = locale_readme.read_text(encoding="utf-8-sig")
            locale_text = re.sub(
                r"(?m)^(<!-- source-digest: README\.md sha256:)[0-9a-f]+( -->)$",
                rf"\g<1>{renamed_digest}\g<2>",
                locale_text,
                count=1,
            )
            locale_readme.write_text(locale_text, encoding="utf-8", newline="\n")
    for charter in (tree / "extensions" / "subs").glob("sai*.md"):
        text = charter.read_text(encoding="utf-8-sig")
        revision = compute_role_revision(charter)
        text = re.sub(
            r'(?m)^role_revision:\s*["\']?[^\s"\']+["\']?$',
            f'role_revision: "{revision}"',
            text,
            count=1,
        )
        charter.write_text(text, encoding="utf-8", newline="\n")
    if changed == 0:
        return "rename probe changed nothing -- a bug in the probe itself"
    generated = subprocess.run(
        [sys.executable, str(tree / "tools" / "conformance_corpus.py"), "--write"],
        cwd=tree,
        env=hermetic_child_env(),
        capture_output=True,
        text=True,
        errors="replace",
    )
    if generated.returncode:
        return (
            "phase rename could not regenerate the conformance index: "
            + (generated.stdout + generated.stderr).strip()[-400:]
        )
    proc = subprocess.run(
        [sys.executable, str(tree / "tools" / "validate.py")],
        cwd=tree,
        env=hermetic_child_env(),
        capture_output=True,
        text=True,
        errors="replace",
    )
    if proc.returncode:
        output = proc.stdout + proc.stderr
        failures = [line for line in output.splitlines() if line.startswith("FAIL:")]
        return (
            "consistent SCOUT->SCOUTX rename was rejected: "
            + (" | ".join(failures[:4]) if failures else output.strip()[-400:])
        )
    return None


def audit_tags_batch_probe(root: Path, destination: Path) -> str | None:
    """Execute process and protocol failures against the tag audit."""
    missing_env = hermetic_child_env()
    missing_env.pop(AUDIT_TAGS_GIT_SHIM, None)
    missing_env.pop(AUDIT_TAGS_MODE, None)
    missing_env["PATH"] = ""
    missing = subprocess.run(
        [sys.executable, str(root / "tools" / "audit_tags.py")],
        cwd=root,
        env=missing_env,
        capture_output=True,
        text=True,
        errors="replace",
    )
    missing_output = missing.stdout + missing.stderr
    if (
        missing.returncode != 0
        or "SKIP: git unavailable -- cannot audit tags" not in missing_output
        or "PASS:" in missing_output
        or "FAIL:" in missing_output
    ):
        return (
            "missing-Git control did not produce the sole allowed SKIP: "
            f"rc={missing.returncode} {missing_output.strip()[:200]}"
        )

    shim = destination / "audit-tags-git-shim.py"
    shim.write_text(
        """import os
import sys

args = sys.argv[1:]
if args == ["tag", "-l", "v*"]:
    if os.environ["SAIPEN_AUDIT_TAGS_MODE"] == "enumeration_nonzero":
        print("synthetic enumeration failure", file=sys.stderr)
        raise SystemExit(9)
    print("v" + "9.9.9")
    raise SystemExit(0)
if args == ["cat-file", "--batch"]:
    sys.stdin.buffer.read()
    mode = os.environ["SAIPEN_AUDIT_TAGS_MODE"]
    if mode == "nonzero":
        print("synthetic batch failure", file=sys.stderr)
        raise SystemExit(9)
    if mode == "truncated":
        sys.stdout.buffer.write(b"0" * 40 + b" blob 5\\n7.")
        raise SystemExit(0)
    if mode == "malformed":
        sys.stdout.buffer.write(b" blob 5\\n9.9.9\\n")
        raise SystemExit(0)
    if mode == "surplus":
        sys.stdout.buffer.write(b"0" * 40 + b" blob 5\\n9.9.9\\nEXTRA")
        raise SystemExit(0)
raise SystemExit(8)
""",
        encoding="utf-8",
        newline="\n",
    )

    synthetic_tag = "v" + "9.9.9"
    expected = {
        "enumeration_nonzero": (
            "FAIL: git tag enumeration exited 9: synthetic enumeration failure"
        ),
        "nonzero": "FAIL: git cat-file exited 9: synthetic batch failure",
        "truncated": f"FAIL: git cat-file response for {synthetic_tag} is truncated",
        "malformed": f"FAIL: git cat-file response for {synthetic_tag} has malformed header",
        "surplus": "FAIL: git cat-file batch response has 5 unexpected trailing byte(s)",
    }
    for mode, message in expected.items():
        env = hermetic_child_env()
        env[AUDIT_TAGS_GIT_SHIM] = str(shim)
        env[AUDIT_TAGS_MODE] = mode
        result = subprocess.run(
            [sys.executable, str(root / "tools" / "audit_tags.py")],
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            errors="replace",
        )
        output = result.stdout + result.stderr
        if result.returncode == 0:
            return f"{mode} control exited 0"
        if message not in output:
            return f"{mode} control did not report {message!r}: {output.strip()[:200]}"
        if "PASS:" in output or "SKIP:" in output:
            return f"{mode} control printed PASS/SKIP after losing audit evidence"
    return None


def observed_tag_queries(root: Path) -> tuple[int, str | None]:
    """Count real `git tag -l v*` processes through Git's Trace2 stream."""
    handle, raw_path = tempfile.mkstemp(prefix="saipen-git-trace-", suffix=".json")
    os.close(handle)
    trace = Path(raw_path)
    env = hermetic_child_env()
    env["GIT_TRACE2_EVENT"] = str(trace)
    try:
        result = subprocess.run(
            [sys.executable, str(root / "tools" / "validate.py")],
            cwd=root,
            env=env,
            capture_output=True,
            text=True,
            errors="replace",
        )
        output = result.stdout + result.stderr
        count = 0
        for line in trace.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            argv = event.get("argv", [])
            if event.get("event") == "start" and tuple(argv[1:]) == TAG_QUERY[1:]:
                count += 1
        error = None
        if "Traceback (most recent call last)" in output:
            error = "validator crashed while tag queries were observed"
        elif result.returncode:
            first = next(
                (line for line in output.splitlines() if line.startswith("FAIL")), "no FAIL line"
            )
            error = (
                f"validator control exited {result.returncode} while tag "
                f"queries were observed: {first[:100]}"
            )
        return count, error
    finally:
        trace.unlink(missing_ok=True)


def duplicate_tag_query(path: Path) -> str | None:
    """AST-locate the query and insert a second executable call as red-control."""
    source = path.read_text(encoding="utf-8-sig")
    tree = ast.parse(source)
    matches = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        func = node.func
        if not (
            isinstance(func, ast.Attribute)
            and func.attr == "run"
            and isinstance(func.value, ast.Name)
            and func.value.id == "subprocess"
        ):
            continue
        first = node.args[0]
        if not isinstance(first, (ast.List, ast.Tuple)):
            continue
        if len(first.elts) != len(TAG_QUERY):
            continue
        values = tuple(item.value for item in first.elts if isinstance(item, ast.Constant))
        if values == TAG_QUERY:
            matches.append(node)
    if len(matches) != 1:
        return f"red-control setup found {len(matches)} executable tag queries"
    lines = source.splitlines(keepends=True)
    index = matches[0].lineno - 1
    indent = lines[index][: len(lines[index]) - len(lines[index].lstrip())]
    duplicate = (
        f'{indent}subprocess.run(["git", "tag", "-l", "v*"], '
        "capture_output=True, text=True, check=False)\n"
    )
    lines.insert(index, duplicate)
    path.write_text("".join(lines), encoding="utf-8", newline="\n")
    return None


def count_fail_sites(source: str) -> int:
    """How many `fail(...)` sites the canonical validator declares.

    Reporting metadata now, not the gate. `fail_site_inventory` owns identity.
    """
    return inventory.count_fail_sites(source)


def add_fail_site(source: str) -> str:
    """Append one synthetic fail site, as a red control for the inventory."""
    if not source.endswith("\n"):
        source += "\n"
    return source + 'if False:\n    fail("synthetic red-control fail site")\n'


def remove_fail_site(source: str) -> str:
    """Disarm the first fail site, as the other direction's red control."""
    disarmed = source.replace('fail("', 'ok("', 1)
    if disarmed == source:
        raise AssertionError("red-control setup found no literal fail site to disarm")
    return disarmed


def swap_fail_site(source: str) -> str:
    """Remove one fail site and add another. THE control.

    This is the exact change the old counting tripwire could not see: the
    total is unchanged, so a gate bound to volume stays green while the
    validator's fail surface underneath it is a different surface.
    """
    return add_fail_site(remove_fail_site(source))


def pad_above_fail_sites(source: str) -> str:
    """Insert unrelated lines, moving every line number below them.

    The green control for identity: this changes what a line-numbered
    inventory records and must change nothing the identity gate reads.
    """
    marker = "\nimport sys\n"
    if marker not in source:
        raise AssertionError("green-control setup found no import to pad below")
    return source.replace(marker, "\nimport sys\n\n# padding inserted by the identity control\n", 1)


def _inventory_control(destination: Path, name: str, source: str, ledger: str) -> list[str]:
    """Run the identity gate over a deliberately altered validator copy."""
    probe = destination / f"inventory-{name}"
    (probe / "tools").mkdir(parents=True, exist_ok=True)
    try:
        (probe / inventory.VALIDATOR_REL).write_text(source, encoding="utf-8", newline="\n")
        (probe / inventory.LEDGER_REL).write_text(ledger, encoding="utf-8", newline="\n")
        return inventory.inventory_errors(probe)
    finally:
        shutil.rmtree(probe, ignore_errors=True)


def check_inventory_probe(root: Path, destination: Path) -> str | None:
    """Detect a validator check arriving, leaving, or being swapped, with no control.

    `CASES` is hand-maintained and nothing bound it to the validator, so the
    KNOWLEDGE structured-surface check landed with the sweep total unchanged --
    the closing line read 230 of 230 both before and after a check arrived
    uncovered (T-1292). The first repair was a counter, and a counter binds
    volume: remove one check, add another, and the total never moves. T-1359
    replaced it with identity, and the swap below is the control that proves
    the old blind spot is dead rather than merely documented.

    The bound that remains is stated in `CHECK_INVENTORY_LIMITATION`.
    """
    errors = inventory.inventory_errors(root)
    # A record claiming COVERED has to name a control this file still ships.
    # Without this, deleting a CASE leaves its site recorded as covered and
    # the ledger becomes the thing it replaced: a number nobody can check.
    try:
        labels = {case[0] for case in CASES}
        for record in inventory.load_ledger(root)["sites"]:
            named = record.get("case")
            if record.get("disposition") == inventory.COVERED and named not in labels:
                errors.append(
                    f"fail site {record['site_id']} claims COVERED by {named!r}, "
                    f"which is not a CASE in tools/audit_checks.py"
                )
    except (OSError, ValueError, KeyError):
        pass  # already reported by inventory_errors
    if errors:
        return "; ".join(errors[:6]) + (f" (+{len(errors) - 6} more)" if len(errors) > 6 else "")

    try:
        source = (root / inventory.VALIDATOR_REL).read_text(encoding="utf-8-sig")
        ledger = (root / inventory.LEDGER_REL).read_text(encoding="utf-8-sig")
    except OSError as exc:
        return f"cannot read the inventory subject: {exc}"

    # The controls. A gate that cannot notice a changed fail surface would
    # report this baseline green forever, which is the disarmed-control shape
    # the inventory exists to catch. Each names what it must see.
    for name, mutate, must_detect in (
        ("added", add_fail_site, "ADDED"),
        ("removed", remove_fail_site, "REMOVED"),
        ("swapped", swap_fail_site, "ADDED"),
    ):
        try:
            mutated = mutate(source)
        except AssertionError as exc:
            return f"{name} red control could not be built: {exc}"
        found = _inventory_control(destination, name, mutated, ledger)
        if not found:
            return (
                f"the {name} red control was not detected -- the inventory "
                f"cannot see a validator whose fail surface changed"
            )
        if not any(must_detect in line for line in found):
            return (
                f"the {name} red control was detected without naming a "
                f"{must_detect} site: {found[0]}"
            )
    # The swap has to report BOTH halves, or it is a count in disguise.
    swapped = _inventory_control(destination, "swapped-pair", swap_fail_site(source), ledger)
    if not (
        any("ADDED" in line for line in swapped) and any("REMOVED" in line for line in swapped)
    ):
        return (
            "the same-count swap control named only one half; identity must "
            f"report the added AND the removed site: {swapped}"
        )

    # The green control. Identity must be insensitive to unrelated movement,
    # or the gate becomes noise every time a line is inserted anywhere above.
    try:
        padded = pad_above_fail_sites(source)
    except AssertionError as exc:
        return f"green control could not be built: {exc}"
    drift = _inventory_control(destination, "padded", padded, ledger)
    if drift:
        return (
            "inserting unrelated lines moved the inventory, so identity is "
            f"positional after all: {drift[0]}"
        )
    return None


def sub_line(field: str, value: str):
    """Replace a whole frontmatter line."""
    return lambda t: re.sub(rf"^{field}:.*$", f"{field}: {value}", t, flags=re.MULTILINE)


def bump_int_line(field: str):
    """Increment a frontmatter integer instead of guessing its live value."""
    return lambda t: re.sub(
        rf"^{field}:\s*(\d+)$",
        lambda match: f"{field}: {int(match.group(1)) + 1}",
        t,
        count=1,
        flags=re.MULTILINE,
    )


def drop_line(field: str):
    return lambda t: re.sub(rf"^{field}:.*\n", "", t, flags=re.MULTILINE)


def add_after(anchor: str, text: str):
    return lambda t: t.replace(anchor, anchor + text, 1)


def force_goal(text: str, counters: str = ""):
    """Set execution_intent: goal in a STATE frontmatter regardless of what
    the live/pristine state currently holds.

    The harness copies the repo's own live STATE, which may itself sit at
    `execution_intent: goal` (a running goal) -- so `sub_line("execution_intent",
    "goal")` is a no-op exactly when the case needs it to fire. This strips any
    existing intent/counter/legacy lines and writes the goal intent plus the
    requested counter lines deterministically. Anchored on `\\n---` (the closing
    frontmatter delimiter) rather than `\\n---\\n`, because the source may or may
    not carry a trailing newline and the counters must land inside the block
    either way.
    """
    out = [
        ln
        for ln in text.splitlines()
        if not ln.startswith(("execution_intent:", "goal_mode:", "goal_waves:", "goal_tickets:"))
    ]
    joined = "\n".join(out) + "\n"
    if counters:
        joined = joined.replace("\n---", "\n" + counters + "\n---", 1)
    return joined.replace("mode: full", "mode: full\nexecution_intent: goal", 1)


def force_converge(text: str, next_action: str = '"PHASE ADD"'):
    """Write execution_intent: converge plus a given next_action into a STATE
    frontmatter regardless of what the live/pristine state currently holds.

    The T-539 red controls need a converge state that names ADD (scenario 7)
    or a goal-keyed valve pause (the wording half); the live STATE sits at
    `execution_intent: goal` with a ticket-bearing next_action, so both intent
    and next_action have to be replaced deterministically, not via sub_line.
    Same `\n---` anchoring as force_goal so the block closes either way.
    """
    out = [
        ln
        for ln in text.splitlines()
        if not ln.startswith(
            ("execution_intent:", "goal_mode:", "goal_waves:", "goal_tickets:", "next_action:")
        )
    ]
    joined = "\n".join(out) + "\n"
    joined = joined.replace("\n---", f"\nnext_action: {next_action}\n---", 1)
    return joined.replace("mode: full", "mode: full\nexecution_intent: converge", 1)


def replace(old: str, new: str):
    """Mutate the FIRST occurrence. Correct only while the anchor is unique.

    A control that anchors on a phrase appearing twice mutates one and leaves
    the other, so a "the document must still say X" check keeps passing and the
    control silently stops being evidence -- nobody touched the control, and a
    later edit to the document killed it. That happened to `hunt.md regains
    deletion authority` when `ecd77546` added a second "deletes, moves and
    renames nothing" to `saipen/phases/hunt.md`.

    `anchor_occurrences` below is what turns that from a mystery into a
    sentence, and `replace_all` is the fix for a phrase that is legitimately
    repeated. This stays first-only because several controls need exactly one
    edit to produce exactly one finding.
    """
    fn = lambda t: t.replace(old, new, 1)  # noqa: E731
    fn.anchor = old
    return fn


def replace_all(old: str, new: str):
    """Mutate EVERY occurrence, for an anchor the document repeats on purpose."""
    fn = lambda t: t.replace(old, new)  # noqa: E731
    fn.anchor = old
    return fn


def anchor_occurrences(mutation, path: Path) -> int | None:
    """How many times a replace-style mutation's anchor appears in its target.

    None when the mutation is not anchor-based (a callable, a DELETE, a raw
    WRITE) or the file is unreadable -- those cannot fail this way.
    """
    anchor = getattr(mutation, "anchor", None)
    if not isinstance(anchor, str) or not anchor:
        return None
    try:
        return path.read_text(encoding="utf-8", errors="replace").count(anchor)
    except OSError:
        return None


def bump_second_changelog_entry(text: str) -> str:
    """Raise the SECOND CHANGELOG entry above the head, breaking descending order.

    Derived rather than anchored on a literal version: the release that
    archives the CHANGELOG overflow carries any hardcoded anchor out of the
    file, at which point the mutation is a silent no-op and the control stops
    being evidence with nobody having touched it. That has happened twice.

    The second entry is used, not the first, so only the descending-order rung
    fires -- bumping the head would also break head-vs-VERSION and the case
    would no longer isolate the rule it names. Returning the text unchanged
    when there is no second entry is correct: the harness already rejects a
    no-op mutation loudly.
    """
    headings = list(re.finditer(r"(?m)^## (\d+)\.(\d+)\.(\d+) ", text))
    if len(headings) < 2:
        return text
    head = tuple(int(g) for g in headings[0].groups())
    second = headings[1]
    bumped = f"## {head[0] + 1}.0.0 "
    return text[: second.start()] + bumped + text[second.end() :]


def sub_json_route(key: str, new_route: str):
    """Point one registry shortcut row at a different destination.

    The registry is JSON, so a prose `replace` cannot touch it. Mutating a
    route (e.g. `cc` -> `saipen goal`) must leave CORE.md's prose untouched so
    the registry-vs-prose check -- and every consumer of the registry -- fires.
    """

    def _mutate(text: str) -> str:
        import json as _json

        data = _json.loads(text)
        data["shortcuts"][key] = new_route
        return _json.dumps(data, indent=2, ensure_ascii=False)

    return _mutate


def leak_style_marker(text: str) -> str:
    """Copy STYLE.md's live marker into whichever doc is being mutated.

    Read from the pristine tree at mutation time rather than hardcoded: a
    control that pins the token would have to be re-typed on every STYLE.md
    edit, and a stale pin makes the mutation a no-op -- the one failure the
    no-op guard exists to catch.
    """
    style = (HOME / "saipen" / "STYLE.md").read_text(encoding="utf-8-sig")
    found = re.search(r"`style_contract:\s*(ded-[0-9a-f]{8})`", style)
    return text if not found else f"{text}\n<!-- {found.group(1)} -->\n"


UTF16 = "<rewrite as utf-16>"  # sentinel, not a mutation function
DELETE = "<delete the file>"
SYMLINK_EXTERNAL = "<replace with an external symlink>"


def strip_done_verify(text: str) -> str:
    """T-431: take the evidence off the first ## DONE ticket, keep the ticket.

    The ticket still claims completion, exactly as it did before -- only the
    proof is gone, which was legal until this check existed. Written against
    the board's structure rather than one ticket's wording so the control
    survives every ## DONE prune.
    """
    out, section, done_once = [], "", False
    for line in text.splitlines():
        stripped = line
        if line.startswith("## "):
            section = line.strip()
        elif (
            section == "## DONE"
            and not done_once
            and line.startswith("- [x] T-")
            and " | verify:" in line
        ):
            stripped = re.sub(r" \| verify:.*$", "", line)
            done_once = True
        out.append(stripped)
    return "\n".join(out) + "\n"


def cite_open_ticket(text: str) -> str:
    """T-431: repoint a shipped CONFORMANCE row at a ticket still unfinished
    (## TODO or ## BLOCKED -- the validator treats any non-DONE/non-DOING
    ticket as unfinished).

    The open ticket is read out of the pristine board at mutation time, the
    same way leak_style_marker reads STYLE.md's live marker: a hardcoded ID
    would go stale into a silent no-op the moment the board moved on.
    """
    board = (HOME / ".saipen" / "BOARD.md").read_text(encoding="utf-8-sig")
    open_ticket = re.search(r"^- \[ \] (T-\d+)", board, re.MULTILINE)
    if not open_ticket:
        return text
    return re.sub(r"\(T-\d+\)", f"({open_ticket.group(1)})", text, count=1)


def stamp_log_ahead(text: str) -> str:
    """T-432: restamp the newest LOG entry 7 minutes ahead of the real clock.

    Computed at mutation time, never hardcoded: a pinned date drifts into the
    past and the control silently stops proving anything -- the same no-op
    trap leak_style_marker was written to avoid. The persisted stamp has only
    minute precision: +6 minutes can become less than the validator's +5m
    bound while the validator runs near a minute rollover. +7 guarantees one
    full minute of execution margin while still testing the bound rather than
    some obviously-absurd year.
    """
    ahead = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=7)
    lines = text.splitlines()
    for i in range(len(lines) - 1, -1, -1):
        if re.match(r"^- \d{2}\.\d{2}\.\d{2} \d{2}:\d{2} \[E-\d+\]", lines[i]):
            lines[i] = re.sub(
                r"^- \d{2}\.\d{2}\.\d{2} \d{2}:\d{2} ",
                "- " + ahead.strftime("%d.%m.%y %H:%M") + " ",
                lines[i],
            )
            break
    return "\n".join(lines) + "\n"


def demote_the_pick(text: str) -> str:
    """T-474: reach the topmost-workable branch from any board state.

    The pick check compares `next_action` against the topmost workable
    `## TODO` ticket ONLY when nothing is claimed -- a `## DOING` ticket IS
    the pick (T-466) -- so the mutation must both empty `## DOING` AND
    arrange the TODO mismatch. Inject two synthetic workable tickets: T-999
    at the top of `## TODO` (always the topmost workable) and T-998 at the
    bottom (so the case's STATE mutation can name a workable ticket that is
    never topmost). The mismatch holds whatever the real board and real
    STATE hold -- the old "demote the ticket next_action names" went vacuous
    three times: once with a single workable ticket, once with a DONE-state
    non-ticket next_action, and once on a ship commit whose own ticket sat
    in `## DOING` (T-532, T-534).
    """
    nl = chr(10)
    doing = re.search(r"^## DOING$\n(.*?)(?=^## |\Z)", text, re.MULTILINE | re.DOTALL)
    if doing is not None:
        body = doing.group(1)
        if body.strip():
            cleaned = "\n".join(ln for ln in body.splitlines() if not ln.strip().startswith("- ["))
            text = text[: doing.start(1)] + cleaned + text[doing.end(1) :]
    todo = re.search(r"^## TODO$\n(.*?)(?=^## |\Z)", text, re.MULTILINE | re.DOTALL)
    if todo is None:
        return text
    top = "- [ ] T-999 [P3] synthetic red-control workable ticket\n"
    bottom = "- [ ] T-998 [P3] synthetic red-control workable ticket\n"
    return (
        text[: todo.start(1)]
        + top
        + todo.group(1).rstrip(nl)
        + nl
        + bottom
        + nl
        + text[todo.end(1) :]
    )


def move_blocker_ticket_to_todo(text: str) -> str:
    """Reproduce T-576's unjournaled BLOCKED -> TODO drift byte-for-byte."""
    lines = text.splitlines()
    section = ""
    blocked_index = None
    ticket_line = None
    todo_index = None
    for index, line in enumerate(lines):
        if line.startswith("## "):
            section = line
            if line == "## TODO":
                todo_index = index
            continue
        if section == "## BLOCKED" and line.startswith("- [ ] T-") and " | blocker:" in line:
            blocked_index = index
            ticket_line = line
            break
    if blocked_index is None or ticket_line is None or todo_index is None:
        return text
    del lines[blocked_index]
    lines.insert(todo_index + 1, ticket_line)
    return "\n".join(lines) + "\n"


def add_blocker_to_doing(text: str) -> str:
    """Make the active ticket claim work while carrying blocked status."""
    # SYNTHETIC ANCHOR: the harness must not depend on a live ## DOING ticket
    # existing -- a board between tickets has none (observed after T-630/T-632/
    # T-633 closed). Same pattern as inject_unclaimed_doing (T-573): build the
    # DOING line to mutate first, then add the blocker to it.
    doing = re.search(r"^## DOING$\n(.*?)(?=^## |\Z)", text, re.MULTILINE | re.DOTALL)
    if doing is None:
        return text
    body = doing.group(1)
    if not re.search(r"^- \[/\] T-\d+ .*? \| verify:", body, re.MULTILINE):
        nl = chr(10)
        cleaned = "\n".join(ln for ln in body.splitlines() if not ln.strip().startswith("- ["))
        if cleaned.strip():
            cleaned += nl
        text = (
            text[: doing.start(1)]
            + cleaned
            + "- [/] T-999 audit | verify: probe\n"
            + text[doing.end(1) :]
        )
    return re.sub(
        r"^(- \[/\] T-\d+ .*?)( \| verify:)",
        r"\1 | blocker: WAIT_USER_CONFIRMATION\2",
        text,
        count=1,
        flags=re.MULTILINE,
    )


def remove_blocker_from_blocked(text: str) -> str:
    """Leave a ticket in BLOCKED while deleting its active reason."""
    lines = text.splitlines()
    section = ""
    for index, line in enumerate(lines):
        if line.startswith("## "):
            section = line
            continue
        if section == "## BLOCKED" and line.startswith("- [ ] T-") and " | blocker:" in line:
            lines[index] = re.sub(r" \| blocker:.*$", "", line)
            return "\n".join(lines) + "\n"
    return text


def inject_unclaimed_doing(text: str) -> str:
    """T-573: put an unclaimed ticket in ## DOING whatever the live board holds.

    An ownerless ## DOING ticket is 'unclaimed by definition' (RFC § 1.4), so
    STATE.task: none beside it is the BOARD-ahead-of-STATE interruption. The
    first version of this case mutated STATE.task alone and went dead the
    moment a checkpoint moved the live phase to DONE (its task line was
    already `none`), which is exactly the live-state dependence the synthetic
    tickets in this harness exist to remove.
    """
    nl = chr(10)
    doing = re.search(r"^## DOING$\n(.*?)(?=^## |\Z)", text, re.MULTILINE | re.DOTALL)
    if doing is None:
        return text
    body = doing.group(1)
    if "- [/] T-999 audit" in body:
        return text
    cleaned = "\n".join(ln for ln in body.splitlines() if not ln.strip().startswith("- ["))
    if cleaned.strip():
        cleaned += nl
    return (
        text[: doing.start(1)]
        + cleaned
        + "- [/] T-999 audit | verify: probe\n"
        + text[doing.end(1) :]
    )


CREATE = "<create the file>"
SWAP = "<swap the last two log entries>"


def write_new(content: str):
    """A mutation that CREATES the file rather than editing it.

    Three markhunt cases skipped because this repository has no live manifest,
    and a case that skips on the machine where it matters is barely better than
    one that never fires.
    """
    return ("WRITE", content)


def case_target(root: Path, rel: str, mutation) -> Path:
    """Return the physical file a logical mutation will edit.

    LOG chronology spans sealed segments plus the active tail. Immediately
    after a normal seal the active file has no event pair to swap, so the
    backwards-ID mutation must walk to the newest segment that does. Both
    runners call this before saving bytes, and apply_case calls it again,
    keeping mutation and restoration on the same file.
    """
    default = root / rel
    if mutation != SWAP:
        return default
    candidates = [default]
    candidates.extend(reversed(sorted((root / ".saipen" / "logs").glob("LOG-*.md"))))
    for candidate in candidates:
        if not candidate.is_file():
            continue
        lines = candidate.read_text(encoding="utf-8-sig", errors="replace").splitlines()
        if sum(line.startswith("- ") for line in lines) >= 2:
            return candidate
    return default


def mutation_files(root: Path, rel: str, mutation) -> list[Path]:
    """Every physical file a logical mutation will edit, for save/restore."""
    if isinstance(mutation, tuple) and mutation and mutation[0] == "MULTI":
        return [root / r for r, _ in mutation[1]]
    return [case_target(root, rel, mutation)]


def restore_case_files(saved: list[tuple[Path, bytes | None]]) -> None:
    """Restore mutation targets without following a special node.

    Ordinary byte rewrites can overwrite in place.  A symlink mutation must
    first remove the link itself; writing through it would restore the
    external target and leave the mutated authority node in the pristine
    audit copy.
    """
    for path, data in saved:
        if path.is_symlink():
            path.unlink()
        if data is None:
            if os.path.lexists(path):
                path.unlink()
        else:
            path.write_bytes(data)


def _member_creates(mutation) -> bool:
    """Does this MULTI member bring its own file into existence?"""
    return mutation == CREATE or (isinstance(mutation, tuple) and mutation[0] == "WRITE")


def case_available(root: Path, rel: str, mutation) -> bool:
    if _member_creates(mutation):
        return True
    if isinstance(mutation, tuple) and mutation and mutation[0] == "MULTI":
        # T-1270: a red condition can need a file the pristine tree does not
        # have -- an unconsumed `audit/1.md` is the whole point of the audit
        # route control. A creating member supplies its own file, so
        # requiring every member to pre-exist made that condition
        # inexpressible rather than unsafe.
        return all(
            (root / r).is_file() or _member_creates(fn) for r, fn in mutation[1]
        )
    target = case_target(root, rel, mutation)
    if not target.is_file():
        return False
    if mutation != SWAP:
        return True
    lines = target.read_text(encoding="utf-8-sig", errors="replace").splitlines()
    return sum(line.startswith("- ") for line in lines) >= 2


def _t551_bypass(t: str) -> str:
    """Reconstruct BOTH halves of the T-549/T-551 liveness condition.

    The barrier binds only while the improve wave is live; CLEAN prunes its
    tickets, so stripping T-551's `needs:` alone no-ops on a cleaned board
    and the control silently stopped being evidence. Strip what exists, and
    when T-551 is absent entirely, reinsert an OPEN, dependency-free T-551
    under `## TODO` so the reopened-T-549 condition is testable again.
    """
    t = t.replace(" | needs: T-549 | verify:", " | verify:", 1)
    t = t.replace("- [x] T-549 [P1]", "- [ ] T-549 [P1]", 1)
    if re.search(r"(?m)^- \[[ /x]\] T-551\b", t):
        return t
    lines = t.splitlines(keepends=True)
    todo_i = next((i for i, ln in enumerate(lines) if ln.strip() == "## TODO"), None)
    if todo_i is None:
        return t
    next_h = next(
        (j for j in range(todo_i + 1, len(lines)) if lines[j].startswith("## ")),
        len(lines),
    )
    stub = "- [ ] T-551 [P2] Real Improve cycle #1 (IMP-002) integration\n"
    return "".join(lines[:next_h]) + stub + "".join(lines[next_h:])


# (label, file, mutation, expected substring in the validator's output)
def add_state_field(line: str):
    """Insert one frontmatter line before the closing fence."""

    def mutate(text: str) -> str:
        marker = "\n---\n"
        index = text.rfind(marker)
        if index == -1:
            return text
        # T-1359: this used to slice `text[index + 1 :]`, which ate the newline
        # that separates the inserted field from the closing fence and produced
        # `stop_reason: X---`. The validator then FAILed on a missing fence --
        # a shape no case expects -- so the control read dead while the check it
        # names was alive. Invisible until audit_checks stopped returning at its
        # first failing probe.
        return text[:index] + "\n" + line + text[index:]

    return mutate


def unblock_parked_work(text: str) -> str:
    """File every `## BLOCKED` record back into `## TODO` as workable Work.

    The audit route is correctly silent when the layer it routes binds a
    ticket nobody can work, and this repository's inbox routes one that is
    parked -- so the control that exists to prove the route is followed ran
    green for every session, on a condition it never reached (T-1359). Derived
    from section headers alone: no ticket id, nothing to rot.
    """
    lines = text.splitlines(keepends=True)
    try:
        blocked = next(i for i, line in enumerate(lines) if line.startswith("## BLOCKED"))
    except StopIteration:
        return text
    end = next(
        (i for i in range(blocked + 1, len(lines)) if lines[i].startswith("## ")), len(lines)
    )
    parked = [i for i in range(blocked + 1, end) if lines[i].startswith("- [")]
    if not parked:
        return text
    moved = [
        re.sub(r"\s*\|\s*(blocked|owner|claim_time):\s*[^|\n]*", "", lines[i].rstrip("\n"))
        .replace("- [!]", "- [ ]", 1)
        .replace("- [/]", "- [ ]", 1)
        + "\n"
        for i in parked
    ]
    for index in reversed(parked):
        lines.pop(index)
    todo = next(i for i, line in enumerate(lines) if line.startswith("## TODO"))
    lines[todo + 1 : todo + 1] = moved
    return "".join(lines)


def release_claimed_work(text: str) -> str:
    """Empty `## DOING` by filing its claimed ticket back into `## TODO`.

    Derived from the board it is handed: no ticket id appears here, so a
    control that needs an unclaimed board does not rot the next time the
    board moves (T-1359).
    """
    lines = text.splitlines(keepends=True)
    try:
        doing = next(i for i, line in enumerate(lines) if line.startswith("## DOING"))
        todo = next(i for i, line in enumerate(lines) if line.startswith("## TODO"))
    except StopIteration:
        return text
    claimed = [i for i in range(doing + 1, todo) if lines[i].startswith("- [")]
    if not claimed:
        return text
    moved = [
        re.sub(r"\s*\|\s*(owner|claim_time):\s*[^|\n]*", "", lines[i].rstrip("\n")).replace(
            "- [/]", "- [ ]", 1
        )
        + "\n"
        for i in claimed
    ]
    for index in reversed(claimed):
        lines.pop(index)
    todo = next(i for i, line in enumerate(lines) if line.startswith("## TODO"))
    lines[todo + 1 : todo + 1] = moved
    return "".join(lines)


def inherit_from_nothing(text: str) -> str:
    """Make the first DONE ticket claim an unresolvable implementation source."""
    lines = text.splitlines(keepends=True)
    in_done = False
    for i, line in enumerate(lines):
        if line.startswith("## "):
            in_done = line.startswith("## DONE")
            continue
        if in_done and line.startswith("- [x] "):
            # T-1359: DONE records now carry `closure_mode: own_patch`, so
            # APPENDING a second one made the BOARD unparsable and the parse
            # error pre-empted the check this case exists to drive. Replace the
            # field the record already has instead of adding a rival copy.
            body = re.sub(r"\s*\|\s*closure_mode:\s*[^|\n]*", "", line.rstrip("\n"))
            lines[i] = (
                body
                + " | closure_mode: inherited_verified"
                + " | implementation_delta: none"
                + " | implementation_source: T-99999999"
                + "\n"
            )
            break
    return "".join(lines)


CASES: list[tuple[str, str, object, str]] = [
    # --- STATE shape -----------------------------------------------------
    ("STATE.md deleted", STATE, DELETE, "STATE.md missing"),
    ("STATE.md is UTF-16", STATE, UTF16, "not plain UTF-8"),
    (
        "portable project identity becomes an external symlink",
        IDENTITY,
        SYMLINK_EXTERNAL,
        "IDENTITY.md is a symlink, reparse point, or non-regular file",
    ),
    (
        "portable project identity exceeds the bounded authority read",
        IDENTITY,
        (
            "WRITE",
            "---\nproject_lineage: lineage-" + "a" * 32 + "\n" + "\n" * 4096 + "---\n",
        ),
        "descriptor-bound no-follow reader",
    ),
    ("phase not in the enum", STATE, sub_line("phase", "REFACTOR"), "not one of"),
    ("mode not in the enum", STATE, sub_line("mode", "yolo"), "field mode"),
    ("transition_from dropped", STATE, drop_line("transition_from"), "missing transition_from"),
    (
        "illegal transition",
        STATE,
        lambda t: sub_line("phase", "SHIP")(sub_line("transition_from", "INIT")(t)),
        "invalid phase transition",
    ),
    ("updated not UTC", STATE, sub_line("updated", "2026-07-30 10:00"), "must be ISO-8601 UTC"),
    ("schema_version from the future", STATE, sub_line("schema_version", "99"), "only understands"),
    (
        "current schema revision metadata missing",
        STATE_SCHEMA,
        replace('  "x-current-schema-version": 3,\n', ""),
        "x-current-schema-version must be a positive integer",
    ),
    # T-565. `minimum` sat on four STATE fields while nothing interpreted it,
    # so a negative safety-valve counter read as valid: `goal_waves: -1` means
    # § 2.4's three-wave ceiling is four waves away, and the valve protects the
    # long unattended runs least able to notice. One control per floor the
    # schema states, because they are four independent claims -- a fix that
    # restored only the counters would leave the two LOG/format markers open.
    (
        "negative goal_waves passes the schema floor",
        STATE,
        lambda s: force_goal(s, "goal_waves: -1\ngoal_tickets: 0"),
        "goal_waves: -1 is below the schema minimum 0",
    ),
    (
        "negative goal_tickets passes the schema floor",
        STATE,
        lambda s: force_goal(s, "goal_waves: 0\ngoal_tickets: -1"),
        "goal_tickets: -1 is below the schema minimum 0",
    ),
    (
        "schema_version below its own floor",
        STATE,
        sub_line("schema_version", "0"),
        "schema_version: 0 is below the schema minimum 1",
    ),
    (
        "last_event claims an event number that cannot exist",
        STATE,
        sub_line("last_event", "0"),
        "last_event: 0 is below the schema minimum 1",
    ),
    # The class control, not an instance of it: a keyword added to the schema
    # with no enforcer used to be a silent no-op, which is why `minimum` could
    # sit there through four releases. `exclusiveMinimum` is a real draft-07
    # keyword this validator does not implement -- the audit must say so rather
    # than let the schema believe it constrains something.
    (
        "schema keyword with no enforcer is silently ignored",
        STATE_SCHEMA,
        replace(
            '"goal_waves": {\n      "type": "integer",\n      "minimum": 0,',
            '"goal_waves": {\n      "type": "integer",\n'
            '      "exclusiveMinimum": -5,\n      "minimum": 0,',
        ),
        "'exclusiveMinimum' on field goal_waves that tools/validate.py does not interpret",
    ),
    # The second half of the same guarantee: `type` has an enforcer, but that
    # enforcer knows four of JSON Schema's seven types. A schema declaring
    # `type: number` would clear the keyword audit and still be interpreted by
    # nobody, which is the exact shape `minimum` had.
    (
        "schema type outside the interpreted set",
        STATE_SCHEMA,
        replace(
            '"saipen_version": {\n      "type": "integer"',
            '"saipen_version": {\n      "type": "number"',
        ),
        "'type: number' on field saipen_version",
    ),
    # Array element types. `requires:` is § 1.3's capability handshake, and the
    # vocabulary WARN below it skips non-strings silently, so a wrong-typed
    # element was invisible at both rungs.
    (
        "requires carries a non-string capability",
        STATE,
        replace("  - filesystem\n", "  - 12345\n"),
        "requires[0]: expected string",
    ),
    (
        "current-schema state missing last_event",
        STATE,
        drop_line("last_event"),
        "requires last_event",
    ),
    (
        "current-schema state missing style_contract",
        STATE,
        drop_line("style_contract"),
        "requires style_contract",
    ),
    (
        "style_contract names a different voice contract",
        STATE,
        sub_line("style_contract", "ded-deadbeef"),
        "did not read the current voice contract",
    ),
    # T-573: STATE.task and ## DOING are one binding. The v7.215.0 crash
    # checkpoint claimed task T-572 while no ## DOING ticket existed and
    # T-572 sat in ## TODO -- validator-conformant until this rule. Both
    # interruption directions go red. The mutations force the crash shape
    # whatever the live state holds (the first versions mutated STATE alone
    # and went dead when a checkpoint moved the live phase to DONE): a task
    # naming a ticket the board does not claim, and an unclaimed ## DOING
    # ticket the state does not name.
    (
        "active task not claimed by ## DOING",
        STATE,
        lambda s: sub_line("task", "T-999")(sub_line("phase", "SCOUT")(s)),
        "is not the claimed ## DOING ticket",
    ),
    (
        "self-claimed ## DOING ticket with task: none",
        STATE,
        (
            "MULTI",
            [
                (STATE, lambda s: sub_line("task", "none")(sub_line("phase", "SCOUT")(s))),
                (BOARD, inject_unclaimed_doing),
            ],
        ),
        "STATE is behind BOARD",
    ),
    # CORE-001 (SRC-026:R001). The execution seat and the BOARD claim are ONE
    # fact. E-5941 committed `STATE.task=T-1298, STATE.agent=buffy` against a
    # BOARD whose active ticket was still owned by `opencode`, because the
    # transactional gate had no owner invariant at all -- only this canonical
    # gate refused it, and only later, at a release boundary. The control
    # rewrites STATE.agent alone: BOARD keeps the real owner, so the pair is
    # exactly the split the invariant exists to refuse.
    (
        "STATE.agent stops being the active BOARD owner",
        STATE,
        sub_line("agent", "seat-thief"),
        "is not the owner of the active ticket",
    ),
    # CORE-003 (SRC-026:R003). A stop reason is an instruction to an
    # unattended loop, so it must be TRUE while it is persisted. GOAL_BLOCKED
    # says "no safe useful work remains"; recorded beside workable Work it
    # parks a run that had things to do -- which is the FastPrompter stall in
    # one field.
    (
        "GOAL_BLOCKED persisted while the board still has workable Work",
        STATE,
        add_state_field("stop_reason: GOAL_BLOCKED"),
        "stop_reason: GOAL_BLOCKED while the board still",
    ),
    # CORE-003. `inherited_verified` is the closure that adds no code, so its
    # named authority is the ONLY thing standing between "verified" and
    # "nobody ever published this". An authority that resolves to nothing must
    # FAIL, not read as a closed ticket.
    (
        "DONE Work inherits from an authority that does not exist",
        BOARD,
        inherit_from_nothing,
        "closure provenance does not resolve",
    ),
    # The changelog-unarchived warning names the header's "~10" claim as its
    # reason; a header edited to a looser number would silently make that
    # warning a lie, so the exact archive pointer is a FAIL, not a WARN.
    (
        "changelog archive pointer loosened",
        CHANGELOG,
        replace("keeps the most recent ~10.", "keeps the most recent ~50."),
        "changelog-archive-pointer",
    ),
    # T-571: `saipen crew` carries exactly one execution meaning. A crew row
    # that gains a concurrent reading, or a gated backlog that reuses the
    # `saipen crew` name for the concurrent design, is the ambiguity a weak
    # model resolves wrongly while believing it followed SAIPEN.
    (
        "crew command row loses its single-meaning statement",
        CORE,
        replace("exactly one execution meaning", "a meaning that may include concurrency"),
        "crew-naming",
    ),
    (
        "concurrent backlog reuses the crew command name",
        CREW_BACKLOG,
        lambda t: t.replace("`saipen concurrent`", "`saipen crew`"),
        "crew-naming",
    ),
    (
        "live board reintroduces the pre-T-571 Crew Mode name",
        BOARD,
        replace("v8 Concurrent Mode", "v8 Crew Mode"),
        "crew-naming",
    ),
    # T-551/T-555: a seat report that leaks a machine-local saipen_home path
    # into its identity is rejected; the manifest is routing-only and may not
    # duplicate report status.
    (
        "improve report leaks a machine-local saipen_home path",
        IMPROVE_REPORT,
        write_new("saipen_home: V:/machine/local/path\nreport_status: draft\n"),
        "saipen_home path in its header",
    ),
    (
        "improve cycle manifest duplicates report status",
        IMPROVE_MANIFEST,
        write_new("cycle_id: imp-key-20260808\nstatus: complete\n"),
        "owns routing only",
    ),
    # T-552: Improve is a meta-control; a phases/improve.md file is an
    # unofficial seventeenth phase and must fail.
    ("improve becomes an unofficial phase", PHASE_IMPROVE, CREATE, "improve-meta-control"),
    # T-553: improve routing/status is DERIVED from the manifest + reports +
    # sweep ledger, never carried in STATE.md. Finding text and independent
    # improve_* counters in STATE are both the drift the derived model forbids.
    (
        "STATE carries an independent improve_ routing field",
        STATE,
        lambda t: re.sub(
            r"(?m)^(blocker:.*)$",
            r"\1\nimprove_cycle: imp-x",
            t,
            count=1,
        ),
        "improve-state-purity",
    ),
    (
        "STATE carries finding text",
        STATE,
        lambda t: (
            t.rstrip() + "\n\nIMP-001 [P1] [LOGIC_ERROR] [proven] "
            "[ticket]\nexpected: x\nactual: y\nevidence: z\n"
        ),
        "improve-state-purity",
    ),
    # T-622: CORE, IMPROVE and the CLI carry one exact public action set.
    (
        "CORE Improve declaration loses cycle-complete",
        CORE,
        lambda t: t.replace(", cycle-complete,", ","),
        "improve-command-parity",
    ),
    (
        "IMPROVE declaration loses submit",
        IMPROVE,
        lambda t: t.replace("bare, status, submit,", "bare, status,"),
        "improve-command-parity",
    ),
    (
        "Improve CLI gains an undeclared action",
        "tools/saipen.py",
        lambda t: t.replace(
            '    if action == "clean":',
            '    if action == "extra":\n        return 0\n    if action == "clean":',
        ),
        "improve-command-parity",
    ),
    (
        "nested success decoy launders a declared action",
        CORE,
        (
            "MULTI",
            [
                (CORE, lambda t: t.replace("abort, clean]", "abort, extra, clean]")),
                (IMPROVE, lambda t: t.replace("abort, clean]", "abort, extra, clean]")),
                (
                    "tools/saipen.py",
                    lambda t: t.replace(
                        '    if action == "clean":',
                        '    if action == "extra":\n'
                        "        def decoy():\n"
                        "            return 0\n"
                        "        return 2\n"
                        '    if action == "clean":',
                    ),
                ),
            ],
        ),
        "improve-command-parity",
    ),
    (
        "constant-false success decoy launders a declared action",
        CORE,
        (
            "MULTI",
            [
                (CORE, lambda t: t.replace("abort, clean]", "abort, extra, clean]")),
                (IMPROVE, lambda t: t.replace("abort, clean]", "abort, extra, clean]")),
                (
                    "tools/saipen.py",
                    lambda t: t.replace(
                        '    if action == "clean":',
                        '    if action == "extra":\n'
                        "        if False:\n"
                        "            return 0\n"
                        "        return 2\n"
                        '    if action == "clean":',
                    ),
                ),
            ],
        ),
        "improve-command-parity",
    ),
    (
        "Improve CLI loses the verify executor",
        "tools/saipen.py",
        lambda t: t.replace('action == "verify"', 'action == "verifx"'),
        "improve-command-parity",
    ),
    # T-623: role/session identity, atomic admission, per-seat status and the
    # narrow contention boundary remain continuously red-testable.
    (
        "CORE loses exact Improve session routing",
        CORE,
        lambda t: t.replace(
            "`--session <seat_id>` alone resumes one exact seat",
            "sessions may resume a nearby seat",
        ),
        "improve-admission-contract",
    ),
    (
        "IMPROVE opens its role vocabulary",
        IMPROVE,
        lambda t: t.replace(
            "`--role core|critic` selects the closed role", "`--role <name>` selects a role"
        ),
        "improve-admission-contract",
    ),
    (
        "Improve CLI drops explicit role parsing",
        "tools/saipen.py",
        lambda t: t.replace('rest[0] == "--role"', 'rest[0] == "--rolx"'),
        "improve-admission-contract",
    ),
    (
        "Improve admission drops the project writer lock",
        "tools/improve.py",
        lambda t: t.replace(
            "with project_writer_lock(root):", "with project_writer_lock(root.parent):"
        ),
        "improve-admission-contract",
    ),
    (
        "Improve admission journals only the report target",
        "tools/improve.py",
        lambda t: t.replace(
            "            targets,\n            preconditions=preconditions,",
            "            targets[-1:],\n            preconditions=preconditions,",
        ),
        "improve-admission-contract",
    ),
    (
        "Improve public boundary swallows programming errors",
        "tools/saipen.py",
        lambda t: t.replace("except PermissionError as exc:", "except Exception as exc:"),
        "improve-admission-contract",
    ),
    (
        "Improve status loses roster/report role comparison",
        "tools/saipen.py",
        lambda t: t.replace("report_role != roster_role", "False"),
        "improve-admission-contract",
    ),
    (
        "Improve sweep queue drops seat-qualified report identity",
        "tools/saipen.py",
        lambda t: t.replace('"report": f"{seat_id}/{report_ident}"', '"report": report_ident'),
        "improve-admission-contract",
    ),
    (
        "Improve status lets one basename disposition cover every seat",
        "tools/improve.py",
        lambda t: t.replace("if r.report in ledger_keys", "if r.report == report_ident"),
        "improve-admission-contract",
    ),
    (
        "Improve admission reinterprets an existing bare SWEEP identity",
        "tools/improve.py",
        lambda t: t.replace("record.report == report_ident", "False"),
        "improve-admission-contract",
    ),
    (
        "Improve status guesses first owner for an ambiguous basename",
        "tools/improve.py",
        lambda t: t.replace("if len(owners) > 1:", "if False:"),
        "improve-admission-contract",
    ),
    (
        "improve clean route loses its never-CLEAN statement",
        CORE,
        lambda t: t.replace("never enters the CLEAN phase", "may archive reports"),
        "improve-command-family",
    ),
    (
        "improve loses the writer boundary",
        IMPROVE,
        lambda t: t.replace("writes only inside its own home", "may write anywhere it likes"),
        "improve-boundary",
    ),
    (
        "improve verify stops being delta-only",
        IMPROVE,
        lambda t: t.replace("delta-only", "full-audit"),
        "improve-boundary",
    ),
    # T-555: a seat report is mechanically checkable -- a finding without the
    # expected/actual/evidence triple, a complete report over an unmet
    # completion bar, and a partial scope claiming full context all fail.
    (
        "improve report finding lacks the evidence triple",
        IMPROVE_REPORT,
        write_new(
            "report_status: draft\ncontext_scope: tools/\n"
            "context_available: partial\n\n"
            "IMP-001 [P1] [LOGIC_ERROR] [observed] [ticket]\n"
            "expected: x\nactual: y\n"
        ),
        "improve report [improve-report]",
    ),
    (
        "improve report complete over an unmet completion bar",
        IMPROVE_REPORT,
        write_new("report_status: complete\n"),
        "improve report [improve-report]",
    ),
    (
        "improve report partial scope claims full context",
        IMPROVE_REPORT,
        write_new(
            "report_status: draft\ncontext_scope: partial: tools only\n"
            "context_available: complete\n\n"
            "IMP-001 [P1] [LOGIC_ERROR] [observed] [ticket]\n"
            "expected: x\nactual: y\nevidence: z\n"
        ),
        "improve report [improve-report]",
    ),
    # T-622: exact ordered five-level proof contract, including assignment.
    (
        "SAICRITIC drops PROVENANCE",
        "saipen/SAICRITIC.md",
        lambda t: t.replace(
            "| PROVENANCE | does the evidence bind the exact source, session, "
            "run, finding and result it claims? |\n",
            "",
        ),
        "saicritic",
    ),
    (
        "SAICRITIC swaps GATE and PROVENANCE",
        "saipen/SAICRITIC.md",
        lambda t: t.replace(
            "| GATE | did the REQUIRED semantic/protocol gates actually occur? |\n"
            "| PROVENANCE | does the evidence bind the exact source, session, "
            "run, finding and result it claims? |",
            "| PROVENANCE | does the evidence bind the exact source, session, "
            "run, finding and result it claims? |\n"
            "| GATE | did the REQUIRED semantic/protocol gates actually occur? |",
        ),
        "saicritic",
    ),
    (
        "SAICRITIC duplicates UNIT",
        "saipen/SAICRITIC.md",
        lambda t: t.replace(
            "| UNIT | is the operation locally correct? |",
            "| UNIT | is the operation locally correct? |\n"
            "| UNIT | is the operation locally correct? |",
        ),
        "saicritic",
    ),
    (
        "Improve assignment omits canonical PROVENANCE",
        "tools/saipen.py",
        lambda t: t.replace(
            "proof_levels = _canonical_proof_levels()",
            "proof_levels = _canonical_proof_levels()[:-1]",
        ),
        "saicritic-assignment",
    ),
    (
        "Improve assignment emits a sliced decoy",
        "tools/saipen.py",
        lambda t: t.replace('"proof_levels": proof_levels,', '"proof_levels": proof_levels[:-1],'),
        "saicritic-assignment",
    ),
    (
        "Improve assignment rebinds canonical proof levels",
        "tools/saipen.py",
        lambda t: t.replace(
            "proof_levels = _canonical_proof_levels()",
            "proof_levels = _canonical_proof_levels()\n"
            "            proof_levels = proof_levels[:-1]",
        ),
        "saicritic-assignment",
    ),
    (
        "dead proof assignment launders reachable sliced output",
        "tools/saipen.py",
        lambda t: t.replace(
            "proof_levels = _canonical_proof_levels()",
            "actual_levels = _canonical_proof_levels()[:-1]\n"
            "            if False:\n"
            "                proof_levels = _canonical_proof_levels()\n"
            '                _emit({"code": "IMPROVE_AUDIT_ASSIGNMENT", '
            '"proof_levels": proof_levels}, as_json)',
        ).replace('"proof_levels": proof_levels,', '"proof_levels": actual_levels,'),
        "saicritic-assignment",
    ),
    (
        "INDEX stops routing to SAICRITIC",
        INDEX,
        lambda t: t.replace("- `SAICRITIC.md`:", "- `SAICRITICX.md`:"),
        "saicritic-reachability",
    ),
    (
        "manifest stops installing SAICRITIC",
        "saipen/MANIFEST.json",
        # T-1359: the anchor was one pretty-printed JSON line, so reformatting
        # the manifest silently disarmed the control. Rename the source path
        # instead: it survives any layout the file is written in.
        lambda t: t.replace('"saipen/SAICRITIC.md"', '"saipen/SAICRITIC-UNINSTALLED.md"'),
        "saicritic-reachability",
    ),
    # T-607: the SubSaipen write boundary is continuously mechanical -- a sub
    # STATE that names a main-project canonical file outside a boundary
    # comment is a violation.
    (
        "sub STATE targets a main-project canonical file",
        SUB,
        lambda t: t.replace("---\n", "---\ntask: T-999\n", 1).replace(
            "saipen_home", "apply_to_main: .saipen/BOARD.md\nsaipen_home", 1
        ),
        "sub-write-boundary",
    ),
    # NITRO: OPS.md is only reachable through INDEX. Drop the row and the doc
    # still ships, still validates its own text, and no cold agent ever finds
    # it -- the RFC routing trap in a new file.
    (
        "index stops routing to the OPS contract",
        INDEX,
        lambda t: t.replace("- `OPS.md`:", "- `OPSX.md`:"),
        "ops-owner",
    ),
    ("last_event below the log tail", STATE, sub_line("last_event", "1"), "lower than the log"),
    (
        # T-1359: the expectation named a message the validator stopped
        # printing when CORE-003 unified the router and the gate on ONE Pick
        # Rule -- `topmost workable ## TODO` is not what the selector computes
        # any more. The mutation still drives the right check red; only the
        # words it waited for had moved, so the control read dead while the
        # check was alive.
        "next_action picks a ticket the shared Pick Rule does not select",
        BOARD,
        (
            "MULTI",
            [(BOARD, demote_the_pick), (STATE, sub_line("next_action", '"PHASE SCOUT T-998"'))],
        ),
        "but the shared Pick Rule selects",
    ),
    (
        "T-576-style drift moves a blocker ticket under TODO",
        BOARD,
        move_blocker_ticket_to_todo,
        "carries | blocker: outside ## BLOCKED",
    ),
    (
        "a DOING ticket carries an active blocker",
        BOARD,
        add_blocker_to_doing,
        "carries | blocker: outside ## BLOCKED",
    ),
    (
        "a BLOCKED ticket loses its blocker",
        BOARD,
        remove_blocker_from_blocked,
        "sits under ## BLOCKED without a non-empty | blocker:",
    ),
    # A block-parked DONE state (phase DONE + transition_from a mid-flight
    # phase) is legal only while the active LOG's most recent ticket event is
    # a canonical `ticket block via SAIOPS` line. The live LOG tail is a
    # transition, not a block, so this mutation must FAIL on the transition
    # edge -- proving the exception cannot be forged by hand.
    (
        "block-parked DONE without a canonical block line",
        STATE,
        lambda t: sub_line("phase", "DONE")(sub_line("transition_from", "BUILD")(t)),
        "invalid phase transition",
    ),
    # A C0 byte is invisible in every reader and still changes what the code
    # means. Two `\1` backreferences in this file were literal `\x01` bytes,
    # so both verify_attempts controls substituted a SOH character for the
    # captured ticket line and scored green while testing nothing.
    (
        "a shipped tool carries an invisible control character",
        "tools/run_scenarios.py",
        lambda t: t.replace("\n# ", "\n# \x01", 1),
        "contains control character U+0001",
    ),
    (
        "next_action has no prefix",
        STATE,
        sub_line("next_action", '"finish the thing"'),
        "does not start with",
    ),
    # The category bounds what KIND of stop a WAIT is; nothing bounded what
    # followed it, so `next_action` became a scratchpad and the next agent
    # read the notes as a queue -- live on this repository, where a `user
    # brake` naming a ticket "for a future run" got that ticket scouted
    # instead of the brake honoured.
    (
        "a WAIT body carries a session report after the brake",
        STATE,
        sub_line(
            "next_action",
            '"WAIT: user brake -- hold for the user. Wiki package is ready '
            'and T-455 is still open for a future run."',
        ),
        "starts a second sentence",
    ),
    (
        "WAIT with no category",
        STATE,
        sub_line("next_action", '"WAIT: need more context"'),
        "WAIT with no category token",
    ),
    # `saipen hunt` was this case's undefined command until v7.148.0 defined
    # it. A red control whose example became legal stops being evidence, so it
    # names a verb the surface has no plans for instead of a near-miss.
    (
        "undefined saipen command",
        STATE,
        sub_line("next_action", '"saipen refactor"'),
        "does not define",
    ),
    (
        "question outside a WAIT",
        STATE,
        sub_line("next_action", '"RUN: ship it?"'),
        "asks a question outside",
    ),
    (
        "read-only in a writing phase",
        STATE,
        lambda t: sub_line("phase", "BUILD")(
            sub_line("mode", "read-only")(sub_line("transition_from", "SCOUT")(t))
        ),
        "MUST NOT enter",
    ),
    ("goal intent, counters absent", STATE, force_goal, "counter missing"),
    # Un-double the bootloader pointer's backslashes, exactly as commit
    # 4012bae did. This file's own frontmatter parser never sees it -- it
    # reads a YAML subset and ignores escapes -- so the mutation has to be
    # judged by the escaping rule, not by a parse.
    (
        "saipen_home backslashes stop being escaped",
        STATE,
        lambda t: t.replace(chr(92) * 2, chr(92)),
        "backslashes are not escaped",
    ),
    # `saipen plan <text>` and bare `saipen plan` are different commands; only
    # the bare one was ever written down, so a weak model answered a specific
    # instruction with four inventions of its own.
    (
        "plan with text loses its front-of-board rule",
        "saipen/phases/plan.md",
        replace("FRONT of `## TODO`", "front of the board"),
        "at the front of `## TODO`",
    ),
    (
        "last_event above the log tail",
        STATE,
        sub_line("last_event", "999999"),
        "higher than the log",
    ),
    # The counter STATE carries must survive being rebuilt from the LOG the
    # way § 1.5 Recovery rebuilds it. Mutating STATE alone leaves the log
    # untouched, so the two disagree exactly as they would after an untraced
    # goal resume reset. The harness copies the repo's own live STATE, whose
    # goal_tickets is produced by mechanical DEC lines that the rebuild replays
    # 1:1 -- so an injected value that happens to equal the replayed count
    # would NOT diverge and the case would silently stop being evidence (the
    # NITRO dogfood II lesson: a fixture tuned to a snapshot goes stale). Inject
    # a value far above any plausible replay (29, over the 3/20 caps' budget)
    # so the divergence is guaranteed: the rebuild can never reach 29 because
    # the safety valve would have tripped long before, and a replay that did
    # reach it would itself be a separate corruption.
    (
        "goal counter STATE cannot survive its own rebuild",
        STATE,
        lambda s: force_goal(s, "goal_waves: 1\ngoal_tickets: 29"),
        "newest goal marker rebuilds",
    ),
    # Scenario 7 (T-539): a clean HUNT under `execution_intent: converge` is
    # stage F/I of CONVERGE.md and MUST NOT enter ADD -- ADD is invention, the
    # one thing a converge run never does. The live LOG (sealed segments
    # included) already carries `hunt -> clean @HASH` markers, so flipping the
    # state to converge with next_action pointing at ADD must FAIL.
    (
        "converge clean-HUNT may not name ADD",
        STATE,
        lambda s: force_converge(s, '"PHASE ADD"'),
        "converge clean-HUNT marker present but next_action names ADD",
    ),
    # T-1268, Narrative Authority Leakage. A suppressor needs a control proving
    # it can still go red once its authorization no longer applies -- otherwise
    # "no warning" and "the warning was silenced" are the same observation, and
    # that is how the inversion check stayed dead for five weeks. Demoting the
    # compensating DEC from a record to a mention (the marker no longer BEGINS
    # the event text) must lose the amnesty and let the 16 documented
    # inversions report again. If this stops going red, the anchoring is gone.
    (
        "an amnesty demoted to prose stops suppressing",
        LOG,
        replace(
            "DEC: observed historical timestamp inversions",
            "DEC: a note about observed historical timestamp inversions",
        ),
        "timestamp moves backwards by",
    ),
    # T-### valve-wording: ANY safety-valve pause's resume key is `cc`, never
    # `saipen goal` -- `saipen goal` is the create/pivot command, a
    # substitution. A pause naming `saipen goal` FAILs for both goal and
    # converge intents.
    (
        "safety-valve pause names the goal-create key",
        STATE,
        lambda s: force_converge(
            s,
            "\"WAIT: safety valve reached (N waves / M tickets) -- run 'saipen goal' to continue\"",
        ),
        "safety-valve pause names the goal-create key",
    ),
    # Strip the final newline and the file stops mid-line. Nothing else in this
    # list reads a last byte, which is how the real one survived: every
    # mutation appended below landed INSIDE the last entry instead of after it,
    # and two of these cases quietly stopped being evidence.
    ("BOARD.md ends mid-line", BOARD, lambda t: t.rstrip("\r\n"), "end mid-line"),
    # Point a shortcut back at a phase name. The table promises each one lands
    # on a command § 1.10 defines; nothing read that column until v7.148.0,
    # and two rows had already stopped being true.
    (
        "shortcut routes to a phase, not a command",
        "saipen/CORE.md",
        replace("| `hh` | `saipen hunt` |", "| `hh` | HUNT |"),
        "do not resolve to a command",
    ),
    # Scenario 30: the old `cc` -> `saipen goal` mapping must fail validation.
    # `cc` is the continue/converge key and `gg` is the sole new-goal key; the
    # canonical table routes `cc` to `saipen continue`, and a regression back
    # to the duplicated-goal mapping is rejected by the route check.
    (
        "shortcut routes to a valid but wrong command",
        "saipen/CORE.md",
        replace("| `cc` | `saipen continue` |", "| `cc` | `saipen goal` |"),
        "assigned destination changed",
    ),
    (
        "shortcut rationale restores stale length magic",
        "saipen/CORE.md",
        replace(
            "**Length has no global meaning.**", "**Doubled is safe, tripled reaches a remote**"
        ),
        "shortcut-rationale",
    ),
    # A bare shortcut is a command, never a greeting. The ENTIRE-message rule
    # claimed it could not be mistaken for prose, and a bare `qq` was still
    # answered as a greeting instead of run as `saipen prepare saiwiki` --
    # the property was true and the failure still happened, so the paragraph
    # now names the greeting misreading as the failure and orders execution.
    (
        "shortcut paragraph loses its never-a-greeting duty",
        "saipen/CORE.md",
        replace("never a greeting", "rarely ambiguous"),
        "shortcut-rationale",
    ),
    # CLEAN's board scrub pruned `## DONE` with no inbound-reference guard, so
    # the phase that keeps the board honest could orphan a live `needs:` and
    # block a workable ticket. Reproduced on this repository at E-1811.
    (
        "clean.md's board scrub loses its inbound-needs guard",
        "saipen/phases/clean.md",
        replace(
            "still names in `needs:` MUST NOT be pruned",
            "still names in `needs:` should usually be kept",
        ),
        "clean-scrub-guard",
    ),
    # The `cc` row's Notes promised "trigger goal mode" while § 1.10 forbids
    # bare `saipen goal` from setting the flag at all.
    # Proposal Mode's halt was expressible only as an action the agent was
    # forbidden to perform: step 4 ordered DONE plus a halt, banned `WAIT:`
    # as a § 1.2 violation, and banned proceeding.
    # `agent: none` was ordered by both the phase doc and the shipped
    # template, so every project was born with an identity § 1.4 cannot
    # compare. The second control guards the honesty clause: refusing `none`
    # does not derive a first seat name, and a doc that stops saying so
    # promotes an open question to a settled rule by omission.
    (
        "1.11 lets a queued command be dropped",
        "saipen/CORE.md",
        replace(
            "cannot execute now is written down, never dropped",
            "cannot execute now may simply be reported",
        ),
        "command-not-dropped",
    ),
    (
        "1.10 drops the plan-then-goal pair",
        "saipen/CORE.md",
        replace(
            "One carve-out, and it is a pair rather than a loosening",
            "No carve-out exists and the bare form is absolute",
        ),
        "plan-goal-pair",
    ),
    (
        "1.2 stops sending another instance's work to BLOCKED",
        "saipen/CORE.md",
        replace(
            "The same section holds a ticket whose work another",
            "Core may take a ticket whose work another",
        ),
        "permanent-owner-section",
    ),
    (
        "1.2 stops sending unfinishable tickets to BLOCKED",
        "saipen/CORE.md",
        replace(
            "That is also where a ticket goes when its completion",
            "Such a ticket stays where it is and when its completion",
        ),
        "permanent-owner-section",
    ),
    (
        "translate.md stops ordering the digest restamp",
        "saipen/phases/translate.md",
        replace(
            "Something signals it now, and keeping that signal",
            "Nothing signals it and keeping any signal",
        ),
        "translation-digest",
    ),
    # The circuit's whole reason: a stage that hands forward a CLAIM instead
    # of evidence. Observed in a user transcript -- "Production Ready",
    # "проверил: всё работает", then FileNotFoundError on the next command.
    (
        "the sc circuit names a command nobody defined",
        "extensions/subs/crew.md",
        replace(
            "| SC-11 | `ship` | RELEASE_EXECUTOR",
            "| SC-11 | `ship` | `saipen sniff` RELEASE_EXECUTOR",
        ),
        "circuit-stages",
    ),
    (
        "crew.md lets a stage hand forward a claim",
        "extensions/subs/crew.md",
        replace(
            "A stage passes the next stage a reproduction or a verdict. Never a claim.",
            "A stage summarises its result for the next stage.",
        ),
        "circuit-handoff",
    ),
    (
        "CORE.md drops the ahead-stamp repair",
        "saipen/CORE.md",
        replace("An ahead-stamp is repaired, not waited out", "An ahead-stamp clears on its own"),
        "ahead-stamp-repair",
    ),
    (
        "1.1 drops the gate on new prose",
        "saipen/CORE.md",
        replace("names the defect class it eliminates", "should ideally be useful"),
        "prose-gate",
    ),
    (
        "build.md stops citing the prose gate",
        "saipen/phases/build.md",
        replace("names the defect class it eliminates", "should read well"),
        "prose-gate",
    ),
    (
        "ship.md fuses no-publish with an absent git again",
        "saipen/phases/ship.md",
        replace("It does NOT mean git is", "It also means git is"),
        "no-publish-split",
    ),
    (
        "ship.md hardcodes `no git` into the skipped-publish line",
        "saipen/phases/ship.md",
        replace("(no-publish: <reason>)", "(no-publish: no git)"),
        "no-publish-split",
    ),
    (
        "ship.md merges the local and git release halves",
        "saipen/phases/ship.md",
        replace(
            "6b. **GIT.",
            "6b. **Also local.",
        ),
        "no-publish-split",
    ),
    (
        "markhunt.md treats no-publish as git-unavailable again",
        "saipen/phases/markhunt.md",
        replace("means git cannot be READ, and nothing else", "covers no-publish hosts too"),
        "markhunt-no-git",
    ),
    (
        "markhunt.md calls a git-less closure satisfied again",
        "saipen/phases/markhunt.md",
        replace("tree_movement=unverified", "tree_movement=fine"),
        "markhunt-no-git",
    ),
    (
        "a stray file appears at the repository root",
        "SPEC_STRAY.md",
        write_new("stray root file" + chr(10)),
        "root-file-set",
    ),
    (
        "markhunt.md stops listing the tickets a pass wrote",
        "saipen/phases/markhunt.md",
        replace("`tickets=` is the pass's own", "`tickets=` is optional and"),
        "markhunt-pass-id",
    ),
    (
        "prepare.md goes back to one unqualified record",
        "saipen/phases/prepare.md",
        replace("RUN: prepare <producer> -> done", "RUN: prepare -> done"),
        "prepare-record",
    ),
    # Session-level BLOCKED means "no ticket anywhere is workable"; the
    # second half was never checked, so a session halted with a full board
    # looked exactly like a legitimate stop. The red condition spans two
    # files -- STATE.phase: BLOCKED AND a workable ## TODO ticket -- so this
    # is the one two-file case: setting phase alone went vacuous whenever the
    # board's workable tickets dried up (T-532), so the mutation injects a
    # synthetic workable ticket alongside the phase change.
    (
        "a session blocks while the board still has workable tickets",
        STATE,
        (
            "MULTI",
            [
                (STATE, sub_line("phase", "BLOCKED")),
                (
                    BOARD,
                    lambda t: t.replace(
                        "\n## TODO\n",
                        "\n## TODO\n- [ ] T-999 [P3] synthetic red-control workable ticket\n",
                        1,
                    ),
                ),
            ],
        ),
        "session-level BLOCKED is reserved for",
    ),
    (
        "CHANGELOG entries fall out of descending order",
        "CHANGELOG.md",
        # DERIVED, never a hardcoded version. A literal anchor here has gone
        # stale twice now for the same reason: the release that archives the
        # CHANGELOG overflow carries the anchored entry out of the file, the
        # mutation silently becomes a no-op, and the control stops being
        # evidence without anyone touching it. Finding the second heading at
        # run time makes archiving unable to break it again.
        bump_second_changelog_entry,
        "changelog-order",
    ),
    (
        "clean.md loses the pre-move reference sweep",
        "saipen/phases/clean.md",
        replace("needs a reference sweep first", "is usually fine"),
        "move-reference-sweep",
    ),
    (
        "clean.md loses the deletion proof gate",
        "saipen/phases/clean.md",
        replace("deleted on proof of recovery", "deleted when obvious"),
        "clean-delete-proof",
    ),
    (
        "clean.md reads the cap as authority again",
        "saipen/phases/clean.md",
        replace("mass-deletion gate, not a grant of authority", "budget of five free deletions"),
        "clean-delete-proof",
    ),
    (
        "hunt.md regains deletion authority",
        "saipen/phases/hunt.md",
        # replace_all, not replace: hunt.md states this twice on purpose (the
        # rule, and the reminder beside the `hh` re-entry). Mutating one left
        # the other standing, the validator kept finding the phrase, and the
        # control stopped being evidence the moment ecd77546 added the second.
        replace_all("deletes, moves and renames nothing", "may delete obvious junk it finds"),
        "hunt-no-mutation",
    ),
    (
        "hunt.md reuses a clean result on a dirty tree",
        "saipen/phases/hunt.md",
        replace("`git status --porcelain` prints nothing", "the commit hash is unchanged"),
        "hunt-clean-key",
    ),
    (
        "STATE names a model build instead of a seat",
        STATE,
        sub_line("agent", "claude-opus"),
        "carries the model token",
    ),
    (
        "init.md stops deriving the seat from the agent home",
        "saipen/phases/init.md",
        replace("**Where the value comes from is not a choice**", "Pick a name that suits you"),
        "bootstrap-identity",
    ),
    (
        "init.md goes back to ordering agent: none",
        "saipen/phases/init.md",
        replace("**never `none`**", "`none` is fine to start with"),
        "bootstrap-identity",
    ),
    # Must be a value the live checks ACCEPT -- `none` is a placeholder now,
    # so mutating the template to it leaves the template requirement
    # satisfied and the control proves nothing. A real seat name is the
    # failure: it copies straight into a first checkpoint and passes.
    (
        "the shipped template ships a passable agent value",
        "extensions/templates/STATE.md",
        sub_line("agent", "opencode"),
        "bootstrap-identity",
    ),
    (
        "plan.md lets the halt be a PHASE nobody executes",
        "saipen/phases/plan.md",
        replace("There is no parked `PHASE`", "A `PHASE` may be recorded without being executed"),
        "proposal-halt",
    ),
    (
        "plan.md drops the halt's category",
        "saipen/phases/plan.md",
        replace("category is `user brake`", "category is up to you"),
        "proposal-halt",
    ),
    # T-537 gave `cc` and `saipen goal` separate destinations, and the pair of
    # controls that used to guard the old shared route quoted row text the
    # split rewrote -- so both mutations became no-ops and the harness scored
    # them SKIP. Repointed at the text that now carries the requirement, which
    # is the third occurrence of the split-anchor class T-496 and T-532 name.
    #
    # The old cc-row control is replaced by the requirement the split exists to
    # protect: `cc` routes to `saipen continue`, and a table that maps it back
    # to `saipen goal` is the exact regression the separation forbids. Keyed on
    # the route cell, so it fires on the mapping itself and not on prose.
    (
        "the cc row is mapped back to `saipen goal`",
        "saipen/CORE.md",
        replace("| `cc` | `saipen continue` |", "| `cc` | `saipen goal` |"),
        "shortcut-routes",
    ),
    # Registry-vs-prose: the registry is the machine authority. Point one
    # registry row at a different destination (here `cc` -> `saipen goal`) so
    # the prose-route cell still says `saipen continue`. Validator must FAIL
    # the [registry-vs-prose] check, proving the registry is no longer a
    # silent mirror of prose.
    (
        "the registry shortcut table is silently rewritten",
        "saipen/REGISTRY.json",
        sub_json_route("cc", "saipen goal"),
        "commands-vs-registry",
    ),
    # `gg` is now the only row routing to `saipen goal`, and the Notes
    # requirement is derived from the route rather than the key -- so this
    # control strips the "pivot needs text" clause the check reads, leaving a
    # Notes column that promises a bare pivot the destination forbids.
    (
        "the gg row promises a bare Goal Mode pivot again",
        "saipen/CORE.md",
        replace(
            "NEW GOAL ONLY: the pivot needs text, and `gg <objective>` is what sets a new one.",
            "NEW GOAL ONLY: Goal Mode pivot and re-authorization.",
        ),
        "shortcut-notes",
    ),
    (
        "bare cc starts convergence from normal intent",
        "saipen/CORE.md",
        replace("enters convergence from `normal`", "continues ordinary work from `normal`"),
        "shortcut-semantics",
    ),
    (
        "cc resumes persisted goal intent",
        "saipen/CORE.md",
        replace("resumes `execution_intent: goal`", "replaces `execution_intent: goal`"),
        "shortcut-semantics",
    ),
    (
        "cc never asks for objective text",
        "saipen/CORE.md",
        replace("never asks for an objective", "may ask for an objective"),
        "shortcut-semantics",
    ),
    (
        "cc with arguments is rejected rather than becoming a goal",
        "saipen/CORE.md",
        replace("`cc <args>` is not a goal", "`cc <args>` starts a goal"),
        "shortcut-semantics",
    ),
    (
        "gg with objective creates a new goal",
        "saipen/CORE.md",
        replace("NEW GOAL ONLY", "GOAL CONTINUATION"),
        "shortcut-semantics",
    ),
    (
        "bare gg is never a continuation alias",
        "saipen/CORE.md",
        lambda text: text.replace("never a continuation alias", "is a continuation alias"),
        "shortcut-semantics",
    ),
    # The callout check counted keys, tokens, order and the link and never
    # read what the sentence CLAIMS, so a document could tell the reader `cc`
    # is the Goal Mode key while § 1.10 routed it to `saipen continue` -- and
    # three Core-owned files shipped exactly that for a release.
    # The convergence order is the whole contract, and the way it breaks is not
    # a deleted file -- it is two stages swapping, which reads fine and puts the
    # producer packages before the cleanup that invalidates them. Swap K past M
    # so every stage is still present and only the ORDER is wrong.
    (
        "CONVERGE.md prepares its factories before the closure sweep",
        "saipen/CONVERGE.md",
        replace("**K. FRESH EE.**", "**M. FINAL FRESHNESS CHECK.**"),
        "converge-contract",
    ),
    (
        "CONVERGE.md loses the post-K ordering rule",
        "saipen/CONVERGE.md",
        replace(
            "Nothing that mutates main source may run after K.",
            "Main source may be mutated whenever it is convenient.",
        ),
        "converge-contract",
    ),
    (
        "CONVERGE keeps EE before QQ",
        "saipen/CONVERGE.md",
        replace("**K. FRESH EE.**", "**L. FRESH QQ.**"),
        "converge-contract",
    ),
    (
        "CONVERGE blocks factories while TODO remains",
        "saipen/CONVERGE.md",
        replace("no workable `## TODO` ticket", "TODO may remain"),
        "closure evidence drift",
    ),
    (
        "CONVERGE blocks factories after failing tests",
        "saipen/CONVERGE.md",
        replace(
            "canonical tests PASS against the tree",
            "canonical tests were attempted against the tree",
        ),
        "closure evidence drift",
    ),
    (
        "CONVERGE blocks factories on scout or fixer findings",
        "saipen/CONVERGE.md",
        replace(
            "no fresh critical scout or fixer OUTBOX", "critical scout or fixer OUTBOX may remain"
        ),
        "closure evidence drift",
    ),
    (
        "CLEAN forces tests and final HUNT before factories",
        "saipen/CONVERGE.md",
        replace("CLEAN completed, or proved nothing safe remained", "CLEAN was considered"),
        "closure evidence drift",
    ),
    (
        "final HUNT findings return to Core work",
        "saipen/CONVERGE.md",
        replace("final forced HUNT after CLEAN came back clean", "final HUNT was started"),
        "closure evidence drift",
    ),
    (
        "old hunt marker cannot satisfy forced HUNT",
        "saipen/CONVERGE.md",
        replace(
            "existing hunt -> clean marker cannot satisfy forced HUNT",
            "existing hunt marker may satisfy forced HUNT",
        ),
        "closure evidence drift",
    ),
    (
        "a Core-owned callout calls `cc` the Goal Mode key",
        "guides/GUIDE_EN.md",
        replace(
            "`cc` continues the project context to convergence (resuming a "
            "running goal if one is set)",
            "`cc` keeps active Goal Mode moving",
        ),
        "shortcut-callouts",
    ),
    # § 1.10 ordered `saipen status` to report the last validator result from
    # LOG.md before anything gave that record a shape. Break the fixed form
    # and the report has nothing to read -- the same silence the duty had for
    # its whole life, now visible.
    # Anchored at the taxonomy, not on the bare literal: `replace()` takes the
    # FIRST occurrence, and the first one in this LOG is a line QUOTING the
    # form while explaining it. That mutation edited prose and left the real
    # record standing, so the case reported green while proving nothing --
    # the exact "expectation is not evidence" trap row 137 exists for.
    # The check reads the ACTIVE log only -- status wants the last run, not one
    # sealed into cold storage -- so breaking every record here is what fires
    # it. A first attempt aimed at the sealed segment and proved nothing: the
    # active log still carried its own record, and a global check needs every
    # copy broken. Regex-anchored on the taxonomy so a cap crossing cannot
    # quietly carry the anchor away, which is how two cases became SKIPs.
    (
        "the conformance record loses its fixed form",
        LOG,
        lambda t: re.sub(r"(RUN: )validate\.py -> (PASS|FAIL)", r"\1validate.py \2", t),
        "no-conformance-record",
    ),
    # NOT here: the DONE-wait deadlock under `goal_mode: true`. It needs an
    # empty `## TODO` *and* a bogus WAIT, and a case mutates exactly one file,
    # so every single-file attempt proves nothing -- STATE alone leaves the
    # board full, BOARD alone leaves next_action legal. Tried, went not-red,
    # removed rather than left standing. T-457 owns the compound-fixture route.
    # `saipen hunt` is recognised from anywhere while HUNT sat outside § 1.6's
    # from-any-phase set, so the DFA's only route in was DONE -> HUNT and the
    # command produced a transition the validator rejects. Three surfaces, one
    # defect: the set, § 2.1's halt phrasing, and hunt.md's hash skip.
    (
        "HUNT drops out of the from-any-phase set",
        "saipen/CORE.md",
        replace("`PLAN`, `HUNT`.", "`PLAN`."),
        "any-from",
    ),
    (
        "§ 2.1 reads the halt as a precondition on the command too",
        "saipen/MAINTENANCE.md",
        replace("governs the AUTONOMOUS transition only", "applies to every entry into this phase"),
        "hunt-entry",
    ),
    (
        "hunt.md lets the hash skip swallow an explicit sweep",
        "saipen/phases/hunt.md",
        replace("does not apply -- run the full sweep", "may still apply if the tree is unchanged"),
        "hunt-entry",
    ),
    # The first-publish gate sat after the pushes it authorizes, with its own
    # WAIT text claiming "before I push". Moving it back below the push is the
    # exact regression this control catches.
    (
        "ship.md puts the first-publish gate back after the push",
        "saipen/phases/ship.md",
        replace(
            "Classify the remote BEFORE any external write", "Classify the remote at some point"
        ),
        "first-publish-order",
    ),
    # T-467: step 7 makes the tag push a separate command from the branch
    # push, so a rejected branch push can still be followed by a successful
    # tag push -- publishing a tag on a commit that is on no remote branch
    # (E-1787, E-1882). Pushing the tag before gating on the branch landing
    # is the exact regression this control catches.
    (
        "ship.md pushes the release tag before the branch has landed",
        "saipen/phases/ship.md",
        replace(
            "ONLY AFTER step 6b's branch push has LANDED",
            "Once the release is ready, regardless of the branch push",
        ),
        "tag-after-branch",
    ),
    # T-466: the ticket that passes REVIEW stays in `## DOING` through SHIP
    # -- the push has not happened. Closing it at REVIEW made § 1.2's own
    # `PHASE SHIP T-###` name a `## DONE` ticket and fail the pick check
    # twice over (E-1879). The rule lives in review.md once; ship.md cites
    # it. Softening either half silently reopens the defect, so both halves
    # get a control that goes red on its own anchor.
    (
        "review.md lets REVIEW close the passed ticket before SHIP",
        "saipen/phases/review.md",
        replace(
            "stays in `## DOING` through SHIP -- do NOT close it",
            "may be closed here, the review is done",
        ),
        "ticket-stays-doing",
    ),
    (
        "ship.md stops citing the ticket's `## DOING`-through-SHIP rule",
        "saipen/phases/ship.md",
        replace(
            "The shipped ticket was still in `## DOING` when this phase began",
            "The shipped ticket may have been closed at REVIEW",
        ),
        "ticket-stays-doing",
    ),
    # VERIFY's 3/2 cap was counted from memory while REVIEW's became a field
    # one document over. Both directions: over the cap with no blocker, and a
    # value the field cannot hold. The replacement MUST carry the \1
    # backreference -- without it re.sub swaps the whole ticket line for the
    # bare field fragment, the board parser rejects the shape, and the
    # validator FAILs for a reason that has nothing to do with the cap. Red
    # for the wrong reason is not evidence, and it reads exactly like a
    # passing control: E-1911 caught this class once, and the repair for it
    # reintroduced it by losing the group.
    (
        "a ticket runs past verify.md's fix-cycle cap with no blocker",
        BOARD,
        lambda t: re.sub(
            r"^(?!.*\| blocker:)(- \[[ x/]\] T-\d+ \[P\d\] .*)$",
            r"\1 | verify_attempts: 9",
            t,
            count=1,
            flags=re.MULTILINE,
        ),
        "against phases/verify.md's cap",
    ),
    (
        "verify_attempts holds something that is not a number",
        BOARD,
        lambda t: re.sub(
            r"^(?!.*\| blocker:)(- \[[ x/]\] T-\d+ \[P\d\] .*)$",
            r"\1 | verify_attempts: many",
            t,
            count=1,
            flags=re.MULTILINE,
        ),
        "is not a number",
    ),
    # One control per borrowed invariant. Each softens the MUST the way a
    # later editor plausibly would, rather than deleting the sentence.
    (
        "verify.md loses the cheapest-first ordering claim",
        "saipen/phases/verify.md",
        replace("That order is cheapest-first", "That order is a suggestion"),
        "borrowed-invariants",
    ),
    (
        "verify.md lets a later green restore a failed PASS claim",
        "saipen/phases/verify.md",
        replace("ends the PASS claim for this pass", "is worth noting"),
        "borrowed-invariants",
    ),
    (
        "verify.md goes back to re-deriving the project's commands",
        "saipen/phases/verify.md",
        replace(
            "Read the project's canonical commands from `KNOWLEDGE/`",
            "Find the project's commands however you like",
        ),
        "borrowed-invariants",
    ),
    (
        "scout.md stops writing the commands down",
        "saipen/phases/scout.md",
        replace("cited afterwards rather than", "noted mentally rather than"),
        "borrowed-invariants",
    ),
    (
        "BOOT implies the pre-computed pick stands alone",
        "saipen/BOOT.md",
        replace(
            "Immediate means without asking, never without looking", "Immediate means immediate"
        ),
        "borrowed-invariants",
    ),
    (
        "review.md goes back to trusting VERIFY's claim",
        "saipen/phases/review.md",
        replace("do not read VERIFY's claim of", "you may reuse"),
        "review-reruns-verify",
    ),
    # § 1.11's priority list had no entry for the user naming a command, so
    # BOOT's "execute `next_action` immediately" and § 1.10's "a shortcut is a
    # command, never a greeting" were two live MUSTs with no precedence
    # between them -- and at a cold start BOOT is the file read first. The
    # same `qq` was lost to the same stale pick twice (E-1913). Either half
    # softening on its own restores the tie, so both are controlled.
    (
        "§ 1.11 weighs the user's command instead of obeying it",
        "saipen/CORE.md",
        replace("It supersedes persisted", "It is weighed against persisted"),
        "command-outranks-pick",
    ),
    (
        "BOOT step 7 goes back to unconditional",
        "saipen/BOOT.md",
        replace("the user's own message outranks the file", "run whatever the state recorded"),
        "command-outranks-pick",
    ),
    (
        "BOOT step 7 drops the memory ban for shortcut tables",
        "saipen/BOOT.md",
        # The period-anchored old string did not match the current em-dash text,
        # so this went a no-op (T-532). The check reads the phrase without the
        # period, so the mutation drops exactly that.
        replace("Memory is never a source for it", "Use memory if you are confident"),
        "shortcut-memory-ban",
    ),
    (
        "BOOT step 7 drops the duplication ban for shortcut tables",
        "saipen/BOOT.md",
        # Must mutate the string the CHECK reads. It mutated "Do not copy the
        # table here" while validate.py tests for "a second copy drifts", so
        # the case could not go red at all -- shipped that way in 50d5fed.
        replace("a second copy drifts", "a second copy is fine"),
        "shortcut-memory-ban",
    ),
    (
        "RFC § 1.10 softens the recall penalty",
        "saipen/CORE.md",
        replace(
            "answering a row from recall is the same failure as inventing a command",
            "answering a row from recall is discouraged",
        ),
        "shortcut-memory-ban",
    ),
    # § 2.1's ZERO-PROMPT MUST named one exception while § 1.3 banned ADD
    # under read-only, so the rule ordered a phase the mode forbids and both
    # rules looked followed on their own.
    (
        "§ 2.1 drops the read-only carve-out from ZERO-PROMPT",
        "saipen/MAINTENANCE.md",
        replace("MUST NOT enter `ADD` at all", "SHOULD prefer to skip `ADD`"),
        "zero-prompt-exceptions",
    ),
    # § 1.2's legacy-upgrade sentence named `v2` long after the schema reached
    # 3, so the one instruction for escaping legacy state ordered a value the
    # validator WARNs as legacy. A version number reads as fact, which is why
    # nothing saw it; the same rot had the shipped subSaipen TEMPLATE born at
    # schema 1, so every spawn produced a legacy state.
    (
        "§ 1.2 re-hardcodes a superseded schema version",
        "saipen/CORE.md",
        replace(
            "MUST upgrade **to the current schema version**", "MUST upgrade to `schema_version: 2`"
        ),
        "stale-schema-version",
    ),
    (
        "the shipped subSaipen TEMPLATE is born legacy",
        "extensions/subs/TEMPLATE/STATE.md",
        sub_line("schema_version", "1"),
        "stale-schema-version",
    ),
    # RFC § 1.2 pairs `PHASE` with a ticket ref for exactly five phases and
    # forbids it everywhere else. Nothing witnessed either direction, and the
    # constitution's own § 2.2 example wrote the forbidden one in prose.
    (
        "next_action bolts a ticket ref onto a phase that takes none",
        STATE,
        sub_line("next_action", '"PHASE PLAN T-435"'),
        "not one of the five ticket-bearing phases",
    ),
    (
        "next_action enters a ticket-bearing phase with no ticket",
        STATE,
        sub_line("next_action", '"PHASE BUILD"'),
        "enters ticket-bearing phase",
    ),
    (
        "a shipped doc spells out the forbidden PHASE form",
        "saipen/phases/add.md",
        replace("or `PHASE PLAN`.", "or `PHASE PLAN T-###`."),
        "phase-ticket-ref",
    ),
    (
        "§ 1.2 loses a phase from the ticket-bearing five",
        "saipen/CORE.md",
        replace(
            "`SCOUT`, `BUILD`, `VERIFY`, `REVIEW`, `SHIP` -- and omitted",
            "`SCOUT`, `BUILD`, `VERIFY`, `REVIEW` -- and omitted",
        ),
        "TICKET_BEARING_PHASES",
    ),
    # § 1.10's stop paragraph cited § 2.4 Entry while stating its opposite:
    # an unconditional counter reset on bare `saipen goal`. That is a fresh
    # 3-wave/20-ticket budget for anyone who types the key out of habit.
    (
        "stop paragraph re-asserts an unconditional goal-counter reset",
        "saipen/CORE.md",
        replace("only when they are at or over the caps", "every time, whatever the counters read"),
        "goal-counter-reset",
    ),
    (
        "translation collect shortcut silently prepares instead",
        "saipen/CORE.md",
        replace(
            "| `eee` | `saipen collect saitranslate` then `saipen ship` |",
            "| `eee` | `saipen prepare saitranslate` then `saipen ship` |",
        ),
        "assigned destination changed",
    ),
    (
        "ready package loses its source freshness field",
        "saipen/phases/prepare.md",
        replace(
            "`status`, `producer`, `source_head`, `source_tree_fingerprint`, "
            "`role_revision`, `coverage`",
            "`status`, `producer`, `source_head`, `role_revision`, `coverage`",
        ),
        "PREPARE fields",
    ),
    (
        "non-ready collect loses its no-write guarantee",
        "saipen/CORE.md",
        replace(
            "No main-project file, checkpoint, Git ref, or remote may change on that refusal.",
            "The agent should avoid changing files on refusal.",
        ),
        "package-handoffs",
    ),
    (
        "SKILL metadata drops a shortcut trigger",
        "saipen/SKILL.md",
        replace("cc, ccc, st, sss, dd", "cc, ccc, st, dd"),
        "metadata misses registry shortcut trigger",
    ),
    (
        "SKILL metadata keeps a stale shortcut trigger",
        "saipen/SKILL.md",
        replace("qq, qqq, ee,", "qq, qqq, yy, ee,"),
        "metadata has non-registry shortcut trigger",
    ),
    # Drop a phase-named command from the checkpoint duty. This is how
    # `saipen hunt` shipped: on the surface, absent from the list, and no
    # check compared the two for two releases.
    (
        "phase-switching command loses its checkpoint duty",
        "saipen/CORE.md",
        replace("`ship`, `hunt`) invoked while", "`ship`) invoked while"),
        "as phase-switching but the commands named after a phase",
    ),
    (
        "requires: a capability nobody defines",
        STATE,
        replace("  - python", "  - pyhton"),
        "handshake vocabulary",
    ),
    # --- BOARD -----------------------------------------------------------
    (
        "board heading removed",
        BOARD,
        replace("## BLOCKED\n", ""),
        "missing required section heading",
    ),
    ("duplicate board heading", BOARD, lambda t: t + "\n## TODO\n", "duplicate section heading"),
    (
        "two tickets claimed at once",
        BOARD,
        add_after("## DOING\n", "- [/] T-801 a\n- [/] T-802 b\n"),
        "allows at most one per agent",
    ),
    (
        "ticket field outside the closed list",
        BOARD,
        add_after("## TODO\n", "- [ ] T-803 a | assignee: me\n"),
        "unrecognized field",
    ),
    (
        "needs: a ticket that does not exist",
        BOARD,
        add_after("## TODO\n", "- [ ] T-804 a | needs: T-9999\n"),
        "dangling needs: reference",
    ),
    (
        "cyclic needs",
        BOARD,
        add_after("## TODO\n", "- [ ] T-805 a | needs: T-806\n- [ ] T-806 b | needs: T-805\n"),
        "cyclic needs: dependencies",
    ),
    # Both lines in one mutation on purpose: with only the claim, the
    # dependency is dangling and the older check owns the failure, so the
    # Pick Rule branch is never reached.
    (
        "claimed ticket whose dependency is not done",
        BOARD,
        lambda t: t.replace("## DOING\n", "## DOING\n- [/] T-809 a | needs: T-810\n", 1).replace(
            "## TODO\n", "## TODO\n- [ ] T-810 b\n", 1
        ),
        "dependencies are not done",
    ),
    (
        "claim_time with no zone",
        BOARD,
        add_after("## DOING\n", "- [/] T-807 a | owner: x | claim_time: 2026-07-30T01:00:00\n"),
        "not ISO-8601 UTC",
    ),
    (
        "review_passes over the cap",
        BOARD,
        add_after("## TODO\n", "- [ ] T-808 a | review_passes: 4\n"),
        "two passes",
    ),
    (
        "ticket line that is not a ticket",
        BOARD,
        add_after("## TODO\n", "- [ ] fix this later\n"),
        "doesn't match RFC",
    ),
    # --- LOG -------------------------------------------------------------
    # Appending a LOWER id cannot test this: E-### is contiguous, so any id
    # below the tail already exists and the duplicate check fires first,
    # `continue`s, and the monotonic branch is never reached. Swap the last two
    # entries instead -- ids go backwards with nothing duplicated.
    ("LOG event ids go backwards", LOG, SWAP, "increase monotonically"),
    ("LOG entry with no date", LOG, lambda t: t + "- [E-999999] RUN: undated\n", "has no DATE"),
    # T-1261. The inversion warning read every timestamp pair from v7.99.0 and
    # reported nothing for five weeks: it sat behind one boolean asking whether
    # ANY segment anywhere mentioned documented inversions, and three sealed
    # DECs from July 2026 answered yes forever. A check that cannot go red is
    # not a check, and this control is what would have said so. The appended
    # line stamps 2020 after a 2026 tail, so the pair inverts by years.
    (
        "LOG timestamp jumps backwards with no DEC covering it",
        LOG,
        lambda t: t + "- 01.01.20 00:00 [E-999998] RUN: inversion probe\n",
        "timestamp moves backwards by",
    ),
    # --- kitchen ---------------------------------------------------------
    (
        "digest is not three lines",
        DIGEST,
        lambda t: "done: x\nremaining: y\n",
        "exactly three lines",
    ),
    (
        "markhunt manifest half-written",
        MANIFEST,
        write_new("vectors: [1,2,3,4,5]\ncursor: done\n"),
        "missing surface, findings, head_start, head_end",
    ),
    (
        "markhunt head pair mixed",
        MANIFEST,
        write_new(
            "vectors: [1,2,3,4,5]\nsurface: x\nfindings: 0\n"
            "cursor: done\nhead_start: abc1234\nhead_end: no-git\n"
        ),
        "never one",
    ),
    (
        "markhunt done with a vector missing",
        MANIFEST,
        write_new(
            "vectors: [1,2,4,5]\nsurface: x\nfindings: 0\n"
            "cursor: done\nhead_start: abc1234\nhead_end: abc1234\n"
        ),
        "NOT exhausted",
    ),
    # --- subSaipen -------------------------------------------------------
    (
        "sub keeps TEMPLATE's agent placeholder",
        SUB,
        sub_line("agent", "<name>"),
        "TEMPLATE's placeholder",
    ),
    (
        "sub in a phase it cannot reach",
        SUB,
        sub_line("phase", "BUILD"),
        "unreachable for a subSaipen",
    ),
    ("sub transition_from dropped", SUB, drop_line("transition_from"), "ninth required field"),
    ("sub updated not UTC", SUB, sub_line("updated", "2026-07-30 10:00"), "must be ISO-8601 UTC"),
    # --- KNOWLEDGE structured surface ------------------------------------
    # T-1292. The check landed in v7.254.0 with a hand transcript and no
    # permanent control, so the sweep total read the same before and after it
    # arrived. Its two failure classes are independent: a card the parser
    # refuses, and a projection that no longer matches the cards it claims to
    # summarize. One control each, because a fix restoring only the parser
    # would leave the staleness half unproven.
    (
        "a KNOWLEDGE card declares a kind outside the closed set",
        KNOWLEDGE_CARD,
        replace("kind: convention", "kind: notakind"),
        "invalid kind",
    ),
    (
        "a changed KNOWLEDGE card leaves the index projection stale",
        KNOWLEDGE_CARD,
        # Appended rather than anchored: the claim's wording is prose that will
        # be edited, and an anchor inside it would turn this control into a
        # silent no-op the day someone rewrites the card (T-532). Any content
        # change stales the digest, which is the condition under test.
        lambda t: t.rstrip("\n") + " Restated by the index-staleness control.\n",
        "INDEX.md is stale",
    ),
    # --- home-repo drift -------------------------------------------------
    (
        "README badge behind VERSION",
        "README.md",
        lambda t: re.sub(r"\*\*v\d+\.\d+\.\d+\*\*", "**v1.0.0**", t, count=1),
        "badge doesn't match VERSION",
    ),
    ("a phase doc disappears", "saipen/phases/hunt.md", DELETE, "phase enum"),
    (
        "shipped doc names the superseded palette",
        "README.md",
        replace("Vintage Golden", "Dark Golden Win95"),
        "palette-name",
    ),
    (
        "Golden Default token drifts",
        "saipen/UI.md",
        replace("--background:#1A1810", "--background:#1A1811"),
        "ui-palette",
    ),
    (
        "Golden Default gains an extra token",
        "saipen/UI.md",
        replace("--link:#F0D060;", "--link:#F0D060;\n  --rogue:#FFFFFF;"),
        "ui-palette",
    ),
    (
        "Golden Default gains a later root override",
        "saipen/UI.md",
        replace("}\n\n* {", "}\n\n:root {\n  --background:#FFFFFF;\n}\n\n* {"),
        "ui-palette",
    ),
    (
        "Golden Default gains a non-hex override",
        "saipen/UI.md",
        replace("* {", ".override { --background:rgb(255,255,255); }\n\n* {"),
        "ui-palette",
    ),
    (
        "Golden Default stops being default",
        "saipen/UI.md",
        replace(
            "**Golden Default is the default palette.**",
            "**Golden Default is an optional palette.**",
        ),
        "lost the Golden Default default mandate",
    ),
    (
        "BOOT drops the reply-language rule",
        "saipen/BOOT.md",
        replace("Reply-language precedence:", "Reply language precedence:"),
        "reply-language",
    ),
    (
        "SKILL drops the reply-language precedence",
        "saipen/SKILL.md",
        replace("Reply-language precedence:", "Reply language precedence:"),
        "reply-language",
    ),
    (
        "STYLE drops persistent caveman voice",
        "saipen/STYLE.md",
        replace("Voice persistence:", "Voice remains:"),
        "chat-voice",
    ),
    # T-404: BOOT.md's on-demand rule-question list and its before-output
    # mandate must stay disjoint. Line 101 once filed STYLE.md under lazy
    # 'rule questions' while line 108 ordered it before any output -- a live
    # session took the cheap reading and never opened the file.
    (
        "BOOT re-lists STYLE.md as an on-demand rule question",
        "saipen/BOOT.md",
        # Old anchor was pre-shrink text. The T-404 straddler check only counts
        # `saipen/`-prefixed refs, so the mutation must add a prefixed STYLE.md
        # to BOTH the on-demand bullet and the before-output bullet -- a bare
        # mention in one is deliberately ignored (T-532).
        lambda t: t.replace(
            "**STYLE.md is NOT on the rule-question list.**",
            "**`saipen/STYLE.md` is on the rule-question list.**",
        ).replace(
            "Step 1 already read STYLE.md — the file in the same folder as this BOOT.md",
            "Step 1 already read `saipen/STYLE.md` — the file in the same folder as this BOOT.md",
        ),
        "under on-demand 'rule questions' while ordering it",
    ),
    (
        "BOOT loses a T-404 disjointness anchor bullet",
        "saipen/BOOT.md",
        # Old anchor was pre-shrink text. The check parses a bullet that starts
        # with "Rule questions"; renaming the bullet to "Questions" makes the
        # parser lose it entirely, which is the exact failure the check names.
        replace("Rule questions → `INDEX.md` first.", "Questions → `INDEX.md` first."),
        "lost one of the two T-404 anchor bullets",
    ),
    (
        "BOOT moves the STYLE.md read out of the numbered fast path",
        "saipen/BOOT.md",
        # Old anchor used ASCII `--`; the current BOOT.md writes an em-dash, so
        # the mutation was a no-op (T-532). Re-pinned to the live em-dash text.
        replace(
            "1. **Read `STYLE.md` — the file in the same folder as this `BOOT.md` —",
            "1. **Read the voice notes — the file in the same folder as this `BOOT.md` —",
        ),
        "no longer orders reading STYLE.md before any output",
    ),
    (
        "STYLE.md contract edited without reprinting its marker",
        "saipen/STYLE.md",
        replace("Formatting only.", "Formatting mostly."),
        "the contract changed and its marker did not",
    ),
    (
        "STYLE.md stops declaring a boot marker at all",
        "saipen/STYLE.md",
        replace("`style_contract:", "`style_contrakt:"),
        "boot markers, expected exactly one",
    ),
    (
        "STYLE.md sets a reply language outside the closed set",
        "saipen/STYLE.md",
        replace("**`reply_language: et`**", "**`reply_language: eesti`**"),
        "is not one of",
    ),
    (
        "STYLE.md stops declaring a reply language",
        "saipen/STYLE.md",
        replace("**`reply_language: et`**", "Estonian by default."),
        "declares 0 reply_language setting(s)",
    ),
    (
        "a Core guide opens with mechanics instead of the hook",
        "guides/GUIDE_EE.md",
        replace("On 2026 ja tehisintellekt", "Käivita `saipen set`. On 2026 ja tehisintellekt"),
        "starts with mechanics instead of prose",
    ),
    (
        "an entry README stops naming the reply-language setting",
        "README.ee.md",
        replace("`reply_language:`", "`reply-keel:`"),
        "never mentions `reply_language:`",
    ),
    # T-419: the guard used to stop at the three Core-owned entry documents,
    # so the Japanese root mirror and the 32 locale copies could carry the
    # note today and lose it in the next translation pass with nothing
    # noticing. A locale reader is the one most likely to read an Estonian
    # answer as a broken tool, having arrived in a third language.
    (
        "a locale README stops naming the reply-language setting",
        ".saipen/saitranslate/kitchen/ru/README_RU.md",
        replace("`reply_language:`", "строку языка"),
        "never mentions `reply_language:`",
    ),
    (
        "BOOT.md presents the precedence rule without the setting",
        "saipen/BOOT.md",
        # Old anchor back-ticked STYLE.md (`STYLE.md`'s); the current BOOT.md
        # writes it bare, so the mutation was a no-op (T-532).
        replace("STYLE.md's `reply_language:` (step 1", "STYLE.md's language rule (step 1"),
        "without naming STYLE.md's `reply_language:` setting",
    ),
    (
        "BOOT.md leaks STYLE.md's marker value",
        "saipen/BOOT.md",
        leak_style_marker,
        "carries STYLE.md's marker value",
    ),
    (
        "BOOT fast-path STYLE.md read loses its self-locating reference",
        "saipen/BOOT.md",
        replace("the file in the same folder as this `BOOT.md`", "`<saipen_home>/STYLE.md`"),
        "lost its self-locating reference",
    ),
    (
        "BOOT loses the fast-path section heading",
        "saipen/BOOT.md",
        replace("## Fast path", "## Boot sequence"),
        "lost its '## Fast path' or '## Anything else' heading",
    ),
    (
        "an adapter lazily defers STYLE.md to a rule question",
        "extensions/adapters/deepseek.md",
        replace(
            "`saipen/STYLE.md` is a boot-read: apply it before any output.",
            "`saipen/STYLE.md` loads alongside it.",
        ),
        "as a rule-question escalation",
    ),
    # T-401: the WARN ownership ledger is data, not decoration. Each tracked
    # slug must carry semver first/last seen and a rationale; a slug that
    # survives WARN_OWNER_SPAN consecutive releases must be named by a live
    # BOARD ticket. These mutate the baseline DATA -- a broken map key, a
    # missing rationale, a non-semver bound -- never validator wording.
    (
        "baseline warn_slugs map key drifts",
        "tools/release_ledger_baseline.json",
        replace('"warn_slugs": {', '"warn_slugs_x": {'),
        "must contain exactly tag_only, changelog_only and warn_slugs maps",
    ),
    (
        "baseline warn_slugs entry loses its rationale",
        "tools/release_ledger_baseline.json",
        replace('"rationale": "BOARD.md outgrew', '"rationale_x": "BOARD.md outgrew'),
        "needs first_seen, last_seen and rationale",
    ),
    (
        "baseline warn_slugs entry gains non-semver bounds",
        "tools/release_ledger_baseline.json",
        replace('"first_seen": "7.72.0"', '"first_seen": "banana"'),
        "has non-semver first_seen/last_seen",
    ),
    ("a locale loses its guide", "guides/GUIDE_UK.md", DELETE, "locale coverage"),
    (
        "a locale guide loses its shortcut callout",
        "guides/GUIDE_AR.md",
        lambda t: re.sub(
            r"^\*\*[^\n]*`cc`[^\n]*#110-command-surface[^\n]*\n", "", t, count=1, flags=re.MULTILINE
        ),
        "shortcut-callouts",
    ),
    (
        "root device artifact is no longer Git-ignored",
        ".gitignore",
        replace("/nul\n", ""),
        "root-device-ignore",
    ),
    # NOT tested here: the phantom-version check needs the TAG half of the
    # release ledger, and this harness copies the tree without .git on
    # purpose. Without tags the check correctly declines to run, so a case
    # for it could only ever match the WARN saying it was skipped -- which
    # is exactly how it scored as "always present". CI covers it, where the
    # checkout carries tags (fetch-depth: 0).
    # T-426: transition-table EDGES must agree in every copy, not just the
    # phase NAMES. The DFA is the enforced representation; both remaining
    # copies (RFC § 1.6's fence table, and each phases/*.md exit line) are
    # gated against it. Each mutation is a byte in a DIFFERENT copy, so a
    # drift in one is caught no matter which one drifts first.
    (
        "RFC transition table loses an edge",
        "saipen/CORE.md",
        replace("SCOUT     -> BUILD | BLOCKED", "SCOUT     -> BLOCKED"),
        "transition-table",
    ),
    (
        "phase doc exit names an edge the DFA rejects",
        "saipen/phases/scout.md",
        replace("After SCOUT: STATE -> BUILD.", "After SCOUT: STATE -> SHIP."),
        "phase-exit",
    ),
    # T-430: a LOG line records what happened. One word turns E-1769 from an
    # event into an intention, and every reader after it -- § 1.5's Recovery
    # rebuild included -- would still count it as evidence the act occurred.
    # The anchor is safe to name: append-only makes that line immutable.
    # Anchored on the taxonomy rather than on one line's words: the previous
    # anchor named a specific event, and that event was sealed into a segment
    # at the next cap crossing, which turned this case into a silent SKIP.
    # The active log always carries at least the checkpoint that just ran.
    (
        "a LOG entry states its event in the future tense",
        ".saipen/LOG.md",
        lambda t: re.sub(r"\] RUN: (?!will )", "] RUN: will ", t, count=1),
        "future tense",
    ),
    # T-432: the newest LOG entry restamped just past the clock slack. The
    # old 3h bound made this control impossible to write honestly -- a stamp
    # 3h out is absurd on sight, while 7 minutes out is exactly what an agent
    # that estimated instead of reading produces.
    (
        "a LOG entry is stamped ahead of the real clock",
        ".saipen/LOG.md",
        stamp_log_ahead,
        "ahead of real UTC",
    ),
    # T-431: two ways a completion claim outran its evidence, one control
    # each. Both mutations leave the CLAIM intact and remove only what backs
    # it -- which is the state both files were shipped in.
    (
        "a ## DONE ticket carries no verify evidence",
        ".saipen/BOARD.md",
        strip_done_verify,
        "no | verify: evidence",
    ),
    (
        "a CONFORMANCE row cites a ticket still open on the board",
        "saipen/CONFORMANCE.md",
        cite_open_ticket,
        "cites unfinished work",
    ),
    (".saipen/ carries a copy of the protocol", ".saipen/RFC.md", CREATE, "§ 1.7"),
    # saiui charter integrity (T-510). Each mutation removes one required
    # element; the validator must catch it.
    (
        "saiui charter drops canonical UI.md reference",
        "extensions/subs/saiui.md",
        # The charter references saipen/UI.md in three places; the old mutation
        # removed one and the validator's substring check was satisfied by the
        # survivors (T-532). Drop every occurrence.
        lambda t: t.replace("saipen/UI.md", "the project's own visual spec"),
        "lost canonical saipen/UI.md",
    ),
    (
        "saiui charter declares a second palette",
        "extensions/subs/saiui.md",
        replace(
            "There is no second palette.",
            "An alternative palette is available for dark-mode projects.",
        ),
        "declares a second palette",
    ),
    (
        "saiui charter drops Golden Default mandate",
        "extensions/subs/saiui.md",
        replace("Golden Default is the mandatory palette.", "A default palette is recommended."),
        "lost the Golden Default mandate",
    ),
    (
        "saiui charter softens main-tree write ban",
        "extensions/subs/saiui.md",
        replace(
            "never write to the main project tree",
            "write to the main project tree only for urgent fixes",
        ),
        "main-tree write ban",
    ),
    (
        "saiui charter removes fixer pen requirement",
        "extensions/subs/saiui.md",
        # `kitchen/pen/` also appears in the charter's table of contents row, so
        # removing the requirement line alone left the substring check satisfied
        # (T-532). Drop every occurrence.
        lambda t: t.replace("kitchen/pen/", "kitchen/direct/"),
        "fixer pen or OUTBOX",
    ),
    # T-549. Every earlier RFC-trap pattern required the literal `RFC.md`,
    # which is how SKILL.md kept routing readers to bare "RFC" through a
    # release that the check called clean. The mutation uses the exact stale
    # sentence that shipped, so the control fails on the real defect rather
    # than on a synthetic one.
    (
        "skill loader points a rule question at RFC",
        "saipen/SKILL.md",
        replace(
            "3. **Rule question? Route through `INDEX.md`**",
            "3. It points into RFC only when a rule question comes up. Route through `INDEX.md`**",
        ),
        "RFC-stub-trap",
    ),
    # T-569. Both halves of the staging order, separately, because they fail
    # differently: losing the ORDER reinstates the paradox (a gate that cannot
    # be satisfied by any documented sequence), while losing the explicit-path
    # rule keeps the order and makes step 5's "staged set equals reviewed
    # scope" proof describe whatever the tree happened to carry.
    # The pre-T-569 shape: the binding gate named in the LOCAL half, above the
    # staging it cannot see. The check reads positions, so the mutation has to
    # move text rather than renumber a label.
    (
        "ship runs its binding gate before staging",
        "saipen/phases/ship.md",
        replace(
            "6a. **LOCAL. Touches no repository and no remote.**",
            "6a. **LOCAL. Touches no repository and no remote.** "
            "Run `tools/validate.py --gate ship` NOW.",
        ),
        "ship-stage-before-gate",
    ),
    (
        "ship permits a blind add",
        "saipen/phases/ship.md",
        replace(
            "**`git add .` and `git add -A` are\n      forbidden here**", "`git add .` is fine here"
        ),
        "must forbid blind `git add .`",
    ),
    # T-541: the machine-readable metadata block is the tool's only way to
    # read a charter's role_kind/collect_policy/role_revision. Drop the yaml
    # language tag so the block stops being machine-readable, and the
    # charter-metadata check must fire.
    (
        "a sai*.md charter stops being machine-readable",
        "extensions/subs/saitest.md",
        replace("```yaml", "```text"),
        "charter-metadata",
    ),
    (
        "specialized producer loses canonical OUTBOX citation",
        "extensions/subs/saitranslate.md",
        replace("PROTOCOL.md § 2 complete package", "PROTOCOL.md § 20 complete package"),
        "output_contract must cite PROTOCOL.md",
    ),
    (
        "specialized producer restores a drifting local OUTBOX field list",
        "extensions/subs/saiui.md",
        replace(
            "the sole owner, and its current § 2 plus § 9 contract binds every entry.",
            "Required fields:\n\n- `status`\n- `producer`\n- `source_head`",
        ),
        "restates moving OUTBOX required fields",
    ),
    (
        "a charter cannot use an arbitrary manual role revision",
        "extensions/subs/saiwiki.md",
        replace(
            'role_revision: "sha256:54a42475a124ab0f27e83d600a284a9cc54d966'
            '8029c4828cfc48512b031df13"',
            'role_revision: "rev1"',
        ),
        "effective charter digest",
    ),
    (
        "every collectable charter binds role revision",
        "extensions/subs/saihunt.md",
        replace(
            'freshness_inputs: ["source_head", "source_tree_fingerprint", "role_revision"]',
            'freshness_inputs: ["source_head", "source_tree_fingerprint"]',
        ),
        "freshness_inputs",
    ),
    (
        "producer packages can never become auto-collected",
        "extensions/subs/saiwiki.md",
        replace("collect_policy: explicit", "collect_policy: automatic"),
        "role_kind PRODUCER requires collect_policy",
    ),
    (
        "scout output cannot bypass Core review",
        "extensions/subs/saihunt.md",
        replace("collect_policy: core-review", "collect_policy: automatic"),
        "role_kind SCOUT requires collect_policy",
    ),
    (
        "collection flow must enforce charter collect_policy",
        "extensions/subs/PROTOCOL.md",
        replace(
            "`collect_policy` is executable routing, not a label",
            "`collect_policy` is descriptive metadata",
        ),
        "collect_policy` is executable routing",
    ),
    (
        "fingerprint framing cannot lose its path length",
        "extensions/subs/PROTOCOL.md",
        replace("path_length[uint64be]", "path"),
        "uint64be",
    ),
    (
        "fingerprint input errors cannot be skipped",
        "extensions/subs/PROTOCOL.md",
        replace("`except OSError: continue` escape hatch.", "best-effort unreadable inputs."),
        "except OSError: continue",
    ),
    (
        "consumer cannot refresh stale package evidence",
        "saipen/CORE.md",
        replace("MUST NOT edit, revalidate, refresh", "may edit, revalidate, or refresh"),
        "MUST NOT edit, revalidate, refresh",
    ),
    (
        "forced-fresh prepare cannot reuse ready output by default",
        "saipen/phases/prepare.md",
        replace("deterministic cache contract", "available cache"),
        "deterministic cache contract",
    ),
    (
        "elapsed time cannot authorize SubSaipen deletion",
        "extensions/subs/PROTOCOL.md",
        replace("Age MAY emit a warning.", "Age makes the instance stale."),
        "Age MAY emit a warning",
    ),
    (
        "repeated collect cannot make a package stale",
        "extensions/subs/PROTOCOL.md",
        replace("Repeated collects MAY leave reviewed", "Repeated collects make reviewed"),
        "Repeated collects MAY leave reviewed",
    ),
    (
        "sub clean refuses unpreserved recovery evidence",
        "extensions/subs/PROTOCOL.md",
        replace("unpreserved recovery evidence", "old recovery evidence"),
        "unpreserved recovery evidence",
    ),
    (
        "ccc must prepare against the shipped HEAD",
        "saipen/CORE.md",
        replace("against the shipped HEAD", "against the current tree"),
        "against the shipped HEAD",
    ),
    (
        "ccc persists its ship-first routing target",
        "saipen/CORE.md",
        replace(
            "`saipen continue` with `converge_target: ship`, then `saipen ship`, then stages J-M",
            "`saipen continue` then `saipen ship` then refresh EE + QQ",
        ),
        "assigned destination changed",
    ),
    (
        "HUNT helpers remain ephemeral rather than SubSaipen",
        "saipen/phases/hunt.md",
        replace("EPHEMERAL WORKERS, not SubSaipen instances", "SubSaipen workers"),
        "EPHEMERAL WORKERS, not SubSaipen instances",
    ),
    (
        "ephemeral workers cannot gain persistent lifecycle state",
        "extensions/subs/PROTOCOL.md",
        replace(
            "never MANIFEST, STATE, BOARD, LOG, kitchen, charter adoption, or lifecycle",
            "temporary MANIFEST and lifecycle records allowed",
        ),
        "never MANIFEST, STATE, BOARD, LOG, kitchen, charter adoption, or lifecycle",
    ),
    (
        "a local PROTOCOL section is checked as local, not RFC",
        "extensions/subs/PROTOCOL.md",
        replace("### 3.1 Built-in role charters", "### 3.2 Built-in role charters"),
        "### 3.1 Built-in role charters",
    ),
    # The barrier only speaks while T-549 is unresolved, and T-549 closed in
    # v7.215.0 -- so stripping T-551's `needs:` alone can no longer go red, and
    # the control silently stopped being evidence. It is not obsolete, it is
    # CONDITIONAL: reopening T-549 must still make T-551 unworkable. The
    # mutation therefore reconstructs both halves of the condition, which is
    # what the check has always been about.
    (
        "T-551 cannot bypass unresolved T-549",
        ".saipen/BOARD.md",
        _t551_bypass,
        "hardening wave barrier missing",
    ),
    (
        "PROTOCOL.md drops UI- prefix from ticket table",
        "extensions/subs/PROTOCOL.md",
        replace("| `UI-` | saiui (fixer, § 9) |", ""),
        "lacks explicit UI- prefix",
    ),
    (
        "PROTOCOL.md drops sai*.md from bootstrap copy list",
        "extensions/subs/PROTOCOL.md",
        # `sai*.md` appears in three rows (spawn + sync); the old mutation
        # removed one and the survivors satisfied the substring check (T-532).
        lambda t: t.replace("sai*.md", "standard files"),
        "sai*.md built-in charters",
    ),
    (
        "SAIUI mission claims SAISENT was audited from this repo",
        ".saipen/kitchen/SAIUI_SAISENT_MISSION.md",
        replace(
            "hypothesis about the current SAISENT UI",
            "confirmed finding -- SAISENT was audited and is non-compliant",
        ),
        "claims the target was audited",
    ),
    (
        "saiui built-in role charter deleted from shipped library",
        "extensions/subs/saiui.md",
        DELETE,
        "saiui built-in role charter",
    ),
    (
        "PROTOCOL.md drops charter-loading from bare-subname adoption",
        "extensions/subs/PROTOCOL.md",
        replace(
            "load it after PROTOCOL.md and before anything else", "proceed with generic adoption"
        ),
        "charter-loading language",
    ),
    (
        "PROTOCOL.md sync softens live-folder guard",
        "extensions/subs/PROTOCOL.md",
        # The validator's regex accepts either "never touch ... <name>" or "never
        # looks inside ... <name>"; the old mutation hit an unrelated read-only
        # sentence and the sync row's second guard phrase survived (T-532). The
        # sync row carries both phrases, so both must go.
        lambda t: t.replace("sync MUST NOT touch any", "sync MAY touch any").replace(
            "it never looks inside a `<name>/` folder", "it may look inside any `<name>/` folder"
        ),
        "live-folder guard",
    ),
]

# W4 retired prose-mutation controls whose anchors moved to REGISTRY.json,
# COMMANDS.md, SOURCES.md, OPS.md, or the machine conformance corpus. Keeping
# them in the runnable denominator would test deleted duplication, not the
# surviving invariant; registry/command/corpus tests own their red evidence.
_W4_RETIRED_PROSE_CONTROLS = frozenset(
    {
        "1.1 drops the gate on new prose",
        "1.10 drops the plan-then-goal pair",
        "1.11 lets a queued command be dropped",
        "1.2 stops sending another instance's work to BLOCKED",
        "1.2 stops sending unfinishable tickets to BLOCKED",
        "BOOT drops the reply-language rule",
        "BOOT fast-path STYLE.md read loses its self-locating reference",
        "BOOT loses a T-404 disjointness anchor bullet",
        "BOOT loses the fast-path section heading",
        "BOOT moves the STYLE.md read out of the numbered fast path",
        "BOOT re-lists STYLE.md as an on-demand rule question",
        "BOOT step 7 drops the duplication ban for shortcut tables",
        "BOOT step 7 drops the memory ban for shortcut tables",
        "BOOT.md presents the precedence rule without the setting",
        "CORE Improve declaration loses cycle-complete",
        "CORE loses exact Improve session routing",
        "CORE.md drops the ahead-stamp repair",
        "HUNT drops out of the from-any-phase set",
        "RFC transition table loses an edge",
        "RFC § 1.10 softens the recall penalty",
        "a CONFORMANCE row cites a ticket still open on the board",
        "bare cc starts convergence from normal intent",
        "bare gg is never a continuation alias",
        "cc never asks for objective text",
        "cc resumes persisted goal intent",
        "cc with arguments is rejected rather than becoming a goal",
        "ccc must prepare against the shipped HEAD",
        "ccc persists its ship-first routing target",
        "consumer cannot refresh stale package evidence",
        "crew command row loses its single-meaning statement",
        "gg with objective creates a new goal",
        "improve clean route loses its never-CLEAN statement",
        "index stops routing to the OPS contract",
        "non-ready collect loses its no-write guarantee",
        "phase-switching command loses its checkpoint duty",
        "shortcut paragraph loses its never-a-greeting duty",
        "shortcut rationale restores stale length magic",
        "shortcut routes to a phase, not a command",
        "shortcut routes to a valid but wrong command",
        "stop paragraph re-asserts an unconditional goal-counter reset",
        "the cc row is mapped back to `saipen goal`",
        "the gg row promises a bare Goal Mode pivot again",
        "translation collect shortcut silently prepares instead",
        "§ 1.2 loses a phase from the ticket-bearing five",
        "§ 1.2 re-hardcodes a superseded schema version",
    }
)
CASES = [case for case in CASES if case[0] not in _W4_RETIRED_PROSE_CONTROLS]

CASES.append(
    (
        # T-1270. The condition needs a file the pristine tree does not have,
        # which is why MULTI learned to carry a creating member: an inbox with
        # no layer routes nothing, so there is no route to ignore.
        #
        # T-1359: and the route only OWNS continuation when the layer it picks
        # binds workable Work. This repository's inbox routes `PHASE SCOUT
        # T-1304`, a ticket parked in `## BLOCKED`, so `audit_route_owns` said
        # no and the control proved nothing -- green on a condition it never
        # reached, for however many releases. The board member releases parked
        # Work so the routed layer is workable, which is the very state the
        # label claims ("a workable layer waits"). Derived from section
        # headers: no ticket id, nothing to rot.
        "audit route ignored while a workable layer waits",
        STATE,
        (
            "MULTI",
            [
                ("audit/1.md", write_new("# audit\n\nfinding one\n")),
                (BOARD, unblock_parked_work),
                (STATE, sub_line("next_action", '"saipen improve"')),
            ],
        ),
        "audit route not followed",
    )
)


# --- T-1359: the eight validator sites the inventory found uncovered --------
#
# `tools/fail_site_inventory.py` names every `fail(...)` site in
# `tools/validate.py` by identity, and the nine it reported with no control
# are closed here. The two activation sites the previous session recorded as
# "not file-mutable" ARE mutable: the validator imports `installed_relpath`
# from the tree under audit, so deleting or misprogramming the module the
# import resolves to expresses exactly the condition the site tests. Measured,
# not assumed -- both go red on a pristine copy.
#
# None of these anchors on a ticket id. Three of the conditions are about
# board shape, and CASES run against a copy of the LIVE home, so a control
# naming a fixed id rots the next time the board moves: the board mutations
# below read the board they are handed and derive their own target.


def drop_home_placeholder(text: str) -> str:
    """Strip the substitution marker the injector rewrites per home."""
    return text.replace("{{SAIPEN_HOME}}", "SAIPEN_HOME")


def extra_converge_target(text: str) -> str:
    """Give CONVERGE.md a stage CORE.md never declared."""
    return re.sub(
        r"(?m)^converge_targets:(.*)$",
        lambda match: f"converge_targets:{match.group(1)} | polish",
        text,
        count=1,
    )


def divert_shortcut_route(text: str) -> str:
    """Point the first shortcut row at a command the registry does not own."""
    return re.sub(
        r"(?m)^\| `([a-z]{2,3})` \| `([^`]*)` \|",
        lambda match: f"| `{match.group(1)}` | `saipen not-a-command` |",
        text,
        count=1,
    )


def unallocated_board_ticket(text: str) -> str:
    """File a record no allocation event ever journalled."""
    marker = "## TODO\n"
    if marker not in text:
        return text
    return text.replace(
        marker,
        marker + "- [ ] T-9998 [P3] synthetic allocation control | needs:  | verify: n/a\n",
        1,
    )


def misland_activation_template(text: str) -> str:
    """Make the source->installed path mapping disagree with the runtime."""
    anchor = (
        "    if relative.startswith(_SOURCE_PREFIX):\n"
        "        return relative[len(_SOURCE_PREFIX) :]\n"
    )
    return text.replace(
        anchor,
        "    if relative.startswith(_SOURCE_PREFIX):\n"
        "        return relative[len(_SOURCE_PREFIX) :] + '.landed'\n",
        1,
    )


CASES.extend(
    [
        (
            "activation template deleted",
            ACTIVATION,
            DELETE,
            "activation template -- saipen/ACTIVATION_BLOCK.md missing",
        ),
        (
            "activation template loses its home placeholder",
            ACTIVATION,
            drop_home_placeholder,
            "ACTIVATION_BLOCK.md missing '{{SAIPEN_HOME}}'",
        ),
        (
            "the module the activation check imports disappears",
            AUTOINJECT,
            DELETE,
            "activation template -- installed_relpath unavailable",
        ),
        (
            "installed_relpath stops mapping the activation template home",
            RUNTIME_SURFACE,
            misland_activation_template,
            "activation template -- installed_relpath maps",
        ),
        (
            "CONVERGE.md gains a target CORE.md does not declare",
            CONVERGE,
            extra_converge_target,
            "CONVERGE.md `converge_targets:` set differs from CORE.md by",
        ),
        (
            "COMMANDS.md shortcut row leaves the registry behind",
            COMMANDS,
            divert_shortcut_route,
            "cross-doc drift [commands-vs-registry]",
        ),
        (
            "BOARD record with no allocation event",
            BOARD,
            unallocated_board_ticket,
            "has no [T-###] allocation event in the complete history",
        ),
    ]
)


def apply_case(root: Path, rel: str, mutation) -> bool:
    """Returns False when the case cannot be set up (skip it loudly)."""
    p = case_target(root, rel, mutation)
    if mutation == SYMLINK_EXTERNAL:
        if not p.is_file() or p.is_symlink():
            return False
        external = root.parent / "audit-external-identity.md"
        external.write_bytes(p.read_bytes())
        p.unlink()
        try:
            os.symlink(external, p)
        except (OSError, NotImplementedError):
            return False
        return True
    if mutation == DELETE:
        if not p.exists():
            return False
        p.unlink()
        return True
    if mutation == CREATE:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("copied protocol\n", encoding="utf-8")
        return True
    if isinstance(mutation, tuple) and mutation[0] == "WRITE":
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(mutation[1], encoding="utf-8", newline="\n")
        return True
    if mutation == SWAP:
        lines = p.read_text(encoding="utf-8-sig").splitlines(True)
        idx = [i for i, ln in enumerate(lines) if ln.startswith("- ")]
        if len(idx) < 2:
            return False
        a, b = idx[-2], idx[-1]
        lines[a], lines[b] = lines[b], lines[a]
        p.write_text("".join(lines), encoding="utf-8", newline="\n")
        return True
    if mutation == UTF16:
        if not p.exists():
            return False
        text = p.read_text(encoding="utf-8-sig")
        p.write_bytes(text.encode("utf-16"))
        return True
    if isinstance(mutation, tuple) and mutation and mutation[0] == "MULTI":
        # A case whose red condition spans two files (e.g. the session-level
        # BLOCKED check, which needs STATE.phase AND a workable board ticket).
        # Every file listed must be present; the case applies if any changed.
        changed = False
        for r, fn in mutation[1]:
            fp = root / r
            if _member_creates(fn):
                fp.parent.mkdir(parents=True, exist_ok=True)
                body = "copied protocol\n" if fn == CREATE else fn[1]
                fp.write_text(body, encoding="utf-8", newline="\n")
                changed = True
                continue
            if not fp.is_file():
                continue
            text = fp.read_text(encoding="utf-8-sig")
            mutated = fn(text)
            if mutated != text:
                fp.write_text(mutated, encoding="utf-8", newline="\n")
                changed = True
        return changed
    if not p.exists():
        return False
    text = p.read_text(encoding="utf-8-sig")
    mutated = mutation(text)
    if mutated == text:
        return False
    p.write_text(mutated, encoding="utf-8", newline="\n")
    return True


def validator_output(root: Path, gate: str | None = None) -> str:
    """Only the FAIL/WARN lines. Searching the whole output matched PASS text:
    "at most one", "cyclic" and "dangling needs" all appear in the lines that
    say those very checks PASSED, so five cases scored as proving nothing when
    the harness was the thing at fault."""
    env = hermetic_child_env(SAIPEN_VALIDATE_ALL_WARNINGS="1")
    r = subprocess.run(
        [sys.executable, str(root / "tools" / "validate.py"), *(["--gate", gate] if gate else [])],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        errors="replace",
    )
    keep = [
        ln
        for ln in (r.stdout + r.stderr).splitlines()
        if ln.startswith(("FAIL", "WARN", "Traceback")) or "Error" in ln
    ]
    return "\n".join(keep)


def case_parts(case):
    """Unpack a CASES entry, which is 4 items or 5.

    The optional 5th is the validator GATE the case must run at. T-568 made
    producer-package severity a property of the gate, so a producer control
    left on the default gate would see its FAIL demoted to a WARN -- and this
    harness deliberately keeps WARN lines, so such a case would go on
    reporting itself as evidence while proving only that the defect is
    NOTICED, never that it is refused. A control has to run where its finding
    is hard.
    """
    label, rel, mutation, expected = case[:4]
    return label, rel, mutation, expected, (case[4] if len(case) > 4 else None)

# ---------------------------------------------------------------------------
# Development-time scoping (T-1273)
# ---------------------------------------------------------------------------
#
# The full sweep runs the validator once per control. That is 229 validator
# runs and about 26 minutes, which a release earns and a two-file change does
# not. Every CASE already declares the file it mutates, so a changed-path set
# selects the controls that can possibly be affected.
#
# The whole risk is that the accelerator becomes the gate. Three things keep it
# from doing so, and none of them is a convention someone has to remember:
# the subset requires an explicit flag, so `python tools/audit_checks.py` with
# no arguments -- which is exactly what CI runs -- is always the full sweep;
# `saipen ship` never invokes this file at all; and a scoped run never prints
# the "N of 229" sentence a checkpoint would quote, so its output cannot be
# mistaken for the full sweep even when pasted.

FULL_CASE_COUNT = len(CASES)

#: Printed by every scoped run. Selection reads the DECLARED target, which is
#: the only thing decidable without building a tree -- and is therefore blind
#: to a control whose own target is untouched but whose validator check reads
#: a changed file through a cross-reference. Naming that is the difference
#: between a bounded accelerator and a silent false negative.
SCOPED_LIMITATIONS = (
    "selection reads each control's DECLARED target file only. A control whose "
    "target is untouched but whose check reads a changed file indirectly -- a "
    "cross-document rule, a manifest, a schema another file is validated "
    "against -- is NOT selected and is NOT proven by this run",
    "the always-on probes still run; only the per-control sweep is narrowed",
)


def _split_changed(raw: str) -> set[str]:
    """Normalize one `--changed` value into comparable repo-relative paths."""
    out: set[str] = set()
    for part in raw.split(","):
        text = part.strip().replace("\\", "/")
        while text.startswith("./"):
            text = text[2:]
        if text:
            out.add(text)
    return out


def scoped_paths(argv: list[str]) -> frozenset[str] | None:
    """The changed-path set from `--changed`, or None meaning the full sweep.

    None is returned for an absent flag AND for nothing else: an empty
    `--changed` still means "scoped, and nothing matched", because silently
    upgrading an empty selection to the full sweep would let a mistyped
    invocation report a total the caller did not ask for.
    """
    paths: set[str] = set()
    seen = False
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--changed":
            seen = True
            index += 1
            if index < len(argv):
                paths.update(_split_changed(argv[index]))
        elif arg.startswith("--changed="):
            seen = True
            paths.update(_split_changed(arg.split("=", 1)[1]))
        index += 1
    return frozenset(paths) if seen else None


def case_declared_paths(rel: str, mutation) -> set[str]:
    """Every path a case DECLARES it mutates, normalized to forward slashes.

    A MULTI mutation names several files; every other mutation names exactly
    `rel`. This reads the declaration and never the disk, so selection is
    decidable before any tree exists.
    """
    if isinstance(mutation, tuple) and mutation and mutation[0] == "MULTI":
        return {str(r).replace("\\", "/") for r, _ in mutation[1]}
    return {str(rel).replace("\\", "/")}


def scoped_banner(selected: int, changed: frozenset[str]) -> list[str]:
    """The opening lines of a scoped run: what was narrowed, and what that hides.

    Pure for the same reason as `sweep_report`. The limitations are the
    honest half of the feature -- an accelerator that does not say what it
    skipped is just a faster way to be wrong -- so they are proven by a test
    rather than by someone remembering to read the banner.
    """
    lines = [
        f"SCOPED: {selected} of {FULL_CASE_COUNT} control(s) selected by --changed "
        f"({len(changed)} path(s)). This is NOT the full sweep."
    ]
    lines.extend(f"SCOPED: known limitation -- {text}" for text in SCOPED_LIMITATIONS)
    return lines


#: The one sentence a checkpoint quotes as proof the suite is intact. It
#: belongs to the full sweep and to nothing else, which is why it is a
#: constant a test can assert the absence of rather than a literal typed in
#: two places that could drift into agreement.
FULL_SWEEP_PHRASE = "validator check(s) still go red on their own condition"


def sweep_report(changed, selected: int, live: int, skipped: int, broken: int) -> list[str]:
    """The closing lines of one sweep, as text.

    Pure on purpose. The promise this mode makes is that a scoped run never
    emits the full-sweep sentence, and a promise provable only by running a
    26-minute gate is a promise nobody re-checks.
    """
    if changed is None:
        if broken:
            return [f"\n{broken} of {selected} case(s) are not evidence any more."]
        tail = f" ({skipped} skipped)" if skipped else ""
        return [f"PASS: {live} of {selected} {FULL_SWEEP_PHRASE}{tail}"]
    unrun = FULL_CASE_COUNT - selected
    if broken:
        return [
            f"\nSCOPED: {broken} of the {selected} selected case(s) are not "
            f"evidence any more. The other {unrun} control(s) were never run."
        ]
    return [
        f"SCOPED: the {live} selected control(s) each went red on their own "
        f"condition. This proves nothing about the {unrun} control(s) that were "
        "not run, and is not audit_checks evidence for a checkpoint or a release."
    ]


def select_cases(cases, changed: frozenset[str]) -> list:
    """The controls whose declared target appears in the changed-path set."""
    chosen = []
    for case in cases:
        _, rel, mutation, _, _ = case_parts(case)
        if case_declared_paths(rel, mutation) & changed:
            chosen.append(case)
    return chosen


class ProbeContext:
    """What an always-on probe is handed, plus what earlier probes produced.

    `sandbox` is this probe's own scratch directory: the runner creates it,
    the runner deletes it, and no probe can leave a fixture behind for the
    next one to trip over. `pristine` and `control` are built by probes that
    later probes DECLARE as prerequisites, so a probe never silently reads a
    fixture that was never built.
    """

    def __init__(self, tmp: Path, cases: list, changed: frozenset[str] | None) -> None:
        self.tmp = tmp
        self.cases = cases
        self.changed = changed
        self.sandbox = tmp
        self.pristine: Path | None = None
        self.control: str | None = None
        self.extra: list[str] = []


@dataclass(frozen=True)
class Probe:
    """One always-on check, isolated from every other one.

    `requires` names the probes whose product this one reads. A probe with no
    prerequisite is INDEPENDENT and always runs -- that is the whole point:
    `main` used to be a chain of `if error: return 1`, so the first failure
    hid every check behind it and the validator fail-site drift that opened
    T-1359 sat invisible behind an earlier probe for an unknown number of
    releases. A dependent probe whose prerequisite failed is SKIPPED OUT LOUD,
    naming the prerequisite, rather than disappearing.
    """

    name: str
    run: "Callable[[ProbeContext], str | None]"
    passed: str
    requires: tuple[str, ...] = ()


def run_probes(probes, context: ProbeContext, out=print) -> dict[str, str]:
    """Give every probe a verdict in one invocation. Never stop at the first.

    Returns {probe name: PASS|FAIL|SKIP}. The caller derives rc from it, once,
    at the end -- there is no early exit anywhere in this layer.
    """
    verdicts: dict[str, str] = {}
    for probe in probes:
        blocked = next((name for name in probe.requires if verdicts.get(name) != "PASS"), None)
        if blocked is not None:
            verdicts[probe.name] = "SKIP"
            out(f"SKIP: {probe.name} because prerequisite {blocked} failed")
            continue
        sandbox = context.tmp / f"probe-{probe.name}"
        context.sandbox = sandbox
        context.extra = []
        try:
            sandbox.mkdir(parents=True, exist_ok=True)
            error = probe.run(context)
        except Exception as exc:  # a probe that explodes is a failed probe
            error = f"{type(exc).__name__}: {exc}"
        finally:
            # The probe owns its cleanup whatever happened inside it, so a
            # failure cannot poison the fixture the next probe is handed.
            shutil.rmtree(sandbox, ignore_errors=True)
            context.sandbox = context.tmp
        if error:
            verdicts[probe.name] = "FAIL"
            out(f"FAIL: {probe.name} -- {error}")
        else:
            verdicts[probe.name] = "PASS"
            out(f"PASS: {probe.passed}")
        for line in context.extra:
            out(line)
    return verdicts


def build_pristine(context: ProbeContext) -> str | None:
    """The known-good copy every mutation control is measured against."""
    pristine = context.tmp / "pristine"
    shutil.rmtree(pristine, ignore_errors=True)
    shutil.copytree(HOME, pristine, ignore=IGNORE)
    rebind_synthetic_milestones(pristine)
    freshen_synthetic_outboxes(pristine)
    synthetic_outboxes = list(pristine.glob(".saipen/extensions/subs/*/kitchen/OUTBOX.md"))
    synthetic_translate = pristine / ".saipen" / "saitranslate" / "kitchen" / "OUTBOX.md"
    if synthetic_translate.is_file():
        synthetic_outboxes.append(synthetic_translate)
    for outbox in synthetic_outboxes:
        text = outbox.read_text(encoding="utf-8-sig")
        text = text.replace("**status:** ready", "**status:** stale")
        text = re.sub(r"(?m)^status:\s*ready\s*$", "status: stale", text)
        outbox.write_text(text, encoding="utf-8", newline="\n")
    context.pristine = pristine
    return None


def inventory_probe(context: ProbeContext) -> str | None:
    error = check_inventory_probe(context.pristine, context.sandbox)
    if error:
        return error
    source = (context.pristine / inventory.VALIDATOR_REL).read_text(encoding="utf-8-sig")
    context.extra.append(
        f"NOTE: {count_fail_sites(source)} fail site(s) recorded by identity in "
        f"{VALIDATOR_FAIL_SITE_LEDGER}"
    )
    context.extra.append(f"NOTE: known limitation -- {CHECK_INVENTORY_LIMITATION}")
    return None


def tag_query_probe(context: ProbeContext) -> str | None:
    """The release-ledger query is observed exactly once, and both controls fire.

    Also refuses to bless a stuck-red validator: a validator that FAILs for an
    unrelated reason would make "the query ran" meaningless, so the pristine
    STATE is deliberately broken, an error is required, and the bytes go back
    in a `finally` -- this probe used to restore by hand after the check, so an
    early return between the two left the shared tree mutated.
    """
    pristine = context.pristine
    query_count, query_error = observed_tag_queries(pristine)
    red_tree = context.sandbox / "duplicate-tag-query"
    shutil.copytree(pristine, red_tree)
    setup_error = duplicate_tag_query(red_tree / "tools" / "validate.py")
    red_count, red_error = observed_tag_queries(red_tree)
    if query_error or setup_error or red_error or query_count != 1 or red_count != 2:
        problem = query_error or setup_error or red_error
        if problem is None:
            problem = (
                f"observed {query_count} tag queries; expected 1"
                if query_count != 1
                else f"duplicate red-control observed {red_count}; expected 2"
            )
        return problem

    state_path = pristine / STATE
    state_source = state_path.read_text(encoding="utf-8-sig")
    try:
        state_path.write_text(
            re.sub(r"^phase:.*$", "phase: NOT-A-PHASE", state_source, count=1, flags=re.MULTILINE),
            encoding="utf-8",
            newline="\n",
        )
        _, invalid_control_error = observed_tag_queries(pristine)
    finally:
        state_path.write_text(state_source, encoding="utf-8", newline="\n")
    if invalid_control_error is None:
        return "a validator control that was deliberately stuck red was accepted"
    return None


def validator_baseline_probe(context: ProbeContext) -> str | None:
    """Every expectation in the mutation table must be ABSENT here."""
    control = validator_output(context.pristine)
    if "Traceback" in control:
        return (
            "the validator crashes on an unmodified copy -- fix that before "
            f"trusting any case below: {control[-400:]}"
        )
    failure = next((line for line in control.splitlines() if line.startswith("FAIL")), None)
    if failure:
        return (
            "the validator rejects an unmodified copy -- fix the known-good "
            f"control before trusting mutation results: {failure[:400]}"
        )
    context.control = control
    return None


def no_op_mutation_probe(context: ProbeContext) -> str | None:
    """A callable that changes nothing is not an applied mutation.

    The goal-counter case once hard-coded the exact integer live STATE already
    carried, so the validator saw an untouched tree and the suite still counted
    the case as evidence. Removing the equality check in `apply_case` makes
    this control fail.
    """
    if apply_case(context.pristine, STATE, lambda text: text):
        return "callable no-op mutation was accepted as applied"
    return None


def gated_producer_probe(context: ProbeContext) -> str | None:
    """A producer-package case naming no gate measures nothing (T-568).

    Structural, because the weakening is invisible in the result: the sweep
    total is the same either way. Reads only the case table, so it is
    independent of every fixture.
    """
    ungated = [
        parts[0]
        for parts in map(case_parts, context.cases)
        if isinstance(parts[1], str) and parts[1].endswith("OUTBOX.md") and parts[4] is None
    ]
    if ungated:
        return (
            "producer findings are WARNs outside `--gate collect:<producer>`, so "
            "these cases would pass on a warning and prove no refusal (T-568): "
            + ", ".join(repr(label) for label in sorted(ungated))
        )
    return None


def case_availability_probe(context: ProbeContext) -> str | None:
    """The mutation suite cannot start with a changing denominator."""
    unavailable = [
        parts[0]
        for parts in map(case_parts, context.cases)
        if not case_available(context.pristine, parts[1], parts[2])
    ]
    if unavailable:
        return "skipped canonical mutation(s): " + ", ".join(sorted(unavailable))
    return None


def mutation_sweep_probe(context: ProbeContext) -> str | None:
    """Every case breaks the copy in one way; the validator must name it."""
    pristine, control, cases = context.pristine, context.control, context.cases

    # One control per gate in use, measured on the UNMODIFIED copy. A gated
    # case must be judged against its own gate's baseline: a finding the
    # pristine tree already prints at that gate proves nothing there either.
    gate_controls = {None: control}

    def control_for(gate):
        if gate not in gate_controls:
            gate_controls[gate] = validator_output(pristine, gate)
        return gate_controls[gate]

    def matched(output: str, expected: str, gate: str | None) -> bool:
        """Did the validator report `expected`, at the severity the case claims?

        Naming a gate IS the claim that the finding is hard there, so a gated
        case is only satisfied by a FAIL line. Without this the gate would be
        decoration: the WARN this harness keeps on purpose carries the same
        text, and a control that accepts it proves the defect was noticed
        rather than refused (T-568).
        """
        if gate is None:
            return expected in output
        return any(ln.startswith("FAIL") and expected in ln for ln in output.splitlines())

    dead, skipped, always = [], [], []
    runnable = []
    for label, rel, mutation, expected, gate in map(case_parts, cases):
        if matched(control_for(gate), expected, gate):
            always.append((label, expected))
            continue
        runnable.append((label, rel, mutation, expected, gate))

    worker_count = min(8, max(1, os.cpu_count() or 1), max(1, len(runnable)))
    chunks = [runnable[index::worker_count] for index in range(worker_count)]

    # One copy per worker, not one per case. Every case touches exactly one
    # file, so saving that file's bytes and putting them back is equivalent to
    # a fresh tree and turns 41 copytrees of a repo carrying 32 locale
    # directories into one. The difference is four minutes against twenty
    # seconds, which is the difference between a gate CI runs and a gate
    # someone deletes.
    def run_chunk(index, chunk):
        worker_root = context.sandbox / f"cases-{index:02d}"
        local_dead = []
        local_skipped = []
        try:
            shutil.copytree(pristine, worker_root, ignore=IGNORE)
            worker_control = validator_output(worker_root)
            if worker_control != control:
                return local_dead, local_skipped, "worker copy changed validator baseline"
            for label, rel, mutation, expected, gate in chunk:
                files = mutation_files(worker_root, rel, mutation)
                saved = [(path, path.read_bytes() if path.exists() else None) for path in files]
                try:
                    if not apply_case(worker_root, rel, mutation):
                        local_skipped.append(label)
                        continue
                    if not matched(validator_output(worker_root, gate), expected, gate):
                        # Carry WHY, not just THAT. A dead control is almost
                        # always an anchor that stopped being unique, and the
                        # count is the whole diagnosis (T-1264).
                        local_dead.append(
                            (label, expected, anchor_occurrences(mutation, worker_root / rel))
                        )
                finally:
                    restore_case_files(saved)
            if validator_output(worker_root) != control:
                return local_dead, local_skipped, "mutation restoration left a drifting tree"
            return local_dead, local_skipped, None
        finally:
            shutil.rmtree(worker_root, ignore_errors=True)

    worker_errors = []
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = {
            executor.submit(run_chunk, index, chunk): index
            for index, chunk in enumerate(chunks)
        }
        for future in as_completed(futures):
            index = futures[future]
            try:
                chunk_dead, chunk_skipped, chunk_error = future.result()
            except Exception as exc:  # defensive: a worker failure is a gate failure
                worker_errors.append(f"worker {index}: {type(exc).__name__}: {exc}")
                continue
            dead.extend(chunk_dead)
            skipped.extend(chunk_skipped)
            if chunk_error:
                worker_errors.append(f"worker {index}: {chunk_error}")

    if worker_errors:
        return "parallel mutation worker -- " + "; ".join(sorted(worker_errors))
    dead.sort()
    skipped.sort()
    always.sort()

    for label, expected in always:
        context.extra.append(
            f"FAIL: {label!r} expects {expected!r}, which the UNMODIFIED "
            f"repository already prints -- the case proves nothing"
        )
    for label in skipped:
        # The old wording blamed a missing FILE, and a skip is far more often
        # a present file whose ANCHOR moved -- a LOG line sealed into a
        # segment at the next cap crossing being the usual way. That message
        # sent its own author hunting for a file that was sitting right there.
        context.extra.append(
            f"SKIP: {label} -- the mutation changed nothing: the file is "
            f"missing, or its anchor text is (a LOG anchor sealed into "
            f".saipen/logs/ is the usual cause)"
        )
    for entry in dead:
        label, expected = entry[0], entry[1]
        occurrences = entry[2] if len(entry) > 2 else None
        why = ""
        if occurrences == 0:
            why = " -- its anchor is no longer in the file"
        elif occurrences and occurrences > 1:
            why = (
                f" -- its anchor appears {occurrences} times in the target, and "
                f"`replace` mutates only the first; use `replace_all`"
            )
        context.extra.append(
            f"FAIL: {label} -- the validator did not report {expected!r}. "
            f"That check no longer goes red on its own condition{why}"
        )

    live = len(cases) - len(dead) - len(skipped) - len(always)
    broken = len(dead) + len(always) + len(skipped)
    context.extra.extend(sweep_report(context.changed, len(cases), live, len(skipped), broken))
    if broken:
        return f"{broken} of {len(cases)} mutation control(s) no longer prove anything"
    return None


def always_on_probes() -> tuple[Probe, ...]:
    """The probe table `main` runs. Order is dependency order, not priority.

    The first four read no shared fixture at all, so nothing above them can
    stop them running -- which is the property T-1359 exists to restore.
    """
    return (
        Probe(
            "root-nul-snapshot",
            lambda ctx: root_device_ignore_probe(ctx.sandbox),
            "a real root `nul` entry is excluded from audit snapshots",
        ),
        Probe(
            "symlink-restore",
            lambda ctx: symlink_restore_probe(ctx.sandbox),
            "mutation restoration unlinks symlinks before restoring owned bytes",
        ),
        Probe(
            "audit-tags-batch",
            lambda ctx: audit_tags_batch_probe(HOME, ctx.sandbox),
            "audit-tags missing-Git skip plus enumeration, nonzero, malformed, "
            "truncated, and surplus fail-closed controls behave",
        ),
        Probe(
            "gated-producer-cases",
            gated_producer_probe,
            "every producer-OUTBOX control runs at a gate where its finding is hard",
        ),
        Probe(
            "pristine-fixture",
            build_pristine,
            "a known-good copy of this repository is built for the mutation controls",
        ),
        Probe(
            "release-ledger",
            lambda ctx: release_ledger_probe(ctx.pristine, ctx.sandbox),
            "release-ledger clean/new-tag/new-changelog/stale-baseline controls "
            "behave distinctly",
            requires=("pristine-fixture",),
        ),
        Probe(
            "validator-check-inventory",
            inventory_probe,
            "tools/validate.py declares exactly the adjudicated fail sites, and "
            "added, removed and same-count SWAPPED sites are each named",
            requires=("pristine-fixture",),
        ),
        Probe(
            "warn-slug-ownership",
            lambda ctx: warn_ownership_probe(ctx.pristine, ctx.sandbox),
            "aged unowned WARN slug fails; identical aged slug with a live "
            "naming ticket passes; baseline data, never validator wording",
            requires=("pristine-fixture",),
        ),
        Probe(
            "phase-rename",
            lambda ctx: phase_rename_probe(ctx.pristine, ctx.sandbox),
            "consistent SCOUT->SCOUTX rename stays green across the DFA, RFC "
            "table, schema enum and phase doc -- edge gates catch drift, not "
            "deliberate renames",
            requires=("pristine-fixture",),
        ),
        Probe(
            "release-ledger-runtime-query",
            tag_query_probe,
            "release-ledger tag query is observed once; duplicate-query and "
            "invalid-validator controls both go red",
            requires=("pristine-fixture",),
        ),
        Probe(
            "validator-baseline",
            validator_baseline_probe,
            "the unmodified copy validates clean, so every expectation below "
            "is absent before its mutation",
            requires=("pristine-fixture",),
        ),
        Probe(
            "callable-no-op-mutation",
            no_op_mutation_probe,
            "callable no-op mutations are rejected before validation",
            requires=("pristine-fixture",),
        ),
        Probe(
            "case-availability",
            case_availability_probe,
            "every canonical mutation has its target, so the denominator holds still",
            requires=("pristine-fixture",),
        ),
        Probe(
            "mutation-sweep",
            mutation_sweep_probe,
            "every canonical mutation still drives its own check red",
            requires=("pristine-fixture", "validator-baseline"),
        ),
    )


def main() -> int:
    changed = scoped_paths(sys.argv[1:])
    cases = select_cases(CASES, changed) if changed is not None else CASES
    if changed is not None:
        for line in scoped_banner(len(cases), changed):
            print(line)

    tmp = Path(tempfile.mkdtemp(prefix="audit_checks_"))
    try:
        verdicts = run_probes(always_on_probes(), ProbeContext(tmp, cases, changed))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # One exit, computed from the report. Not a style preference: an early
    # `return 1` anywhere above is exactly the shape that hid the validator
    # fail-site drift, and `test_check_inventory.py` asserts this function
    # contains none.
    failed = sorted(name for name, verdict in verdicts.items() if verdict == "FAIL")
    skipped = sorted(name for name, verdict in verdicts.items() if verdict == "SKIP")
    if failed or skipped:
        print(
            f"AUDIT: {len(verdicts) - len(failed) - len(skipped)} of {len(verdicts)} "
            f"probes passed; failed: {', '.join(failed) or 'none'}; "
            f"skipped: {', '.join(skipped) or 'none'}"
        )
    else:
        print(f"AUDIT: all {len(verdicts)} always-on probes passed")
    return 0 if not (failed or skipped) else 1


if __name__ == "__main__":
    sys.exit(main())
