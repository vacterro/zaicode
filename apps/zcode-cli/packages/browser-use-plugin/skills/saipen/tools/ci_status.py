#!/usr/bin/env python
"""Report the latest GitHub Actions run status for the current branch.

Stdlib only. The README badge is passive: it turns red and nobody is forced
to look at it. This is the active counterpart -- it queries the Actions API
and exits non-zero when the latest completed run for the branch is a failure,
so the pre-commit hook can SAY SO before another commit buries it further.
That is exactly what this repo's own CI suffered for 30+ commits: the base
was red and every local gate (which cannot see Linux-only failures) stayed
green.

**The hook is warn-only and always has been.** It invokes this tool with
`|| true`, so a red exit prints a line and the commit proceeds. That is
deliberate in both directions: a red CI must never block the very commit
that fixes it, and a network hiccup must never block any commit at all. The
non-zero exit exists for humans and scripts that call the tool directly and
want a decidable answer; it is not a gate.

    python tools/ci_status.py             # report + exit code
    python tools/ci_status.py --hook      # terse one-liner, cached, fail-open
    python tools/ci_status.py --sha HASH  # status for one commit; a short sha
                                          # is expanded via git rev-parse when
                                          # the commit is in the local repo
    python tools/ci_status.py --run-id N  # status of one run by its API id

Exit codes (the hook's contract):
    0  green -- or nothing to report (no remote, not GitHub, no runs, a run
       still in progress, or the API unreachable). Never block on uncertainty:
       a network hiccup must not stop a commit.
    1  the latest completed run for the branch is a FAILURE -- the base this
       commit would land on is red.
    2  --sha was given but could not be resolved to a full 40-char commit sha
       (GitHub's head_sha filter rejects abbreviations, and querying one
       would silently come back empty and report green -- a red-control that
       cannot see red is not a control).

--hook mode stays SILENT on green (a per-commit status line is noise the
badge already covers); it speaks only when there is something wrong.
"""

import argparse
import contextlib
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# A fresh checkout has no API history to learn from; fail open on every
# uncertain path. Only a completed, non-success conclusion is a hard 1.
GREEN = {"success", "neutral", "skipped"}
RED = {"failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"}

# Unauthenticated API is 60 req/hr; a burst of commits must not burn it, so
# the hook mode reuses one verdict per branch for a few minutes.
CACHE_TTL = 300
CACHE_NAME = "saipen-ci-status.json"


def git(*args):
    """Run git, returning stdout stripped, or \"\" on failure. Never raises:
    this file runs from a pre-commit hook and in projects without git."""
    try:
        r = subprocess.run(["git", *args], capture_output=True, text=True, check=False)
    except (OSError, subprocess.SubprocessError):
        return ""
    return r.stdout.strip()


def remote_slug():
    """owner/repo from the origin remote, or None if not a GitHub remote."""
    url = git("remote", "get-url", "origin")
    if not url:
        return None
    url = url.strip()
    if url.startswith("git@github.com:"):
        slug = url.split(":", 1)[1]
    elif "github.com/" in url:
        slug = url.split("github.com/", 1)[1]
    else:
        return None
    if slug.endswith(".git"):
        slug = slug[:-4]
    return slug.rstrip("/")


def branch_name():
    name = git("rev-parse", "--abbrev-ref", "HEAD")
    return name or None


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "saipen-ci-status"})
    with urllib.request.urlopen(req, timeout=8) as resp:
        return json.loads(resp.read().decode("utf-8"))


def cache_path():
    """The cache file, inside whatever git says this checkout's dir is.

    A literal `.git/` is wrong in a linked worktree, where `.git` is a FILE
    pointing elsewhere -- the write would fail, the hook would silently stop
    caching, and every commit in that worktree would spend one of the 60
    unauthenticated requests per hour. Resolving through git also means the
    path is right regardless of the cwd the hook runs from. No git at all
    (a consuming project without a repo) -> None, and the caller skips the
    cache rather than inventing a location.
    """
    gitdir = git("rev-parse", "--absolute-git-dir")
    return Path(gitdir) / CACHE_NAME if gitdir else None


def runs_url(slug, branch, workflow):
    """The branch query: the newest COMPLETED run of one workflow.

    `status=completed` is load-bearing. Without it the newest run wins even
    when it is still queued or in progress, classify() reports "still in
    progress" and exits 0, and the RED run underneath it is never seen --
    which is precisely the situation the tool exists for, since a red base
    is most likely to be re-run right when someone is committing on top of
    it.
    """
    return (
        "https://api.github.com/repos/{}/actions/workflows/{}/runs"
        "?branch={}&status=completed&per_page=1"
    ).format(slug, workflow, branch)


def latest_run(slug, branch, workflow):
    """The newest completed run of one workflow on a branch, or None."""
    data = fetch_json(runs_url(slug, branch, workflow))
    runs = data.get("workflow_runs") or []
    return runs[0] if runs else None


def run_by_sha(slug, sha):
    """The newest run for one commit, or None (used for red-control tests).

    GitHub's head_sha filter needs the FULL 40-char sha and silently returns
    nothing for an abbreviation -- which classify() would read as "no runs"
    and report green. A red-control test that cannot see red is not a control.
    Expand a short form against the local repo first (the commit being probed
    is normally an ancestor). Returns (run, error-or-None): an unresolvable
    sha is an error, never a silent green.
    """
    full = git("rev-parse", sha)
    if len(full) != 40:
        return (
            None,
            "cannot resolve {} to a full 40-char sha -- is the "
            "commit in this clone? (GitHub's head_sha filter rejects "
            "abbreviations)".format(sha),
        )
    url = ("https://api.github.com/repos/{}/actions/runs?head_sha={}&per_page=1").format(slug, full)
    data = fetch_json(url)
    runs = data.get("workflow_runs") or []
    return (runs[0] if runs else None), None


def run_by_id(slug, run_id):
    """One run by its API id (used for red-control tests)."""
    url = "https://api.github.com/repos/{}/actions/runs/{}".format(slug, run_id)
    return fetch_json(url)


def classify(run):
    """(exit_code, message) from a workflow run dict."""
    if run is None:
        return 0, "no runs found"
    status = run.get("status")
    conclusion = run.get("conclusion")
    number = run.get("run_number")
    sha = (run.get("head_sha") or "")[:7]
    url = run.get("html_url") or ""
    if status != "completed":
        return 0, "run #{} {} ({}..) -- still in progress".format(number, status, sha)
    if conclusion in GREEN:
        return 0, "run #{} {} ({}..) -- green".format(number, conclusion, sha)
    if conclusion in RED:
        return 1, "run #{} {} ({}..) -- RED -- {}".format(number, conclusion, sha, url)
    return 0, "run #{} conclusion {!r} -- treat as green".format(number, conclusion)


def main_argv(argv=None):
    """The whole tool, with argv injectable so probes can drive it in-process.

    `main()` used to read sys.argv directly, which meant every behavioural
    test of it had to be a subprocess -- and a subprocess cannot stub the
    network, so the fail-open path was untestable offline and therefore
    untested (T-428).
    """
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--hook", action="store_true", help="hook mode: one line, cached, fail-open")
    ap.add_argument(
        "--workflow",
        default="validate.yml",
        help="workflow file name to query (default: validate.yml)",
    )
    ap.add_argument("--branch", default=None, help="branch to query")
    ap.add_argument("--repo", default=None, help="owner/repo override")
    ap.add_argument("--sha", default=None, help="status for one commit")
    ap.add_argument("--run-id", default=None, help="status for one run id")
    args = ap.parse_args(argv)

    slug = args.repo or remote_slug()
    branch = args.branch or branch_name()
    if not slug or not branch or branch == "HEAD":
        if args.hook:
            return 0  # consuming project without GitHub CI: nothing to say
        print("no GitHub remote or branch to query")
        return 0

    # --sha / --run-id are explicit controls (red-path testing); the branch
    # query is the production path and gets the cache.
    if args.run_id:
        try:
            code, message = classify(run_by_id(slug, args.run_id))
        except (urllib.error.URLError, OSError, ValueError):
            print("cannot reach GitHub Actions API")
            return 0
        print(message)
        return code

    if args.sha:
        try:
            run, err = run_by_sha(slug, args.sha)
        except (urllib.error.URLError, OSError, ValueError):
            print("cannot reach GitHub Actions API")
            return 0
        if err is not None:
            print(err)
            return 2
        code, message = classify(run)
        print(message)
        return code

    now = time.time()
    cache = cache_path()
    if args.hook and cache is not None and cache.is_file():
        with contextlib.suppress(OSError, ValueError, KeyError):
            cached = json.loads(cache.read_text(encoding="utf-8"))
            if (
                cached.get("branch") == branch
                and cached.get("slug") == slug
                and now - cached.get("ts", 0) < CACHE_TTL
            ):
                code = cached["exit_code"]
                message = cached["message"]
                if code == 1 or not args.hook:
                    print(message)
                return code

    try:
        code, message = classify(latest_run(slug, branch, args.workflow))
    except (urllib.error.URLError, OSError, ValueError):
        if args.hook:
            return 0  # network hiccup must never block a commit
        print("cannot reach GitHub Actions API")
        return 0

    if args.hook and cache is not None:
        with contextlib.suppress(OSError):
            # Write cache to a temp location outside the repo so the
            # pre-commit gate leaves zero project-directory footprint.
            # A network hiccup is already fail-open; losing the cache
            # on the same hiccup costs one extra request next time.
            import tempfile

            _td = Path(tempfile.gettempdir()) / "saipen-ci-cache.json"
            _td.write_text(
                json.dumps(
                    {
                        "branch": branch,
                        "slug": slug,
                        "ts": now,
                        "exit_code": code,
                        "message": message,
                    }
                ),
                encoding="utf-8",
            )
    if code == 1 or not args.hook:
        print(message)
    return code


if __name__ == "__main__":
    sys.exit(main_argv())
