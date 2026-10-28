"""Append one or more LOG.md lines, preserving the file's CRLF convention.

Usage: python tools/_log_append.py "line one" "line two" ...
Read-only otherwise: never rewrites existing bytes.

This is the tool an agent uses to hand-form a LOG line, and a hand-formed
stamp is the only way a bad date has ever entered this journal. Every engine
writer formats the stamp with `strftime("%d.%m.%y %H:%M")` and cannot get the
field order wrong; a human typing the digits can, and twice did -- E-2068 as
`26.08.05` and E-5171 as `26.09.01`, both the ISO order, both parsing 21 and
25 years into the past. LOG.md is append-only, so a bad line written here is
permanent. The cheapest place to stop it is before the write.

So an event line must carry a real `DD.MM.YY HH:MM` stamp that does not move
backwards more than five minutes from the last dated line already in the file
(the same clock slack `tools/validate.py` allows between machines) and is not
more than five minutes ahead of real UTC. A refusal writes nothing at all --
not the offending line, not the ones beside it.

    --allow-inversion   append anyway, for the genuine case where a line
                        records an event that really did happen earlier.
                        Deliberate, explicit, and visible in the shell
                        history; the default is refusal.

A line that is not an event line (a heading, a blank, the file skeleton) is
passed through untouched: this guards stamps, it does not police prose.
"""
from __future__ import annotations

import datetime
import pathlib
import re
import sys

LOG_PATH = pathlib.Path(".saipen/LOG.md")
STAMP_RE = re.compile(r"^- (\d{2})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}) \[E-(\d+)\]")
# Same 300s both validate.py timestamp checks use, and for the same reason:
# clocks on two machines may disagree this much, and past it the stamp was
# invented rather than read.
CLOCK_SLACK_SECONDS = 300


def parse_stamp(line: str):
    """(datetime, event_id) for an event line, or None when the line is not one."""
    match = STAMP_RE.match(line)
    if not match:
        return None
    day, month, year, hour, minute, eid = match.groups()
    try:
        stamp = datetime.datetime(
            2000 + int(year),
            int(month),
            int(day),
            int(hour),
            int(minute),
            tzinfo=datetime.timezone.utc,
        )
    except ValueError:
        return ("INVALID", int(eid))
    return (stamp, int(eid))


def last_stamp(text: str):
    for line in reversed(text.splitlines()):
        parsed = parse_stamp(line)
        if parsed and parsed[0] != "INVALID":
            return parsed[0]
    return None


def check(lines, existing_text: str, now=None):
    """Return a list of refusal messages; empty means every line may be written."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    problems = []
    previous = last_stamp(existing_text)

    for index, line in enumerate(lines, 1):
        parsed = parse_stamp(line)
        if parsed is None:
            # Not an event line. Nothing here claims a time, so nothing to check.
            continue
        stamp, eid = parsed
        if stamp == "INVALID":
            problems.append(
                "line %d E-%d: DD.MM.YY HH:MM does not name a real date -- %r. "
                "The digits are almost certainly in ISO order (YY.MM.DD); the "
                "journal writes day first" % (index, eid, line[2:19])
            )
            continue
        ahead = (stamp - now).total_seconds()
        if ahead > CLOCK_SLACK_SECONDS:
            problems.append(
                "line %d E-%d: stamped %.0fm ahead of real UTC. Read the clock, "
                "do not estimate it" % (index, eid, ahead / 60)
            )
        if previous is not None:
            behind = (previous - stamp).total_seconds()
            if behind > CLOCK_SLACK_SECONDS:
                problems.append(
                    "line %d E-%d: stamped %.0fm BEHIND the last dated line in "
                    "the file. A day/month swap reads as a jump of years; check "
                    "the field order before forcing it with --allow-inversion"
                    % (index, eid, behind / 60)
                )
        previous = stamp
    return problems


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if a != "--allow-inversion"]
    allow_inversion = "--allow-inversion" in argv[1:]
    if not args:
        print("usage: _log_append.py [--allow-inversion] <line> [<line> ...]")
        return 2

    raw = LOG_PATH.read_bytes()
    text = raw.decode("utf-8", errors="replace")

    problems = check(args, text)
    if allow_inversion:
        problems = [p for p in problems if "BEHIND the last dated line" not in p]
    if problems:
        # Nothing is written. A partial append into an append-only file is
        # worse than a refusal: the good lines cannot be taken back either.
        print("REFUSED -- nothing appended:")
        for problem in problems:
            print("  " + problem)
        return 1

    newline = b"\r\n" if b"\r\n" in raw else b"\n"
    payload = raw
    if payload and not payload.endswith(newline):
        payload += newline
    for line in args:
        payload += line.encode("utf-8") + newline
    LOG_PATH.write_bytes(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
