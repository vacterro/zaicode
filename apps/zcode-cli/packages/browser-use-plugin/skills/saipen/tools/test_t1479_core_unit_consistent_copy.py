"""T-1479: the core-unit sandbox holds ONE checkpoint, never a torn copy.

Measured in E-8355 / E-8359: `core_unit.run_family` copied the live `.saipen`
with a plain `shutil.copytree`. A checkpoint that landed between the copy of
LOG.md and the copy of STATE.md left the sandbox with STATE.last_event ahead of
the LOG tail, every `status --json` in it answered VALIDATION_FAILED
checkpoint-invalid, and state-reading tests went red outside the baseline. The
evidence verdict then described the copy race, not the subject.

The writer here is deterministic: it fires while the copy walks a directory
that sorts between LOG.md and STATE.md, and like every canonical writer it
writes only when it can take the project writer lock.

Proven here:
- a checkpoint attempted mid-copy never tears the sandbox (red against the
  plain copytree), and the first copy never locks a canonical writer out;
- when the writer lock cannot be taken, a checkpoint that lands mid-copy is
  detected and the copy is retried until it holds one checkpoint;
- a torn attempt is abandoned beside the sandbox, never deleted in place, so
  read-only files in `.saipen` cannot break the retry;
- a `.saipen` that never stops changing is refused, never copied torn.
"""

from __future__ import annotations

import importlib
import re
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))


def _engine(name: str):
    """The engine module `run_family` will actually import, resolved NOW.

    Inside the declared family an earlier suite (test_metrics_acceptance)
    purges every `saipen_engine*` entry from `sys.modules`. Names bound when
    this module was imported then point at dead module objects, a
    `patch.object` on them misses, and the test measures the harness instead
    of the copy (measured: 3 new red in the T-1480 family run, green alone).
    """
    return importlib.import_module(f"saipen_engine.{name}")


#: Sorts after LOG.md and before STATE.md, so the writer fires between them.
MIDPOINT = "M_mid"


def _state_event(saipen: Path) -> int:
    return int(re.search(r"last_event: (\d+)", (saipen / "STATE.md").read_text()).group(1))


def _log_tail(saipen: Path) -> int:
    return max(int(n) for n in re.findall(r"\[E-(\d+)\]", (saipen / "LOG.md").read_text()))


def _checkpoint(saipen: Path, event: int) -> None:
    """LOG first, then STATE -- the order the canonical writer uses."""
    with (saipen / "LOG.md").open("a", encoding="utf-8") as log:
        log.write(f"- [E-{event}] RUN: checkpoint\n")
    (saipen / "STATE.md").write_text(f"---\nlast_event: {event}\n---\n", encoding="utf-8")


class ConsistentCopyTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1479-")
        self.project = Path(self._tmp.name) / "project"
        saipen = self.project / ".saipen"
        (saipen / MIDPOINT).mkdir(parents=True)
        (saipen / MIDPOINT / "keep.txt").write_text("x", encoding="utf-8")
        (saipen / "LOG.md").write_text("- [E-1] RUN: start\n", encoding="utf-8")
        (saipen / "STATE.md").write_text("---\nlast_event: 1\n---\n", encoding="utf-8")
        # The saiwiki kitchen clone keeps read-only git objects under .saipen;
        # rmtree cannot remove them on Windows, so a torn copy must never be
        # cleaned up in place (measured: FileExistsError on the retry).
        readonly = saipen / "extensions" / "objects" / "ab01"
        readonly.parent.mkdir(parents=True)
        readonly.write_bytes(b"blob")
        readonly.chmod(stat.S_IREAD)
        (self.project / "tools").mkdir()
        self.saipen = saipen
        self.writes = 0
        self.seen: list[tuple[int, int]] = []

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _writer(self, *, respects_lock: bool, times: int):
        def write() -> None:
            if self.writes >= times:
                return
            if respects_lock:
                lock = _engine("lock").WriterLock(self.project)
                try:
                    lock.acquire()
                except PermissionError:
                    return
                try:
                    _checkpoint(self.saipen, _log_tail(self.saipen) + 1)
                finally:
                    lock.release()
            else:
                _checkpoint(self.saipen, _log_tail(self.saipen) + 1)
            self.writes += 1

        return write

    def _run(self, write) -> None:
        core_unit, test_runner = _engine("core_unit"), _engine("test_runner")
        real_ignore = test_runner._ignore_copy

        def ignore(directory, names):
            if Path(directory).name == MIDPOINT and Path(directory).parent.name == ".saipen":
                write()
            return real_ignore(directory, names)

        def family(sandbox, _family, *, spool):
            sandbox_saipen = Path(sandbox) / ".saipen"
            self.seen.append((_state_event(sandbox_saipen), _log_tail(sandbox_saipen)))
            (Path(spool) / "stderr").write_bytes(b"\nRan 0 tests in 0.0s\n\nOK\n")
            return {"status": "PASS", "exit_code": 0}

        with mock.patch.object(test_runner, "_ignore_copy", ignore), mock.patch.object(
            test_runner, "_run_family", family
        ), mock.patch.object(core_unit.time, "sleep", lambda _s: None):
            core_unit.run_family(self.project)

    def test_a_checkpoint_attempted_mid_copy_never_tears_the_sandbox(self):
        self._run(self._writer(respects_lock=True, times=1))
        ((state_event, log_tail),) = self.seen
        self.assertEqual(state_event, log_tail, "sandbox STATE.last_event != LOG tail")
        # The first copy holds no lock: a canonical writer is never refused
        # WRITER_BUSY for the tens of seconds a `.saipen` copy takes.
        self.assertEqual(self.writes, 1, "the writer was locked out of the first copy")

    def test_a_checkpoint_that_lands_anyway_is_detected_and_the_copy_retried(self):
        with mock.patch.object(
            _engine("lock").WriterLock, "acquire", side_effect=PermissionError("WRITER_BUSY")
        ):
            self._run(self._writer(respects_lock=False, times=2))
        ((state_event, log_tail),) = self.seen
        self.assertEqual(state_event, log_tail, "sandbox STATE.last_event != LOG tail")
        self.assertEqual(self.writes, 2)

    def test_a_saipen_that_never_settles_is_refused_not_copied_torn(self):
        busy = mock.patch.object(
            _engine("lock").WriterLock, "acquire", side_effect=PermissionError("WRITER_BUSY")
        )
        with busy, self.assertRaises(RuntimeError) as caught:
            self._run(self._writer(respects_lock=False, times=10**6))
        self.assertIn("CORE_UNIT_COPY_TORN", str(caught.exception))
        self.assertEqual(self.seen, [])

    def test_the_regression_survives_a_purged_engine_import(self):
        # What the family does to this module before it runs (see _engine).
        saved = {name: mod for name, mod in sys.modules.items() if name.startswith("saipen_engine")}
        for name in saved:
            del sys.modules[name]
        try:
            self._run(self._writer(respects_lock=True, times=1))
        finally:
            for name in [n for n in sys.modules if n.startswith("saipen_engine")]:
                del sys.modules[name]
            sys.modules.update(saved)
        ((state_event, log_tail),) = self.seen
        self.assertEqual(state_event, log_tail, "sandbox STATE.last_event != LOG tail")


if __name__ == "__main__":
    unittest.main()
