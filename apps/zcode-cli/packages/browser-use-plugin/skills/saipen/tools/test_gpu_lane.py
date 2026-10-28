"""SAIGPU: the idle-GPU recall lane is off by default, yields, and never decides.

Hermetic: the card, the backend and the embedding model are fakes, so the
family runs the same on a machine with no GPU. The fake embedder maps a text
to a bag-of-words vector, which is enough to prove ranking, incrementality and
the echo threshold without a model.

Proven here:
- OFF is the default, `SAIPEN_GPU=off` beats a stored ON, and with the switch
  down nothing embeds -- not the index, not even a recall query;
- the gate names why the card is not usable (NO_GPU, BACKEND_DOWN,
  MODEL_MISSING, GPU_BUSY, VRAM_LOW) and READY only when it is;
- a refresh embeds only what changed, drops what vanished, stops at its
  budget, gives the card back when the user takes it, and waits out a spike;
- recall ranks the project's own Work/decisions/knowledge, and the echo
  advisory names a near-duplicate Work above the threshold only;
- nothing the lane does touches STATE, BOARD or LOG;
- the side lane runs beside `supervise` only when ON and reports what it did;
- the CLI verb is DIAGNOSTIC, refuses unknown actions, and `ticket add`
  output and exit code are unchanged whether the advisory fires or not;
- T-1481 triage: a REAL red unittest run is captured, its red ids grouped by
  a mechanical signature that covers every id, each group annotated once,
  OFF produces nothing, a busy card pauses it and the next pass resumes.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib
import io
import json
import math
import os
import re
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import gpu  # noqa: E402

DIMS = 64
IDLE_CARD = {
    "name": "Fake",
    "utilization_percent": 3,
    "memory_total_mib": 12288,
    "memory_free_mib": 9000,
}


def fake_embed(texts):
    """Bag of words hashed into DIMS buckets, L2-normalized."""
    out = []
    for raw in texts:
        text = raw.split("Query: ", 1)[-1]
        vec = [0.0] * DIMS
        for word in re.findall(r"[a-z0-9]+", text.lower()):
            if len(word) < 3 or re.fullmatch(r"t\d+|p\d", word):
                continue
            vec[int(hashlib.sha256(word.encode()).hexdigest(), 16) % DIMS] += 1.0
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        out.append([x / norm for x in vec])
    return out


T12 = "- [ ] T-12 [P3] brochure typography uses the wrong font weight on headings | verify: look\n"
BOARD = (
    "## DOING\n"
    "- [/] T-10 [P1] sandbox copy of the saipen directory is torn during the evidence run"
    " | verify: regression | owner: astra\n"
    "## TODO\n"
    "- [ ] T-11 [P2] telegram message to the operator when the supervisor stops"
    " | verify: probe\n"
    f"{T12}"
    "## DONE\n"
)
LOG = (
    "- 23.09.26 01:00 [E-1] [agent: astra] [op: x] DEC: keep the writer lock while copying"
    " canonical state\n"
    "- 23.09.26 01:01 [E-2] [agent: astra] [op: y] RUN: build something\n"
)


class LaneTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="saigpu-")
        self.root = Path(self._tmp.name)
        saipen = self.root / ".saipen"
        saipen.mkdir()
        (saipen / "BOARD.md").write_text(BOARD, encoding="utf-8")
        (saipen / "LOG.md").write_text(LOG, encoding="utf-8")
        (saipen / "STATE.md").write_text("---\nlast_event: 2\n---\n", encoding="utf-8")
        (self.root / "KNOWLEDGE").mkdir()
        (self.root / "KNOWLEDGE" / "fonts.md").write_text(
            "# Fonts\n\nThe brochure headings use the display font at weight 600 always.\n",
            encoding="utf-8",
        )
        env = {k: v for k, v in os.environ.items() if k != gpu.ENV_SWITCH}
        self._env = mock.patch.dict(os.environ, env, clear=True)
        self._env.start()
        gpu.set_enabled(self.root, True, dims=DIMS, cooldown_s=0)
        self.card = dict(IDLE_CARD)
        self.backend = {"up": True, "models": ["qwen3-embedding:0.6b"]}
        self._probes = [
            mock.patch.object(
                gpu, "probe_gpu", lambda *a, **k: None if self.card is None else dict(self.card)
            ),
            mock.patch.object(gpu, "probe_backend", lambda *a, **k: dict(self.backend)),
            mock.patch.object(gpu, "_loaded_models", lambda _c: set()),
            mock.patch.object(gpu, "embed_ollama", lambda _c, texts, timeout=0: self.count(texts)),
        ]
        for patcher in self._probes:
            patcher.start()
        self.embedded_texts: list[str] = []

    def count(self, texts):
        self.embedded_texts.extend(texts)
        return fake_embed(texts)

    def tearDown(self) -> None:
        for patcher in self._probes:
            patcher.stop()
        self._env.stop()
        self._tmp.cleanup()

    def canonical(self) -> dict:
        return {
            name: (self.root / ".saipen" / name).read_bytes()
            for name in ("STATE.md", "BOARD.md", "LOG.md")
        }


class SwitchTests(LaneTestCase):
    def test_off_is_the_default(self):
        (gpu.cache_dir(self.root) / gpu.CONFIG_NAME).unlink()
        self.assertEqual(gpu.switch(self.root), (False, "default"))
        self.assertEqual(gpu.gate(self.root)["reason"], gpu.DISABLED)
        self.assertIsNone(gpu.start_side_lane(self.root))
        # A config that only tunes the lane never switches it on.
        (gpu.cache_dir(self.root) / gpu.CONFIG_NAME).write_text('{"batch": 4}', encoding="utf-8")
        self.assertEqual(gpu.switch(self.root), (False, "config"))

    def test_the_environment_beats_a_stored_on(self):
        with mock.patch.dict(os.environ, {gpu.ENV_SWITCH: "off"}):
            self.assertEqual(gpu.switch(self.root), (False, "env"))
            self.assertEqual(gpu.gate(self.root)["reason"], gpu.DISABLED)

    def test_off_means_not_even_a_query_is_embedded(self):
        gpu.refresh_index(self.root)
        self.embedded_texts.clear()
        gpu.set_enabled(self.root, False)
        answer = gpu.recall(self.root, "sandbox copy torn")
        self.assertEqual(answer["reason"], gpu.DISABLED)
        self.assertEqual(gpu.echo_advisory(self.root, "sandbox copy torn"), [])
        self.assertEqual(self.embedded_texts, [])


class GateTests(LaneTestCase):
    def test_each_unusable_condition_is_named(self):
        self.assertEqual(gpu.gate(self.root)["reason"], gpu.READY)
        self.card = None
        self.assertEqual(gpu.gate(self.root)["reason"], gpu.NO_GPU)
        self.card = dict(IDLE_CARD)
        self.backend = {"up": False, "models": []}
        self.assertEqual(gpu.gate(self.root)["reason"], gpu.BACKEND_DOWN)
        self.backend = {"up": True, "models": ["qwen3:14b"]}
        self.assertEqual(gpu.gate(self.root)["reason"], gpu.MODEL_MISSING)
        self.backend = {"up": True, "models": ["qwen3-embedding:0.6b"]}
        self.card["utilization_percent"] = 95
        self.assertEqual(gpu.gate(self.root)["reason"], gpu.GPU_BUSY)
        self.card = dict(IDLE_CARD, memory_free_mib=200)
        self.assertEqual(gpu.gate(self.root)["reason"], gpu.VRAM_LOW)


class IndexTests(LaneTestCase):
    def test_a_refresh_is_incremental_and_forgets_what_vanished(self):
        before = self.canonical()
        first = gpu.refresh_index(self.root)
        self.assertEqual(first["stop"], "COMPLETE")
        kinds = {item["kind"] for item in gpu.load_index(self.root)["items"].values()}
        self.assertEqual(kinds, {"work", "decision", "knowledge"})
        self.embedded_texts.clear()
        self.assertEqual(gpu.refresh_index(self.root)["embedded"], 0)
        board = self.root / ".saipen" / "BOARD.md"
        board.write_text(
            BOARD.replace(T12, ""),
            encoding="utf-8",
        )
        before["BOARD.md"] = board.read_bytes()
        again = gpu.refresh_index(self.root)
        self.assertEqual(again["embedded"], 0)
        self.assertNotIn("work:T-12", gpu.load_index(self.root)["items"])
        self.assertEqual(self.canonical(), before, "the lane wrote canonical state")

    def test_the_budget_bounds_a_refresh(self):
        ticks = iter(range(0, 10_000, 100))
        result = gpu.refresh_index(
            self.root, budget_s=50, clock=lambda: next(ticks), sleep=lambda _s: None
        )
        self.assertEqual(result["stop"], "BUDGET")
        self.assertGreater(result["pending"], 0)

    def test_the_user_taking_the_card_stops_the_refresh(self):
        gpu.set_enabled(self.root, True, batch=1)
        calls = {"n": 0}

        def busy_after_first():
            calls["n"] += 1
            return {"ok": calls["n"] == 1, "reason": gpu.READY if calls["n"] == 1 else gpu.GPU_BUSY}

        result = gpu.refresh_index(self.root, gate_check=busy_after_first, sleep=lambda _s: None)
        self.assertEqual(result["stop"], gpu.GPU_BUSY)
        self.assertEqual(result["embedded"], 1)

    def test_a_short_spike_is_waited_out(self):
        gpu.set_enabled(self.root, True, batch=1)
        answers = iter([gpu.READY, gpu.GPU_BUSY, gpu.READY] + [gpu.READY] * 50)

        def spiky():
            reason = next(answers)
            return {"ok": reason == gpu.READY, "reason": reason}

        result = gpu.refresh_index(self.root, gate_check=spiky, sleep=lambda _s: None)
        self.assertEqual(result["stop"], "COMPLETE")

    def test_an_idle_pass_writes_nothing(self):
        # T-1482: the side lane refreshes every two minutes; an unchanged
        # corpus must not rewrite a megabyte-sized index each time.
        gpu.refresh_index(self.root)
        writes = []
        real = gpu._write_json
        with mock.patch.object(gpu, "_write_json", lambda *a: writes.append(a) or real(*a)):
            self.assertEqual(gpu.refresh_index(self.root)["embedded"], 0)
        self.assertEqual(writes, [])


class RecallTests(LaneTestCase):
    def test_recall_ranks_the_projects_own_memory(self):
        gpu.refresh_index(self.root)
        answer = gpu.recall(self.root, "the evidence sandbox copy is torn", k=2)
        self.assertTrue(answer["ok"])
        self.assertEqual(answer["hits"][0]["ref"], "T-10")
        self.assertIn("ADVISORY", answer["advisory"])
        fonts = gpu.recall(self.root, "brochure headings font weight", k=1)
        self.assertIn(fonts["hits"][0]["ref"], ("T-12", "KNOWLEDGE/fonts.md#0"))

    def test_an_empty_or_foreign_index_says_so(self):
        self.assertEqual(gpu.recall(self.root, "anything")["reason"], "EMPTY_INDEX")
        gpu.refresh_index(self.root)
        gpu.set_enabled(self.root, True, dims=32)
        self.assertEqual(gpu.recall(self.root, "anything")["reason"], "INDEX_MODEL_MISMATCH")

    def test_the_echo_advisory_names_only_a_near_duplicate(self):
        gpu.refresh_index(self.root)
        echo = gpu.echo_advisory(
            self.root, "[P1] sandbox copy of the saipen directory is torn during the evidence run"
        )
        self.assertEqual([hit["ref"] for hit in echo], ["T-10"])
        self.assertEqual(
            gpu.echo_advisory(self.root, "[P2] add a dark mode switch to settings"), []
        )
        self.assertEqual(
            gpu.echo_advisory(
                self.root,
                "sandbox copy of the saipen directory is torn during the evidence run",
                exclude="T-10",
            ),
            [],
        )


class SideLaneTests(LaneTestCase):
    def test_the_side_lane_runs_when_on_and_reports(self):
        lane = gpu.start_side_lane(self.root, every=3600)
        self.assertIsNotNone(lane)
        summary = lane.stop(timeout=30)
        self.assertEqual(summary["runs"], 1)
        self.assertGreater(summary["embedded"], 0)

    def test_a_crashing_refresh_never_escapes_the_lane(self):
        def boom():
            raise RuntimeError("driver reset")

        lane = gpu.SideLane(self.root, every=3600, refresh=boom).start()
        summary = lane.stop(timeout=30)
        self.assertIn("driver reset", summary["last_stop"])

    def test_supervise_stops_the_lane_even_when_it_raises(self):
        # T-1482: the lane used to stop only through the loop's report().
        live_gpu = importlib.import_module("saipen_engine.gpu")
        worker = importlib.import_module("saipen_engine.worker")
        stopped = []

        class FakeLane:
            def stop(self, timeout=5.0):
                stopped.append(True)
                return {"runs": 0, "embedded": 0, "last_stop": None}

        fake_lane = mock.patch.object(live_gpu, "start_side_lane", lambda *_a, **_k: FakeLane())
        exploding = mock.patch.object(
            worker.supervisor, "decide", side_effect=RuntimeError("decider exploded")
        )
        with fake_lane, exploding, self.assertRaises(RuntimeError):
            worker.supervise(self.root, ["agent", "{model}"], max_cycles=1)
        self.assertEqual(stopped, [True])


RED_TESTS = (
    "import unittest\n\n\n"
    "class R(unittest.TestCase):\n"
    "    def test_one(self):\n        self.assertEqual(2, 1)\n\n"
    "    def test_two(self):\n        self.assertEqual(7, 5)\n\n"
    "    def test_three(self):\n        {}['missing']\n"
)


class TriageTests(LaneTestCase):
    """T-1481: a red family run gets mechanical groups and one hypothesis each."""

    def red_run(self) -> Path:
        """A REAL unittest run of three red tests, captured like `_evidence` does."""
        core_unit = importlib.import_module("saipen_engine.core_unit")
        test_runner = importlib.import_module("saipen_engine.test_runner")
        (self.root / "tools").mkdir(exist_ok=True)
        (self.root / "tools" / "test_red.py").write_text(RED_TESTS, encoding="utf-8")
        small = test_runner.TestFamily(
            core_unit.FAMILY_NAME,
            (sys.executable, "-B", "-m", "unittest", "discover", "-s", "tools", "-p", "test_*.py"),
            120,
        )
        with mock.patch.object(core_unit, "family", return_value=small):
            run = core_unit.run_family(self.root)
        self.assertEqual(len(run["red"]), 3)
        self.assertEqual(sorted(run["sections"]), run["red"])
        kept = core_unit.keep_red_sections(
            self.root, ".saipen/evidence/core-unit/abc-20260923T000000Z.json", run["sections"]
        )
        return self.root / kept

    def hypothesis(self, _system, prompt):
        self.prompts.append(prompt)
        return "look at " + prompt.split("\n", 1)[0]

    def setUp(self) -> None:
        super().setUp()
        self.prompts: list[str] = []
        self.ready = lambda: {"ok": True, "reason": gpu.READY}

    def test_every_red_id_is_covered_and_every_group_annotated(self):
        red_file = self.red_run()
        before = self.canonical()
        result = gpu.triage(self.root, chat=self.hypothesis, gate_check=self.ready)
        self.assertTrue(result["ok"], result)
        written = json.loads((self.root / result["file"]).read_text(encoding="utf-8"))
        ids = sorted(i for group in written["groups"] for i in group["ids"])
        sections = json.loads(red_file.read_text(encoding="utf-8"))["sections"]
        self.assertEqual(ids, sorted(sections))
        # 2 != 1 and 7 != 5 are one root cause; the KeyError is another.
        self.assertEqual(sorted(len(g["ids"]) for g in written["groups"]), [1, 2])
        self.assertTrue(all(g["hypothesis"] for g in written["groups"]))
        self.assertIn("ADVISORY", written["advisory"])
        self.assertEqual(len(self.prompts), 2)
        self.assertEqual(self.canonical(), before, "triage wrote canonical state")
        self.assertIsNone(gpu.pending_triage(self.root))

    def test_off_produces_nothing(self):
        self.red_run()
        gpu.set_enabled(self.root, False)
        result = gpu.triage(self.root, chat=self.hypothesis, gate_check=self.ready)
        self.assertEqual(result["stop"], gpu.DISABLED)
        self.assertFalse((gpu.cache_dir(self.root) / gpu.TRIAGE_DIR).exists())
        self.assertEqual(self.prompts, [])

    def test_the_user_taking_the_card_pauses_and_the_next_pass_resumes(self):
        self.red_run()
        # The user's load stays: READY once, then busy past every patience retry.
        answers = iter([gpu.READY] + [gpu.GPU_BUSY] * 20)
        first = gpu.triage(
            self.root,
            chat=self.hypothesis,
            gate_check=lambda: (lambda r: {"ok": r == gpu.READY, "reason": r})(next(answers)),
            sleep=lambda _s: None,
        )
        self.assertEqual((first["stop"], first["annotated"]), (gpu.GPU_BUSY, 1))
        self.assertIsNotNone(gpu.pending_triage(self.root))
        second = gpu.triage(
            self.root, chat=self.hypothesis, gate_check=self.ready, sleep=lambda _s: None
        )
        self.assertTrue(second["ok"])
        self.assertEqual(len(self.prompts), 2, "an annotated group was asked twice")

    def test_triage_never_yields_to_its_own_inference(self):
        # Measured live: the first real run stopped GPU_BUSY after ONE group --
        # the card was 99 % busy with the lane's own model. The card reads busy
        # right after a call and idle once the lane has rested.
        self.red_run()
        state = {"hot": False}

        def chat(system, prompt):
            state["hot"] = True
            return self.hypothesis(system, prompt)

        def rest(_seconds):
            state["hot"] = False

        def card():
            reason = gpu.GPU_BUSY if state["hot"] else gpu.READY
            return {"ok": reason == gpu.READY, "reason": reason}

        result = gpu.triage(self.root, chat=chat, gate_check=card, sleep=rest)
        self.assertEqual((result["stop"], result["annotated"]), ("COMPLETE", 2))

    def test_the_side_lane_triages_a_waiting_run(self):
        self.red_run()
        live = importlib.import_module("saipen_engine.gpu")
        with mock.patch.object(
            live, "chat_ollama", lambda _c, s, p: self.hypothesis(s, p)
        ), mock.patch.object(live, "gate", lambda *_a, **_k: self.ready()):
            lane = live.SideLane(self.root, every=3600).start()
            deadline = time.monotonic() + 60
            while lane.last_triage is None and time.monotonic() < deadline:
                time.sleep(0.05)
            summary = lane.stop(timeout=60)
        self.assertEqual(summary["triage_annotated"], 2)
        self.assertEqual(summary["last_triage_stop"], "COMPLETE")


def _live_gpu():
    """The gpu module `saipen.py` will import NOW (see test_t1479's `_engine`):
    an earlier suite in the declared family purges `saipen_engine*` from
    `sys.modules`, and a patch on the name bound at import would miss."""
    return importlib.import_module("saipen_engine.gpu")


class CliTests(unittest.TestCase):
    def test_the_verb_is_registered_as_diagnostic(self):
        home = TOOLS.parent / "saipen"
        effects = json.loads((home / "COMMAND_EFFECTS.json").read_text(encoding="utf-8"))
        self.assertEqual(effects["verbs"]["gpu"], "DIAGNOSTIC")
        registry = (home / "REGISTRY.json").read_text(encoding="utf-8")
        self.assertIn('"gpu"', registry)

    def test_unknown_actions_are_refused_and_status_answers_off(self):
        import saipen

        gpu = _live_gpu()
        with tempfile.TemporaryDirectory(prefix="saigpu-cli-") as tmp, mock.patch.dict(
            os.environ, {gpu.ENV_SWITCH: "off"}
        ):
            root = Path(tmp)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(saipen._gpu(root, ["bogus"], True), 2)
            self.assertIn("VALIDATION_FAILED", out.getvalue())
            out = io.StringIO()
            with contextlib.redirect_stdout(out), mock.patch.object(
                gpu, "probe_gpu", lambda *a, **k: None
            ), mock.patch.object(gpu, "probe_backend", lambda *a, **k: {"up": False, "models": []}):
                self.assertEqual(saipen._gpu(root, ["status"], True), 0)
            payload = json.loads(out.getvalue())
            self.assertFalse(payload["enabled"])
            self.assertEqual(payload["lane"], gpu.DISABLED)
            # T-1482: OFF routes to the switch, not to an index that refuses too.
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(saipen._gpu(root, ["recall", "anything"], True), 1)
            refusal = json.loads(out.getvalue())
            self.assertEqual(refusal["reason"], gpu.DISABLED)
            self.assertEqual(refusal["canonical_next_command"], "saipen gpu on")

    def test_the_echo_advisory_goes_to_stderr_only(self):
        import saipen

        gpu = _live_gpu()
        err = io.StringIO()
        with mock.patch.object(
            gpu, "echo_advisory", lambda *a, **k: [{"ref": "T-10", "score": 0.91}]
        ), contextlib.redirect_stderr(err):
            saipen._gpu_echo_advisory(Path("."), "text", "T-99")
        self.assertIn("T-99 may echo T-10", err.getvalue())
        err = io.StringIO()
        with mock.patch.object(
            gpu, "echo_advisory", side_effect=RuntimeError("x")
        ), contextlib.redirect_stderr(err):
            saipen._gpu_echo_advisory(Path("."), "text", "T-99")
        self.assertEqual(err.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
