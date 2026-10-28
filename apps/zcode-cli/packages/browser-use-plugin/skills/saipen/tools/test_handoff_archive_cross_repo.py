"""T-1349: the canonical packager must package a project that is not itself.

`tools/build_handoff_archive.py` is described as "the ONLY canonical path for
creating a delivery artifact" and takes `--project-root`, so a cross-repository
snapshot is supposed to be one command. It was not: the builder resolved its own
verifier as `project/"tools"/"verify_handoff_archive.py"`, inside the TARGET,
and every foreign SAIPEN project exits at

    FAIL: verifier not found at <target>\\tools\\verify_handoff_archive.py

because the verifier ships with the protocol, not with an arbitrary project.
Measured on two real foreign roots before the repair. Resolving it in the
target was also the wrong place for a second reason: the delivery GATE would
then be code the packaged project supplies, so a hostile snapshot could pass
itself.

Two inventory defects travelled with it. `git ls-files` without `-z` returns
non-ASCII paths QUOTED and backslash-escaped, so four regular files (git mode
100644) whose names carry U+2014 were stat-ed under their escaped spelling,
missed, and reported as "symlinks or non-regular files" -- a containment gate
firing on its own quoting. And an embedded Git repository arrives as one
collapsed DIRECTORY entry, correctly refused but described as "not a regular
file", which names the symptom rather than the thing to act on.

Every case here builds its own disposable project. None of them reads or writes
a real foreign repository.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402
from test_hermetic_env import hermetic_env, isolate_host_session  # noqa: E402

BUILDER = TOOLS / "build_handoff_archive.py"

STATE = """---
phase: DONE
task: none
next_action: "saipen continue"
blocker: ""
saipen_version: 7
schema_version: 3
last_event: 1
---
"""

BOARD = """# Board

## DOING

## TODO

## DONE

## BLOCKED
"""

LOG = """# Log

- 01.01.26 00:00 [E-1] [agent: fixture] [op: seed] DEC: fixture seeded
"""


def _git(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=str(root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=hermetic_env(),
    )


def foreign_project(base: Path, *, extra: dict[str, str] | None = None) -> Path:
    """A disposable Git-backed SAIPEN project that is NOT this repository."""
    root = base / "foreign"
    saipen = root / ".saipen"
    saipen.mkdir(parents=True)
    (saipen / "STATE.md").write_text(STATE, encoding="utf-8")
    (saipen / "BOARD.md").write_text(BOARD, encoding="utf-8")
    (saipen / "LOG.md").write_text(LOG, encoding="utf-8")
    (saipen / "IDENTITY.md").write_text(
        identity_file_content(new_project_lineage()), encoding="utf-8"
    )
    (root / "README.md").write_text("# foreign project\n", encoding="utf-8")
    for rel, text in (extra or {}).items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    _git(root, "init", "-q")
    _git(root, "config", "user.email", "fixture@example.invalid")
    _git(root, "config", "user.name", "fixture")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "fixture")
    return root


def build(output: Path, project: Path, timeout: int = 900) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(BUILDER), str(output), "--project-root", str(project)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=hermetic_env(),
    )


def setUpModule() -> None:
    isolate_host_session()


class ForeignProjectPackagingTests(unittest.TestCase):
    """The claim the tool's own `--project-root` makes."""

    def test_a_project_that_is_not_this_repository_packages(self) -> None:
        with tempfile.TemporaryDirectory(prefix="saipen-t1349-") as tmp:
            base = Path(tmp)
            project = foreign_project(base)
            out = base / "foreign-CURRENT.zip"
            completed = build(out, project)
            self.assertEqual(
                completed.returncode,
                0,
                "a foreign SAIPEN project must package through the canonical "
                f"path:\n{completed.stdout[-2500:]}\n{completed.stderr[-800:]}",
            )
            self.assertTrue(out.is_file())
            with zipfile.ZipFile(out) as archive:
                names = {i.filename for i in archive.infolist() if not i.filename.endswith("/")}
            for required in (".saipen/STATE.md", ".saipen/BOARD.md", ".saipen/LOG.md",
                             ".saipen/IDENTITY.md", "README.md"):
                self.assertIn(required, names, sorted(names)[:20])

    def test_the_gate_is_the_protocol_verifier_not_the_packaged_project_s(self) -> None:
        """A snapshot must not supply the gate that clears it.

        Resolving the verifier inside the target made the delivery gate code
        the packaged project ships. This plants a verifier that would exit 0
        and record having run; the real gate must run instead, and the plant
        must stay untouched.
        """
        with tempfile.TemporaryDirectory(prefix="saipen-t1349-") as tmp:
            base = Path(tmp)
            receipt = base / "hostile-verifier-ran.txt"
            project = foreign_project(
                base,
                extra={
                    "tools/verify_handoff_archive.py": (
                        "from pathlib import Path\n"
                        f"Path(r'{receipt}').write_text('ran')\n"
                        "print('ARCHIVE_SHA256 0000')\n"
                        "raise SystemExit(0)\n"
                    )
                },
            )
            completed = build(base / "foreign-CURRENT.zip", project)
            self.assertFalse(
                receipt.exists(),
                "the packaged project's own verifier was executed as the "
                f"delivery gate:\n{completed.stdout[-1500:]}",
            )
            self.assertEqual(completed.returncode, 0, completed.stdout[-2500:])


class ThisRepositorysInventoryTests(unittest.TestCase):
    """T-1350: a declared sandbox must not arrive as delivery content.

    `.gitignore` already ruled on this once for saiwiki's `wiki/`, in its own
    words: a kitchen is a sandbox, and a nested git repository inside one
    becomes "a 160000 entry pointing at a commit no clone of this repo can
    fetch, with none of the content". saipython's `pen/` is the other sandbox
    -- its own tracked marker calls it scratch holding CLONES of target files
    -- and it was missed, so it had grown two nested repositories and 1534
    untracked files, including whole copies of this repository's own engine,
    all of which the whole-project inventory was collecting as real content.

    The check is on the INVENTORY rather than on the ignore file, so it stays
    true however the exclusion is spelled, and it is measured on this
    repository because that is where the sandboxes are.
    """

    def _inventory(self) -> list[str]:
        result = _git(REPO, "ls-files", "--others", "--exclude-standard", "-z")
        tracked = _git(REPO, "ls-files", "-z")
        entries: list[str] = []
        for completed in (result, tracked):
            self.assertEqual(completed.returncode, 0, completed.stderr[-400:])
            entries.extend(e for e in completed.stdout.split("\0") if e.strip())
        return entries

    def test_no_kitchen_sandbox_scratch_enters_the_delivery_inventory(self) -> None:
        entries = self._inventory()
        self.assertGreater(len(entries), 100, "the inventory probe found nothing to check")
        scratch = [
            entry
            for entry in entries
            if "/kitchen/pen/" in entry and not entry.endswith("/pen/_gitkeep")
        ]
        self.assertEqual(scratch[:10], [], f"{len(scratch)} sandbox file(s) in the inventory")

    def test_the_sandbox_marker_itself_stays_tracked(self) -> None:
        """Ignoring the contents must not erase what says the area is scratch."""
        tracked = _git(REPO, "ls-files", "-z").stdout.split("\0")
        markers = [entry for entry in tracked if entry.endswith("/kitchen/pen/_gitkeep")]
        self.assertTrue(markers, "the pen's marker stopped being tracked")

    def test_no_inventory_entry_is_a_directory(self) -> None:
        """A directory entry means git collapsed something it will not descend.

        Today that is only ever an embedded repository, and it is the shape
        that made the packager refuse this repository outright.
        """
        collapsed = [entry for entry in self._inventory() if entry.endswith("/")]
        self.assertEqual(collapsed, [], "git collapsed a directory into the inventory")


class ProtocolSourceBranchTests(unittest.TestCase):
    """The new branch must not swallow protocol-source deliveries.

    Gate H answers two different questions depending on what the archive is.
    A branch added for project snapshots is only safe if the ORIGINAL branch
    still claims every archive that carries protocol source -- otherwise the
    BOOT contract quietly stops being checked on the deliveries it exists for.
    """

    def test_an_archive_carrying_protocol_source_takes_the_boot_contract_branch(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="saipen-t1349-") as tmp:
            base = Path(tmp)
            project = foreign_project(
                base,
                extra={"tools/saipen.py": "raise SystemExit(3)\n"},
            )
            completed = build(base / "foreign-CURRENT.zip", project)
            self.assertNotIn(
                "this is a PROJECT SNAPSHOT",
                completed.stdout,
                "an archive carrying tools/saipen.py was gated as a project "
                "snapshot, so its BOOT contract went unchecked",
            )
            self.assertNotEqual(completed.returncode, 0, completed.stdout[-1200:])


class NonAsciiMemberTests(unittest.TestCase):
    """A quoting convention is not an escaped object."""

    NAME = "docs/report — final.md"

    def test_a_tracked_path_with_a_non_ascii_name_packages_and_round_trips(self) -> None:
        with tempfile.TemporaryDirectory(prefix="saipen-t1349-") as tmp:
            base = Path(tmp)
            body = "em dash in the name, ASCII in the body\n"
            project = foreign_project(base, extra={self.NAME: body})
            out = base / "foreign-CURRENT.zip"
            completed = build(out, project)
            self.assertEqual(
                completed.returncode,
                0,
                "a regular file whose name carries U+2014 was refused:\n"
                f"{completed.stdout[-2500:]}",
            )
            with zipfile.ZipFile(out) as archive:
                names = {i.filename for i in archive.infolist()}
                self.assertIn(self.NAME, names, sorted(names)[:20])
                # Against the BYTES on disk, not against the string that was
                # written: Windows text mode translates the newline, and the
                # claim here is byte identity of the packaged member.
                self.assertEqual(
                    archive.read(self.NAME),
                    (project / self.NAME).read_bytes(),
                    "the member round-tripped with different bytes",
                )

    def test_git_reports_that_name_quoted_which_is_what_broke_it(self) -> None:
        """The red control's premise, pinned so the case cannot rot silently."""
        with tempfile.TemporaryDirectory(prefix="saipen-t1349-") as tmp:
            project = foreign_project(Path(tmp), extra={self.NAME: "x\n"})
            quoted = _git(project, "ls-files").stdout.splitlines()
            nul = [p for p in _git(project, "ls-files", "-z").stdout.split("\0") if p]
            self.assertTrue(
                any(line.startswith('"') and "\\342\\200\\224" in line for line in quoted),
                quoted,
            )
            self.assertIn(self.NAME, nul, nul)


class EmbeddedRepositoryTests(unittest.TestCase):
    """The refusal is right; it has to say what it is refusing."""

    def test_an_embedded_repository_is_named_in_the_refusal(self) -> None:
        with tempfile.TemporaryDirectory(prefix="saipen-t1349-") as tmp:
            base = Path(tmp)
            project = foreign_project(base)
            nested = project / "vendor" / "embedded"
            nested.mkdir(parents=True)
            (nested / "thing.txt").write_text("inner\n", encoding="utf-8")
            _git(nested, "init", "-q")
            _git(nested, "config", "user.email", "fixture@example.invalid")
            _git(nested, "config", "user.name", "fixture")
            _git(nested, "add", "-A")
            _git(nested, "commit", "-q", "-m", "inner")

            completed = build(base / "foreign-CURRENT.zip", project)
            self.assertNotEqual(completed.returncode, 0, completed.stdout[-1500:])
            self.assertIn("embedded Git repository", completed.stdout, completed.stdout[-2500:])
            self.assertIn("vendor/embedded", completed.stdout.replace(os.sep, "/"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
