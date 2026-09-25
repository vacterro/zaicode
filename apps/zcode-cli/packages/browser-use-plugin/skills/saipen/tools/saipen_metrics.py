#!/usr/bin/env python
"""Report what SAIPEN cost and produced, from evidence the repository already keeps.

Every gate in this repository measures whether the protocol is INTERNALLY
correct: validate.py, audit_checks.py, run_scenarios.py, protocol_budget.py.
None of them measures whether the protocol is WORTH running. That gap is why a
project can stay green for four hundred commits while the honest question --
"does this make real work go faster?" -- never gets a number attached.

This tool answers the part of that question the repository can already prove,
and refuses to guess the rest.

It adds no protocol law, no state, no gate and no instrumentation. It reads git
history and `.saipen/LOG.md`, both of which are written for other reasons and
cannot be tuned to flatter this report. Delete this file and the protocol
behaves identically -- which is the point: a measuring instrument that changes
what it measures is not evidence.

    python tools/saipen_metrics.py                 # text report, default window
    python tools/saipen_metrics.py --since 2026-08-01
    python tools/saipen_metrics.py --json
    python tools/saipen_metrics.py --transcripts ~/.claude/projects/<project>

Token traffic is the one number the repository cannot hold, because it lives in
agent transcripts. `--transcripts DIR` scans JSONL session files for per-message
`usage` objects, keeping only records whose own timestamp falls inside the
report window, so the token sample and the ticket count describe the same days.
The scan is deliberately vendor-shaped rather than vendor-specific: any harness
that writes one JSON object per line with an `input_tokens`/`output_tokens`
usage record is read the same way. Three outcomes stay distinct: no directory
given, a directory read that held nothing datable in the window, and records
found. Collapsing the middle case into "not scanned" discards work that was
actually done.

The resulting ratio is WINDOW economics, deliberately named that way: normalized
units consumed in the window over tickets closed in the window. The numerator includes
open tickets, abandoned attempts, audits and research, so it compares one period
against another and never says what a single ticket cost. Attributing spend to a
ticket would need attribution state this tool refuses to grow -- a precisely
named coarse number beats a falsely precise attributed one.

Two honesty rules govern that ratio. It is withheld when any usage record in the
store carries no readable timestamp, because a sample that cannot be aligned to
the window cannot be divided by the window's tickets, and it is withheld again
when the window closed nothing -- "not attributable from existing evidence" is a
result, not a gap to paper over. It is a LOWER BOUND even when reported: the
store holds one harness's sessions, while a ticket may have been worked by
several.

Cache reads and writes carry different rates, so the totals are also reported
as NORMALIZED UNITS: one unit is one fresh input token of traffic, with cache
writes converted at 1.25x and cache reads at 0.1x. Those two are real published
ratios. Output is counted at face value and not at its price, which is several
times input, so the total is a usage proxy and never money -- enough to compare
one period against another, which is the only question asked here. The raw token
counts stay printed beside it. Weighting changes how traffic is compared, never
how many tokens were processed.

What it still CANNOT measure, and will not pretend to:

    quality of the outcome     -- needs a comparison run against a plain agent
    human wall-clock saved     -- needs the human, not the history

Those two are the experiment SAIPEN still owes itself. RUNTIME.md already
forbids claiming speed or token improvements without measurements; this tool is
built to keep that rule honest rather than to route around it.

The acceptance section reuses `saipen_engine.acceptance` rather than reparsing
criteria here. The import is ONE-WAY and lazy: this tool reads the engine, the
engine never reads this tool, so deleting this file still changes nothing. A
second criterion parser would be worse than a dependency -- two parsers drift,
and the number this section reports would slowly stop describing the projection
`saipen acceptance` shows for the same ticket.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from saipen_engine.acceptance import ESCAPED_CLASSES

REPO = Path(__file__).resolve().parent.parent

# The SAIPEN self-surface: everything here is the protocol working on itself. A
# path OUTSIDE this set is the only kind of change that produces something a
# user of SAIPEN, rather than an author of SAIPEN, receives.
#
# In THIS repository the list covers the whole tree on purpose, so the honest
# reading of external_share here is 0.0 -- the protocol has shipped itself and
# nothing else. The number only becomes informative in a repository where
# SAIPEN is used ON a product, where the self-surface is just the first three
# prefixes and everything else is the product.
SELF_SURFACE = (
    "tools/",
    "saipen/",
    ".saipen/",
    ".saiwork/",
    "bootstrap/",
    "audit/",
    "tests/",
    "guides/",
    "extensions/",
    "KNOWLEDGE/",
    ".github/",
)
SELF_SURFACE_FILES = (
    "VERSION",
    "CHANGELOG.md",
    "CHANGELOG_ARCHIVE.md",
    "ruff.toml",
    ".gitignore",
    ".gitattributes",
    "LICENSE",
)

TICKET_RE = re.compile(r"\bT-\d+\b")
LOG_LINE_RE = re.compile(
    r"^- (?P<date>\d\d\.\d\d\.\d\d) (?P<time>\d\d:\d\d) \[E-(?P<event>\d+)\]"
    r"(?: \[parent: [^\]]*\])?"
    r"(?: \[(?P<ticket>T-\d+)\])?"
    r"(?: \[agent: (?P<agent>[^\]]*)\])?"
    r"(?: \[op: (?P<op>[^\]]*)\])?"
    r" (?P<body>.*)$"
)
TRANSITION_RE = re.compile(r"transition to ([A-Z]+)")

# A phase already reached and then re-entered from a LATER phase is rework: the
# work was declared finished and was not. Re-entering the SAME phase is not --
# it is a retry or a duplicate journal event, and folding the two together
# inflates rework with noise. They are counted separately for that reason.
PHASE_ORDER = {"SCOUT": 0, "BUILD": 1, "VERIFY": 2, "REVIEW": 3, "SHIP": 4, "DONE": 5}


def git(*args: str) -> str:
    out = subprocess.run(
        ["git", "-C", str(REPO), *args],
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        return ""
    return out.stdout


def is_self_surface(path: str) -> bool:
    if path.startswith(SELF_SURFACE) or path in SELF_SURFACE_FILES:
        return True
    # Every README translation is documentation OF the protocol.
    return path.startswith("README") and path.endswith(".md")


def git_since(since: str) -> str:
    """A date git reads as MIDNIGHT, not as this moment on that date.

    `git log --since=2026-09-02` does not mean "from the start of 2026-09-02".
    Approxidate resolves a dateless day using the CURRENT time of day, so on a
    day carrying nine releases that argument returned zero commits while
    `--since=2026-09-01` returned twenty-eight. The LOG side of this report
    compares date strings and is midnight-anchored, so the two halves of one
    window meant different instants and the report lost a day without saying
    so. Spelling the time out is the whole fix.
    """
    return f"{since} 00:00:00"


def rev_at(since: str) -> str:
    """The last commit strictly before the window, or the root commit."""
    rev = git("rev-list", "-1", "--before=" + git_since(since), "HEAD").strip()
    if rev:
        return rev
    roots = git("rev-list", "--max-parents=0", "HEAD").strip().splitlines()
    return roots[0] if roots else "HEAD"


def law_bytes(rev: str) -> int:
    """Bytes of LLM-readable protocol law -- the Markdown an agent must read."""
    total = 0
    for line in git("ls-tree", "-r", "-l", rev, "--", "saipen").splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[1] != "blob":
            continue
        size, name = parts[3], parts[4]
        if name.endswith(".md") and size.isdigit():
            total += int(size)
    return total


def machinery_lines(rev: str) -> int:
    """Lines of executable machinery -- the Python that decides things for the agent."""
    total = 0
    raw = git("grep", "-c", "", rev, "--", "tools/*.py", "tools/**/*.py")
    for line in raw.splitlines():
        count = line.rsplit(":", 1)[-1]
        if count.isdigit():
            total += int(count)
    return total


def window_commits(since: str) -> list:
    raw = git("log", "--since=" + git_since(since), "--pretty=%h\x1f%s", "HEAD")
    out = []
    for line in raw.splitlines():
        if "\x1f" not in line:
            continue
        sha, subject = line.split("\x1f", 1)
        out.append((sha, subject))
    return out


def parse_log_lines(lines) -> list:
    events = []
    for raw in lines:
        match = LOG_LINE_RE.match(raw.rstrip())
        if match:
            events.append(match.groupdict())
    return events


def parse_log(path: Path) -> list:
    if not path.exists():
        return []
    return parse_log_lines(path.read_text(encoding="utf-8", errors="replace").splitlines())


def log_event_date(event: dict) -> str:
    """The journal writes DD.MM.YY; return YYYY-MM-DD, or '' when unparseable."""
    raw = event.get("date") or ""
    try:
        return datetime.strptime(raw, "%d.%m.%y").strftime("%Y-%m-%d")
    except ValueError:
        return ""


def log_signals(events: list) -> dict:
    """Rework, human blocking and agent handoffs, straight off the journal."""
    reached = defaultdict(lambda: -1)
    backward = []
    same_phase = []
    handoffs = 0
    wait_user = 0
    refused = 0
    seen_agent = {}

    for ev in events:
        ticket = ev.get("ticket") or ""
        body = ev.get("body") or ""
        agent = ev.get("agent") or ""

        m = TRANSITION_RE.search(body)
        if m and ticket:
            rank = PHASE_ORDER.get(m.group(1))
            if rank is not None:
                if rank < reached[ticket]:
                    backward.append(ticket + " -> " + m.group(1))
                elif rank == reached[ticket]:
                    same_phase.append(ticket + " -> " + m.group(1))
                reached[ticket] = max(reached[ticket], rank)

        if "WAIT_USER" in body:
            wait_user += 1
        if "push not attempted" in body or "refused" in body.lower():
            refused += 1
        if ticket and agent:
            prev = seen_agent.get(ticket)
            if prev and prev != agent:
                handoffs += 1
            seen_agent[ticket] = agent

    return {
        "backward_transitions": len(backward),
        "backward_detail": backward,
        "same_phase_reentries": len(same_phase),
        "wait_user_events": wait_user,
        "agent_handoffs_mid_ticket": handoffs,
        "refused_ship_attempts": refused,
        "events_parsed": len(events),
    }


# Cache reads are billed at a fraction of a fresh input token and cache writes
# at a premium. Reporting raw sums would make a heavily cached protocol look
# ruinous and a cold one look cheap, so the report carries both the raw counts
# and one cost-unit figure, with the ratios stated in the output rather than
# hidden here. They are the published Anthropic ratios; a different vendor's
# ratios change the number, which is why the raw counts stay printed beside it.
# A cost unit is one fresh input token's price, NOT a token: weighting says what
# the work cost, never how many tokens the model actually processed.
USAGE_WEIGHTS = {
    "input_tokens": 1.0,
    "output_tokens": 1.0,
    "cache_creation_input_tokens": 1.25,
    "cache_read_input_tokens": 0.1,
}

# What that total is, stated at its weakest truthful strength. Only the cache
# ratios are real published multipliers against a fresh input token: a cache
# write costs 1.25x and a cache read 0.1x. Output is counted at face value,
# and real output pricing is several times input, so this total is NOT money
# and no arithmetic on it produces money. It is a normalized usage proxy: one
# unit is one fresh input token's worth of traffic, cache traffic converted at
# its published ratio, output counted as usage rather than as price. That is
# enough to compare one SAIPEN period against another, which is the only
# question this report asks. Making it monetary would need a per-model pricing
# basis and model attribution per record -- a subsystem, for an answer nobody
# here needs.
UNIT_BASIS = (
    "normalized proxy: 1 unit = 1 fresh input token of traffic; cache write x1.25 "
    "and cache read x0.1 are published ratios, output is counted at face value and "
    "NOT at its price, so this is not money"
)


def record_date(record: dict) -> str:
    """YYYY-MM-DD from a transcript record's own ISO timestamp, or '' if absent."""
    stamp = record.get("timestamp")
    if isinstance(stamp, str) and len(stamp) >= 10:
        head = stamp[:10]
        try:
            datetime.strptime(head, "%Y-%m-%d")
        except ValueError:
            return ""
        return head
    return ""


def scan_transcripts(directory: Path, since: str | None = None) -> dict:
    """Sum per-message token usage out of JSONL session files, inside the window.

    Returns files=0 when the directory holds nothing readable, which the report
    prints as "not scanned" -- an unreadable transcript store must never be
    indistinguishable from a free one.

    `undated` counts usage records carrying no readable timestamp. It is not a
    curiosity: while it is above zero the sample cannot be proven to describe
    the report window, and the caller must withhold any per-ticket figure.
    """
    totals = Counter()
    files = 0
    messages = 0
    undated = 0
    outside = 0
    stamps = []
    if not directory.is_dir():
        return {
            "files": 0,
            "messages": 0,
            "undated": 0,
            "outside_window": 0,
            "raw_tokens": {},
            "cost_units": None,
            "first": None,
            "last": None,
        }

    for path in sorted(directory.glob("*.jsonl")):
        files += 1
        with path.open(encoding="utf-8", errors="replace") as handle:
            for raw in handle:
                line = raw.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(record, dict):
                    continue
                message = record.get("message")
                usage = message.get("usage") if isinstance(message, dict) else None
                if not isinstance(usage, dict):
                    usage = record.get("usage")
                if not isinstance(usage, dict):
                    continue
                if not any(isinstance(usage.get(k), int) for k in USAGE_WEIGHTS):
                    continue

                stamp = record_date(record)
                if not stamp:
                    undated += 1
                    continue
                if since and stamp < since:
                    outside += 1
                    continue

                stamps.append(stamp)
                for key in USAGE_WEIGHTS:
                    value = usage.get(key)
                    if isinstance(value, int):
                        totals[key] += value
                messages += 1

    cost = sum(totals[k] * w for k, w in USAGE_WEIGHTS.items()) if messages else None
    return {
        "files": files,
        "messages": messages,
        "undated": undated,
        "outside_window": outside,
        "raw_tokens": dict(totals),
        "cost_units": int(cost) if cost is not None else None,
        "first": min(stamps) if stamps else None,
        "last": max(stamps) if stamps else None,
    }


# ESCAPED DEFECT: a defect found AFTER a criterion was recorded PASS. The
# class names the reason the PASS was empty, never the defect's subject matter
# -- "auth bug" tells you nothing reusable, "the proof restated the claim" tells
# you what to change about how proofs are written. The set is CLOSED: an
# unrecognized class is reported as unknown rather than counted, because a
# vocabulary that silently accepts new members measures nothing over time.
#
# Every class below is grounded in this repository's own history rather than
# invented, which is the only reason a closed set is defensible here.
# Carried on the FOLLOW-UP ticket's own text. No new file, no new state, no new
# subsystem: the ticket that fixes the escape is the record that it escaped.
ESCAPED_RE = re.compile(r"\bescaped:\s*([A-Za-z_][A-Za-z0-9_]*)")

# Evidence kinds a machine re-runs, as opposed to kinds a human asserted once.
# The split is the whole point of the section: "6 of 9 criteria satisfied" reads
# identically whether a test proves them or a sentence does.
DETERMINISTIC_KINDS = ("static", "behavioral")


def escaped_defect_signals(tickets: dict) -> dict:
    """Escaped-defect classes declared across the board, by class.

    Unknown classes are NAMED, not counted and not dropped. A typo that silently
    vanishes from a report is worse than one that shows up as unknown.
    """
    counted = {name: 0 for name in ESCAPED_CLASSES}
    unknown: list[str] = []
    for ticket_id in sorted(tickets):
        for raw_class in ESCAPED_RE.findall(tickets[ticket_id].get("raw", "") or ""):
            name = raw_class.upper()
            if name in counted:
                counted[name] += 1
            else:
                unknown.append(f"{ticket_id}:{raw_class}")
    return {
        "vocabulary": list(ESCAPED_CLASSES),
        "by_class": {name: n for name, n in counted.items() if n},
        "declared_total": sum(counted.values()),
        "unknown_class": unknown,
    }


def acceptance_signals(saipen_dir: Path) -> dict:
    """Criterion counts over the whole board, from the ONE criterion parser.

    Reports how many promises exist, how many have any evidence at all, and --
    the number this section exists for -- how many are held up by something a
    machine re-runs rather than by a sentence somebody wrote. Observational: it
    opens BOARD and LOG, and there is no write path here or in what it calls.
    """
    try:
        from saipen_engine.acceptance import (
            CONTESTED,
            FAILED,
            SATISFIED,
            UNVERIFIED,
            reconcile,
        )
        from saipen_engine.board import parse_board
        from saipen_engine.log import parse_log_line
    except Exception as exc:
        # A reporter degrades into a stated condition; it never raises.
        return {"unavailable": f"{type(exc).__name__}: {exc}"}

    board_path = saipen_dir / "BOARD.md"
    if not board_path.is_file():
        return {"unavailable": "BOARD.md missing"}
    tickets = parse_board(board_path.read_text(encoding="utf-8-sig", errors="replace")).get(
        "tickets", {}
    )

    # Sealed segments AND the live log: a criterion proven months ago is still
    # proven, and reading only the live segment would report it unverified.
    events = []
    segments = sorted((saipen_dir / "logs").glob("LOG-*.md"))
    for path in [*segments, saipen_dir / "LOG.md"]:
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            parsed = parse_log_line(line)
            if parsed is not None:
                events.append(parsed)

    states = Counter()
    criteria_total = 0
    tickets_with_criteria = 0
    with_evidence = 0
    deterministic = 0
    manual_or_inspection_only = 0
    undeclared = 0
    for ticket_id in sorted(tickets):
        verify = tickets[ticket_id].get("fields", {}).get("verify", "")
        projection = reconcile(ticket_id, verify, events)
        rows = projection["criteria"]
        if not rows:
            continue
        tickets_with_criteria += 1
        criteria_total += len(rows)
        undeclared += len(projection["undeclared_evidence"])
        for row in rows:
            states[row["state"]] += 1
            current = [r for r in row["evidence"] if not r["stale"]]
            if not current:
                continue
            with_evidence += 1
            if row["state"] != SATISFIED:
                continue
            kinds = {r["kind"] for r in current if r["result"] == "PASS"}
            if kinds & set(DETERMINISTIC_KINDS):
                deterministic += 1
            else:
                manual_or_inspection_only += 1

    return {
        "unavailable": None,
        "tickets_with_criteria": tickets_with_criteria,
        "criteria_total": criteria_total,
        "criteria_with_current_evidence": with_evidence,
        "satisfied": states[SATISFIED],
        "deterministically_verified": deterministic,
        "manual_or_inspection_only": manual_or_inspection_only,
        "failed": states[FAILED],
        "unverified": states[UNVERIFIED],
        "contested": states[CONTESTED],
        "undeclared_evidence_records": undeclared,
        "escaped_defects": escaped_defect_signals(tickets),
        "meaning": (
            "counts of promises and what holds them up; observational, gates nothing"
        ),
    }


def board_human_blocks(path: Path) -> int:
    if not path.exists():
        return 0
    return path.read_text(encoding="utf-8", errors="replace").count("WAIT_USER")


def collect(since: str, transcripts: Path | None = None) -> dict:
    start_rev = rev_at(since)
    head = git("rev-parse", "--short", "HEAD").strip()

    commits = window_commits(since)
    releases = [c for c in commits if c[1].startswith(("ship v", "release:"))]
    closures = [c for c in commits if c[1].startswith("closure ")]

    ticket_hits = Counter()
    for _sha, subject in releases + closures:
        for tid in set(TICKET_RE.findall(subject)):
            ticket_hits[tid] += 1

    # One `git log --numstat` rather than 439 `git show` calls: it is both
    # cheaper and carries the changed-line counts for free, so the same pass
    # yields the path signal and the line signal.
    external_paths = set()
    total_paths = set()
    lines_total = 0
    lines_external = 0
    numstat = git("log", "--since=" + git_since(since), "--numstat", "--pretty=", "HEAD")
    for raw in numstat.splitlines():
        parts = raw.rstrip("\n").split("\t")
        if len(parts) != 3:
            continue
        added, removed, path = parts
        path = path.strip()
        if not path:
            continue
        # A binary file reports "-" for both counts; count the path, not lines.
        churn = sum(int(n) for n in (added, removed) if n.isdigit())
        total_paths.add(path)
        lines_total += churn
        if not is_self_surface(path):
            external_paths.add(path)
            lines_external += churn

    start_dt = datetime.strptime(since, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    days = max((datetime.now(timezone.utc) - start_dt).total_seconds() / 86400.0, 1.0)

    law_start, law_now = law_bytes(start_rev), law_bytes("HEAD")
    mach_start, mach_now = machinery_lines(start_rev), machinery_lines("HEAD")

    # `.saipen/LOG.md` is the LIVE segment; sealed segments are archived out of
    # it. Its events are filtered to the same window as the git history so one
    # report never mixes windowed and lifetime numbers -- and the coverage line
    # says how much of the live segment the window actually saw, because a LOG
    # that starts inside the window is not the same claim as one that spans it.
    all_events = parse_log(REPO / ".saipen" / "LOG.md")
    dated = [(log_event_date(e), e) for e in all_events]
    windowed = [e for stamp, e in dated if stamp and stamp >= since]
    stamps = sorted(stamp for stamp, _ in dated if stamp)

    signals = log_signals(windowed)
    signals["tickets_human_blocked_now"] = board_human_blocks(REPO / ".saipen" / "BOARD.md")
    signals["live_segment_events"] = len(all_events)
    signals["live_segment_first"] = stamps[0] if stamps else None
    signals["live_segment_last"] = stamps[-1] if stamps else None
    signals["undated_events"] = sum(1 for stamp, _ in dated if not stamp)

    usage = scan_transcripts(transcripts, since) if transcripts else {"files": 0}
    # WINDOW economics, not per-ticket attribution: the numerator is everything
    # the window cost -- open tickets, abandoned attempts, audits, research --
    # divided by what the window closed. It compares periods against each other
    # and says nothing about what any single ticket consumed. Attributing cost
    # to a ticket would need machinery this tool refuses to grow.
    #
    # The ratio exists only when the sample provably describes the window. One
    # undated usage record is enough to withhold it, and so is a window that
    # closed nothing: both make the division a number that claims more than the
    # evidence supports.
    per_ticket, per_ticket_withheld = None, None
    if usage.get("cost_units"):
        if usage.get("undated"):
            per_ticket_withheld = (
                "%d usage record(s) carry no timestamp, so the sample cannot be "
                "aligned to the window" % usage["undated"]
            )
        elif not ticket_hits:
            per_ticket_withheld = "no tickets closed in the report window"
        else:
            per_ticket = int(usage["cost_units"] / len(ticket_hits))

    return {
        "window": {"since": since, "days": round(days, 2), "start_rev": start_rev, "head": head},
        "surface": {
            "law_bytes_start": law_start,
            "law_bytes_now": law_now,
            "machinery_lines_start": mach_start,
            "machinery_lines_now": mach_now,
            "law_per_machinery_start": round(law_start / mach_start, 3) if mach_start else None,
            "law_per_machinery_now": round(law_now / mach_now, 3) if mach_now else None,
        },
        "throughput": {
            "commits": len(commits),
            "releases": len(releases),
            "tickets_closed": len(ticket_hits),
            "releases_per_day": round(len(releases) / days, 2),
            "tickets_per_day": round(len(ticket_hits) / days, 2),
        },
        # `tickets_reopened_across_releases` counts a ticket named in more than
        # one release-bearing subject. Checked against this repository rather
        # than assumed, over 2026-08-01..248697fa: tickets named in BOTH a
        # ship/release subject and a closure subject number 0, so the two
        # conventions never double-count the same ticket -- the old `release:`
        # subjects carried the id (17 of 113 releases), the current `ship v*`
        # subjects do not and the id lives in the paired closure commit. Of 82
        # tickets exactly 2 carry more than one hit, T-528 and T-534, and every
        # one of their subjects says "second pass", "third pass" or "hotfix".
        # Re-run that split before trusting this number on another repository:
        # a convention that names the ticket in both halves would inflate it.
        "rework": {
            "tickets_reopened_across_releases": sum(1 for n in ticket_hits.values() if n > 1),
            "backward_transitions": signals["backward_transitions"],
            "same_phase_reentries": signals["same_phase_reentries"],
            "refused_ship_attempts": signals["refused_ship_attempts"],
        },
        "human": {
            "wait_user_events": signals["wait_user_events"],
            "tickets_human_blocked_now": signals["tickets_human_blocked_now"],
        },
        "continuity": {
            "agent_handoffs_mid_ticket": signals["agent_handoffs_mid_ticket"],
            "log_events_in_window": signals["events_parsed"],
            "live_segment_events": signals["live_segment_events"],
            "live_segment_first": signals["live_segment_first"],
            "live_segment_last": signals["live_segment_last"],
            "undated_events": signals["undated_events"],
        },
        "self_directed": {
            "paths_touched": len(total_paths),
            "paths_outside_self_surface": len(external_paths),
            "external_share": round(len(external_paths) / len(total_paths), 3)
            if total_paths
            else None,
            "lines_changed": lines_total,
            "lines_outside_self_surface": lines_external,
            "external_line_share": round(lines_external / lines_total, 3) if lines_total else None,
        },
        "token_cost": {
            "transcript_files": usage.get("files", 0),
            "usage_records_in_window": usage.get("messages", 0),
            "usage_records_undated": usage.get("undated", 0),
            "usage_records_before_window": usage.get("outside_window", 0),
            "sample_first": usage.get("first"),
            "sample_last": usage.get("last"),
            "raw_tokens": usage.get("raw_tokens", {}),
            "normalized_units": usage.get("cost_units"),
            "unit_basis": UNIT_BASIS,
            "unit_ratios": USAGE_WEIGHTS,
            "window_units_per_ticket_closed": per_ticket,
            "window_ratio_withheld": per_ticket_withheld,
            "window_ratio_meaning": (
                "normalized units consumed in window / tickets closed in window -- period "
                "economics, not the cost of any one ticket"
            ),
            "sample_scope": "one harness's session store; a lower bound on total traffic",
        },
        "acceptance": acceptance_signals(REPO / ".saipen"),
        "not_measured": [
            "outcome quality vs a plain agent",
            "human wall-clock saved",
        ],
    }


def render(data: dict) -> str:
    w, s, t = data["window"], data["surface"], data["throughput"]
    r, h = data["rework"], data["human"]
    c, d = data["continuity"], data["self_directed"]
    law_delta = s["law_bytes_now"] - s["law_bytes_start"]
    mach_delta = s["machinery_lines_now"] - s["machinery_lines_start"]

    return "\n".join(
        [
            "SAIPEN production metrics  %s .. HEAD %s  (%s days)"
            % (w["since"], w["head"], w["days"]),
            "",
            "surface -- law should shrink, machinery may grow",
            "  protocol law (saipen/*.md bytes)   %8d -> %8d  (%+d)"
            % (s["law_bytes_start"], s["law_bytes_now"], law_delta),
            "  machinery (tools/*.py lines)       %8d -> %8d  (%+d)"
            % (s["machinery_lines_start"], s["machinery_lines_now"], mach_delta),
            "  law bytes per machinery line       %8s -> %8s"
            % (s["law_per_machinery_start"], s["law_per_machinery_now"]),
            "",
            "throughput",
            "  commits                            %8d" % t["commits"],
            "  releases                           %8d   (%.2f/day)"
            % (t["releases"], t["releases_per_day"]),
            "  tickets closed                     %8d   (%.2f/day)"
            % (t["tickets_closed"], t["tickets_per_day"]),
            "",
            "rework -- LOG signals cover the window only, not the sealed history",
            "  tickets reopened across releases   %8d" % r["tickets_reopened_across_releases"],
            "  backward phase transitions         %8d" % r["backward_transitions"],
            "  same-phase re-entries, not rework  %8d" % r["same_phase_reentries"],
            "  refused ship attempts              %8d" % r["refused_ship_attempts"],
            "",
            "human cost",
            "  WAIT_USER events (LOG window)      %8d" % h["wait_user_events"],
            "  tickets blocked on a human now     %8d" % h["tickets_human_blocked_now"],
            "",
            "continuity",
            "  agent handoffs mid-ticket          %8d" % c["agent_handoffs_mid_ticket"],
            "  LOG events in window               %8d   (live segment holds %d, %s..%s)"
            % (
                c["log_events_in_window"],
                c["live_segment_events"],
                c["live_segment_first"],
                c["live_segment_last"],
            ),
            "",
            "self-directedness -- share OUTSIDE the SAIPEN surface",
            "  paths touched                      %8d" % d["paths_touched"],
            "  paths outside the self-surface     %8d   (%s)"
            % (d["paths_outside_self_surface"], d["external_share"]),
            "  lines changed                      %8d" % d["lines_changed"],
            "  lines outside the self-surface     %8d   (%s)"
            % (d["lines_outside_self_surface"], d["external_line_share"]),
            "",
            render_token_cost(data["token_cost"]),
            "",
            render_acceptance(data["acceptance"]),
            "",
            "not measured here: " + "; ".join(data["not_measured"]),
        ]
    )


def render_acceptance(a: dict) -> str:
    """Promises and what holds them up. Absence and proof must not look alike."""
    if a.get("unavailable"):
        return "acceptance -- unavailable: " + a["unavailable"]
    lines = [
        "acceptance -- what was promised, and what actually holds it up",
        "  tickets declaring criteria           %8d" % a["tickets_with_criteria"],
        "  criteria declared                    %8d" % a["criteria_total"],
        "  criteria with current evidence       %8d" % a["criteria_with_current_evidence"],
        "  satisfied                            %8d" % a["satisfied"],
        "    of those, machine re-runnable      %8d" % a["deterministically_verified"],
        "    of those, a human assertion only   %8d" % a["manual_or_inspection_only"],
        "  failed                               %8d" % a["failed"],
        "  unverified                           %8d" % a["unverified"],
        "  contested                            %8d" % a["contested"],
    ]
    if a["undeclared_evidence_records"]:
        lines.append(
            "  evidence naming an undeclared AC     %8d" % a["undeclared_evidence_records"]
        )
    esc = a["escaped_defects"]
    lines.append("  escaped defects declared             %8d" % esc["declared_total"])
    for name, count in sorted(esc["by_class"].items(), key=lambda kv: (-kv[1], kv[0])):
        lines.append("    %-34s %8d" % (name.lower().replace("_", " "), count))
    if esc["unknown_class"]:
        lines.append(
            "    unknown class (not counted)        " + ", ".join(esc["unknown_class"])
        )
    return "\n".join(lines)


def render_token_cost(tc: dict) -> str:
    # Three distinct outcomes, and collapsing any two of them throws away work
    # that was actually done. No directory was given; a directory was read and
    # held nothing datable inside the window; records were found. The middle
    # case used to print "not scanned", which told a reader the opposite of
    # what happened -- the files were inspected, and that is evidence.
    if not tc.get("transcript_files"):
        return "token traffic\n  not scanned -- pass --transcripts DIR of JSONL sessions"
    if not tc.get("usage_records_in_window"):
        return (
            "token traffic\n  scanned %d transcript file(s); no dated usage record "
            "falls inside the report window (%d before it, %d undated)"
            % (
                tc["transcript_files"],
                tc.get("usage_records_before_window", 0),
                tc.get("usage_records_undated", 0),
            )
        )
    raw = tc["raw_tokens"]
    lines = [
        "token traffic -- %d session file(s), %d usage records in window (%s..%s)"
        % (
            tc["transcript_files"],
            tc["usage_records_in_window"],
            tc["sample_first"],
            tc["sample_last"],
        ),
        "  %s; %d record(s) before the window, %d undated"
        % (tc["sample_scope"], tc["usage_records_before_window"], tc["usage_records_undated"]),
    ]
    for key in USAGE_WEIGHTS:
        lines.append("  %-32s %14d" % (key, raw.get(key, 0)))
    lines.append(
        "  normalized at %s"
        % ", ".join("%s x%s" % (k.replace("_tokens", ""), v) for k, v in USAGE_WEIGHTS.items())
    )
    lines.append("  %-32s %14d" % ("normalized units in window", tc["normalized_units"]))
    lines.append("  " + tc["unit_basis"])
    ratio = tc["window_units_per_ticket_closed"]
    if ratio is None:
        lines.append(
            "  window units per ticket: withheld -- "
            + (tc["window_ratio_withheld"] or "reason not recorded")
        )
    else:
        lines.append("  %-32s %14d" % ("window units per ticket", ratio))
        lines.append("  " + tc["window_ratio_meaning"])
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--since", default="2026-08-01", help="window start, YYYY-MM-DD")
    ap.add_argument("--json", action="store_true", help="emit the raw record")
    ap.add_argument(
        "--transcripts",
        default=None,
        help="directory of JSONL agent sessions carrying per-message token usage",
    )
    args = ap.parse_args(argv)

    data = collect(args.since, Path(args.transcripts) if args.transcripts else None)
    print(json.dumps(data, indent=2, sort_keys=True) if args.json else render(data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
