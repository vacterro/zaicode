#!/usr/bin/env python3
"""Every release tag points at a commit whose VERSION file agrees with it.

`release.yml` refuses to publish a tag whose `VERSION` disagrees. That guard
is FORWARD-ONLY: it was added in v7.99.0 *because* a tag had already reached
origin pointing two releases behind, and it can say nothing about the tags
that were already there. Nothing ever swept them, so the wrong one stayed
wrong -- and a published release built from it stayed downloadable.

This is the sweep, run in CI so it keeps happening. A one-off sweep is not a
guard; that lesson has cost this repository four releases.

Not in `tools/validate.py` on purpose. It needs the full tag list, which a
consuming project does not have and a shallow checkout does not fetch, and it
would put a git round-trip into a pre-commit hook that runs on every commit.

Exit 0 when every tag agrees, 1 otherwise. The initial tag discovery skips
(exit 0, loudly) only when the Git executable or tag list is absent. An
observed Git process failure and every later batch-process or protocol failure
fail closed: the audit must not turn losing its evidence into a green result.
"""

from __future__ import annotations

import io
import os
import subprocess
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


# Mismatches that already existed when this audit was written. Recorded, not
# rewritten: moving a published tag re-runs `release.yml` from the TAG's
# commit, so each fix would run whatever workflow existed back then -- for
# these, a version with no tag/VERSION guard at all -- and could republish or
# reorder releases years old. The repo decided the same way about CHANGELOG:
# history records what happened, including the mistakes.
#
# Each entry states what is actually wrong. A NEW mismatch is a FAIL; these
# are printed every run so they never go quiet, which is the whole difference
# between a documented limit and a swept one.
KNOWN_MISMATCHES = {
    "v3.1.1a": "commit is the 3.1.1a work but its VERSION was never bumped past 3.1.1",
    "v7.61.0": "tag landed one release behind -- the commit is v7.60.0",
    "v7.74.0": "tag landed one release ahead -- the commit is v7.75.0",
    "v7.81.0": "commit is the v7.81.0 work but its VERSION still says 7.80.0",
    "v7.99.0": "the incident that produced the guard: `git tag` ran after a "
    "failed commit and labelled the previous one. Its published "
    "release carries v7.98.0's notes",
    "v7.199.0": "its true release commit eae5b72 (VERSION 7.199.0) is not on "
    "origin/main -- orphaned by a later history rewrite -- so a "
    "tag pointing there would dangle on every fresh clone; the "
    "tag currently names 594a1da, which carries VERSION 7.201.0. "
    "Re-pointing would push the orphaned commit and re-run the "
    "v7.199.0 release",
    "v7.200.0": "same shape as v7.199.0: its true release commit ea8eef3 "
    "(VERSION 7.200.0) is not on origin/main; the tag names "
    "594a1da (VERSION 7.201.0). Re-pointing would push the "
    "orphaned commit and re-run the v7.200.0 release",
    "v7.223.15": "the release executor's untracked-only scope bug created "
    "closure commit 88ddbbaa without a v7.223.15 metadata/content commit, "
    "so it retained VERSION 7.223.14. v7.223.16 explicitly shipped the "
    "omitted T-996 content and the executor fix; no truthful v7.223.15 "
    "commit exists to re-point to, and moving the published tag would "
    "re-run the defective historical release workflow",
}

GIT_SHIM_ENV = "SAIPEN_AUDIT_TAGS_GIT_SHIM"


def _decode_version(raw: bytes) -> str:
    """Decode a historical VERSION blob.

    A dozen of this repository's own VERSION files were written by PowerShell
    and are UTF-16, some with a BOM and some without. Read as UTF-8 they come
    back as spaced-out digits, and the first run of this audit reported every
    one of them as a tag/VERSION mismatch -- the second instrument bug in this
    tool inside ten minutes, both of them producing findings that were not
    there. Decode by what the bytes are, not by what they ought to be.
    """
    if raw.startswith(b"\xff\xfe"):
        text = raw[2:].decode("utf-16-le", "replace")
    elif raw.startswith(b"\xfe\xff"):
        text = raw[2:].decode("utf-16-be", "replace")
    elif b"\x00" in raw[:8]:
        # BOM-less UTF-16: NUL is valid UTF-8, so decoding never complains
        # and the result quietly matches nothing.
        order = "utf-16-le" if raw[1:2] == b"\x00" else "utf-16-be"
        text = raw.decode(order, "replace")
    else:
        text = raw.decode("utf-8-sig", "replace")
    return text.strip()


def git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([*_git_command(), *args], capture_output=True, text=True, check=False)


def _git_command() -> list[str]:
    """Return Git, or the Python shim used by executable failure controls."""
    shim = os.environ.get(GIT_SHIM_ENV)
    return [sys.executable, shim] if shim else ["git"]


def _parse_batch_versions(tags: list[str], buf: bytes) -> tuple[dict[str, str | None], str | None]:
    """Parse one exact `cat-file --batch` record per requested VERSION."""
    versions: dict[str, str | None] = {}
    pos = 0
    for tag in tags:
        nl = buf.find(b"\n", pos)
        if nl < 0:
            return versions, f"response for {tag} has no complete header"
        header = buf[pos:nl].decode("utf-8", "replace")
        pos = nl + 1
        missing_header = f"{tag}^{{commit}}:VERSION missing"
        if header == missing_header:
            versions[tag] = None
            continue

        parts = header.rsplit(" ", 2)
        if (
            len(parts) != 3
            or parts[1] != "blob"
            or len(parts[0]) not in {40, 64}
            or not all(c in "0123456789abcdef" for c in parts[0].lower())
        ):
            return versions, f"response for {tag} has malformed header {header!r}"
        try:
            size = int(parts[2])
        except ValueError:
            return versions, f"response for {tag} has invalid size {parts[2]!r}"
        end = pos + size
        if end >= len(buf) or buf[end : end + 1] != b"\n":
            return versions, f"response for {tag} is truncated"
        versions[tag] = _decode_version(buf[pos:end])
        pos = end + 1

    if pos != len(buf):
        return versions, f"batch response has {len(buf) - pos} unexpected trailing byte(s)"
    return versions, None


def main() -> int:
    try:
        tag_result = git("tag", "-l", "v*")
    except FileNotFoundError:
        print("SKIP: git unavailable -- cannot audit tags")
        return 0
    except (OSError, subprocess.SubprocessError) as e:
        print(f"FAIL: git tag enumeration failed to start ({e})")
        return 1
    if tag_result.returncode:
        detail = tag_result.stderr.strip() or tag_result.stdout.strip()
        suffix = f": {detail}" if detail else ""
        print(f"FAIL: git tag enumeration exited {tag_result.returncode}{suffix}")
        return 1
    out = tag_result.stdout
    tags = [t.strip() for t in out.splitlines() if t.strip()]
    if not tags:
        print(
            "SKIP: no tags in this checkout -- nothing to audit. "
            "A shallow clone fetches none; use fetch-depth: 0 if this was "
            "meant to run for real"
        )
        return 0

    # One batch call rather than one `git show` per tag: fifty subprocesses is
    # the difference between a check that runs in CI and one that gets skipped
    # for being slow.
    spec = "".join(f"{t}^{{commit}}:VERSION\n" for t in tags)
    try:
        proc = subprocess.run(
            [*_git_command(), "cat-file", "--batch"],
            input=spec.encode("utf-8"),
            capture_output=True,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as e:
        print(f"FAIL: git cat-file failed to start ({e})")
        return 1
    if proc.returncode:
        detail = proc.stderr.decode("utf-8", "replace").strip()
        suffix = f": {detail}" if detail else ""
        print(f"FAIL: git cat-file exited {proc.returncode}{suffix}")
        return 1

    # Parse by SIZE, on bytes. The first version of this walked the output as
    # text lines and advanced two per record; a `--batch` record is
    # `<oid> <type> <size>\n<contents>\n`, so the trailing newline made it
    # three and every record after the first was read against the wrong tag.
    # It reported 82 of 174 tags broken, including ones tagged minutes
    # earlier -- the total-failure signature this repo has already been
    # burned by three times. A misconfigured harness is almost always total;
    # a real defect almost never is.
    versions, parse_error = _parse_batch_versions(tags, proc.stdout)
    if parse_error:
        print(f"FAIL: git cat-file {parse_error}")
        return 1

    bad, missing = [], []
    for tag, ver in versions.items():
        if ver is None:
            missing.append(tag)
        elif tag != "v" + ver:
            bad.append((tag, ver))

    for tag in missing:
        print(
            f"WARN: {tag} has no VERSION file at its commit -- predates the "
            f"file, nothing to compare"
        )
    known = [(t, v) for t, v in bad if t in KNOWN_MISMATCHES]
    fresh = [(t, v) for t, v in bad if t not in KNOWN_MISMATCHES]

    for tag, ver in sorted(known):
        print(f"WARN: {tag} -> VERSION {ver} -- known: {KNOWN_MISMATCHES[tag]}")

    # An entry that no longer describes a real mismatch is stale, and a stale
    # exemption is how a check quietly stops covering what it claims to.
    stale = sorted(set(KNOWN_MISMATCHES) - {t for t, _ in bad} & set(tags))
    for tag in stale:
        print(
            f"FAIL: {tag} is listed as a known mismatch but now agrees with "
            f"its VERSION -- drop it from KNOWN_MISMATCHES, an exemption "
            f"nobody rechecks is how coverage rots"
        )

    if fresh:
        for tag, ver in sorted(fresh):
            print(
                f"FAIL: {tag} points at a commit whose VERSION says {ver}. "
                f"The release published from it carries the wrong notes and "
                f"a VERSION asset that disagrees with its own tag name"
            )
        print(f"\n{len(fresh)} NEW mismatch(es) out of {len(tags)} tag(s).")
        print(
            "Fix forward: a corrected tag re-runs release.yml from the "
            "TAG's commit, so the workflow file there is whatever it was "
            "then -- re-check what that publishes before pushing."
        )

    if fresh or stale:
        return 1

    print(
        f"PASS: {len(tags) - len(missing)} comparable tag(s) checked, "
        f"{len(known)} known historical mismatch(es), no new ones"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
