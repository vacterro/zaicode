#!/usr/bin/env python3
"""Publish the ZAICODE workspace WITHOUT the internal SAIPEN memory tree.

The workspace repository tracks `.saipen/` (the protocol's own memory: STATE,
BOARD, LOG, evidence). That memory is internal by design -- it carries the
operator's host paths, the protocol's ticket history and machine-local
handles. It must never reach a public branch tip.

The workspace layer and the product layer are different branches of different
repositories, so the public workspace branch (`master` on the GitLab mirror)
is published from here, not with a plain `git push`:

    python tools/publish-workspace-mirror.py --remote gitlab --branch master

What it does, in order:

1. Reads the published branch tip.
2. If that tip still carries `.saipen/`, it writes one forward boundary
   commit: same parent, tree minus `.saipen/`. History is never rewritten.
3. Mirrors every local commit that is newer than the last mirrored one,
   one to one (same message, author, committer, date), each with the same
   tree minus `.saipen/`.
4. Fast-forwards the published branch to the mirrored tip.

Nothing is deleted locally: the memory stays on disk and stays tracked in
the local repository, so the protocol keeps committing it. Only the PUBLISHED
tree is stripped. `tools/hooks/pre-push` refuses any other push that would
carry `.saipen/`.

The old blobs stay reachable in the published branch's history. Purging them
is a history rewrite and needs the operator's explicit approval.

ponytail: a merge commit is published with one parent, so the published
history is linear even when the local history is not. The content is the
same; add a real parent mapping when a merge must keep its shape.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile

MEMORY_DIR = ".saipen"
IGNORE_LINE = "/.saipen/"


def git(*args: str, env: dict | None = None) -> str:
    merged = dict(os.environ)
    if env:
        merged.update(env)
    proc = subprocess.run(
        ["git", *args], capture_output=True, text=True, env=merged, errors="replace"
    )
    if proc.returncode != 0:
        raise SystemExit(
            f"git {' '.join(args)} failed ({proc.returncode}): "
            f"{(proc.stderr or proc.stdout).strip()}"
        )
    return proc.stdout.strip()


def rev_parse(ref: str) -> str:
    return git("rev-parse", "--verify", f"{ref}^{{commit}}")


def remote_tip(remote: str, branch: str) -> str:
    out = git("ls-remote", remote, f"refs/heads/{branch}")
    if not out:
        raise SystemExit(f"remote {remote} has no branch {branch}")
    return out.split()[0]


def tree_has_memory(treeish: str) -> list[str]:
    listing = git("ls-tree", "-r", "--name-only", treeish, "--", MEMORY_DIR)
    return [line for line in listing.splitlines() if line.strip()]


def stripped_tree(commit: str) -> str:
    """The commit's tree without `.saipen/`, plus the ignore rule that keeps it out."""
    with tempfile.TemporaryDirectory() as tmp:
        index = os.path.join(tmp, "index")
        env = {"GIT_INDEX_FILE": index}
        git("read-tree", commit, env=env)
        git("rm", "-r", "--cached", "-f", "--ignore-unmatch", "--", MEMORY_DIR, env=env)
        _ensure_ignore_rule(env)
        return git("write-tree", env=env)


def _ensure_ignore_rule(env: dict) -> None:
    """The published `.gitignore` ignores the memory tree, so a fresh clone keeps it out."""
    try:
        blob = git("show", ":.gitignore", env=env)
    except SystemExit:
        return
    lines = [line.strip() for line in blob.splitlines()]
    if IGNORE_LINE in lines:
        return
    text = blob
    if text and not text.endswith("\n"):
        text += "\n"
    text += (
        "\n# The internal SAIPEN memory tree is never published (T-410).\n"
        f"{IGNORE_LINE}\n"
    )
    proc = subprocess.run(
        ["git", "hash-object", "-w", "--stdin"],
        input=text.encode("utf-8"),
        capture_output=True,
        env={**os.environ, **env},
    )
    if proc.returncode != 0:
        raise SystemExit(f"hash-object failed: {proc.stderr.decode('utf-8', 'replace')}")
    oid = proc.stdout.decode().strip()
    git("update-index", "--add", "--cacheinfo", f"100644,{oid},.gitignore", env=env)


def commit_fields(commit: str) -> dict:
    fmt = "%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI"
    raw = git("show", "-s", f"--format={fmt}", commit)
    name, email, adate, cname, cemail, cdate = raw.split("\x00")
    return {
        "GIT_AUTHOR_NAME": name,
        "GIT_AUTHOR_EMAIL": email,
        "GIT_AUTHOR_DATE": adate,
        "GIT_COMMITTER_NAME": cname,
        "GIT_COMMITTER_EMAIL": cemail,
        "GIT_COMMITTER_DATE": cdate,
    }


def commit_tree(tree: str, parents: list[str], commit: str) -> str:
    """A commit with the source commit's message, author, committer and date."""
    message = subprocess.run(
        ["git", "show", "-s", "--format=%B", commit],
        capture_output=True,
        env=os.environ,
    ).stdout
    return _write_commit(tree, parents, message, commit_fields(commit))


def _write_commit(tree: str, parents: list[str], message: bytes, env: dict) -> str:
    args = ["commit-tree", tree]
    for parent in parents:
        args += ["-p", parent]
    proc = subprocess.run(
        ["git", *args], input=message, capture_output=True, env={**os.environ, **env}
    )
    if proc.returncode != 0:
        raise SystemExit(f"commit-tree failed: {proc.stderr.decode('utf-8', 'replace')}")
    return proc.stdout.decode().strip()


def mirror_ref(remote: str, branch: str) -> str:
    return f"refs/zaicode/mirror/{remote}/{branch.replace('/', '-')}"


def last_mirrored(remote: str, branch: str) -> str | None:
    try:
        return git("rev-parse", "--verify", f"{mirror_ref(remote, branch)}^{{commit}}")
    except SystemExit:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--remote", required=True, help="remote name, e.g. gitlab")
    parser.add_argument("--branch", required=True, help="published branch, e.g. master")
    parser.add_argument("--source", default="master", help="local branch to mirror from")
    parser.add_argument("--dry-run", action="store_true", help="build the commits, push nothing")
    args = parser.parse_args()

    source = rev_parse(args.source)
    tip = remote_tip(args.remote, args.branch)
    parent = tip
    mirrored = last_mirrored(args.remote, args.branch)

    # 1. The boundary: a forward commit that drops the memory tree from the tip.
    if tree_has_memory(tip):
        tree = stripped_tree(tip)
        message = (
            b"chore(workspace): keep the internal SAIPEN memory tree out of the public mirror\n"
            b"\n"
            b"The workspace repository tracks .saipen/ (the protocol's own memory: STATE,\n"
            b"BOARD, LOG, evidence). That tree is internal -- it carries host paths and\n"
            b"ticket history -- and it does not belong on a public branch tip. This\n"
            b"forward commit drops it from the tree and adds the ignore rule that keeps\n"
            b"it out. History is not rewritten; the local checkout keeps its memory.\n"
            b"\n"
            b"Publish with: python tools/publish-workspace-mirror.py --remote <remote> "
            b"--branch <branch>\n"
        )
        boundary = _write_commit(tree, [tip], message, {})
        print(f"boundary commit: {boundary[:12]} (tree without {MEMORY_DIR}/)")
        parent = boundary
        if mirrored is None:
            mirrored = tip
    elif mirrored is None:
        # The published tip is already clean and was never mirrored by this tool:
        # the local counterpart is the commit with the same tree.
        mirrored = _matching_source_commit(source, tip)

    # 2. Mirror every newer local commit, one to one.
    pending = git("rev-list", "--reverse", f"{mirrored}..{source}").split()
    for commit in pending:
        tree = stripped_tree(commit)
        if tree_has_memory(tree):
            raise SystemExit(f"internal error: {commit[:12]} tree still carries the memory")
        new = commit_tree(tree, [parent], commit)
        print(f"mirrored {commit[:12]} -> {new[:12]}  {git('show', '-s', '--format=%s', commit)}")
        parent = new

    if not args.dry_run and parent != tip:
        git("push", args.remote, f"{parent}:refs/heads/{args.branch}")
        git("update-ref", mirror_ref(args.remote, args.branch), source)
        print(f"published {args.remote}/{args.branch} = {parent[:12]}")
    elif args.dry_run:
        print("dry run: nothing pushed")
    else:
        print(f"{args.remote}/{args.branch} is already current ({tip[:12]})")
    return 0


def _matching_source_commit(source: str, tip: str) -> str:
    """The local commit whose tree matches the published tip (the mirror's anchor)."""
    tip_tree = git("rev-parse", f"{tip}^{{tree}}")
    listing = git("log", "--format=%H %T", source)
    for line in listing.splitlines():
        commit, tree = line.split()
        if tree == tip_tree:
            return commit
    raise SystemExit(
        "the published branch is clean but has no local counterpart; "
        "publish it once by hand or re-anchor the mirror"
    )


if __name__ == "__main__":
    sys.exit(main())
