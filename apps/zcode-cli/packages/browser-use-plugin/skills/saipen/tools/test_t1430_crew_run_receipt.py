"""T-1430: a crew_run receipt has one reachable canonical producer.

crew.py lets a sensor stage (SC-2 for saihunt) pass only when a COMMITTED
crew_run receipt binds a current package to the active crew epoch, but
`operations.record_crew_run` had no caller and no verb reached it: the only
crew_run receipts were hand-written fixtures, and the production path accepted
them. `saipen crew record-run <ROLE>` is now the producer -- epoch, source
identity and role revision are read, never supplied -- and a receipt counts
only when the journal wrote its LOG line.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from freshness import compute_role_revision, compute_source_identity  # noqa: E402
from saipen_engine.crew import crew_plan  # noqa: E402
from saipen_engine.journal import ensure_project_lineage  # noqa: E402
from saipen_engine.operations import set_converge_intent  # noqa: E402
from saipen_engine.paths import project_identity, project_lineage_identity  # noqa: E402
from saipen_engine.subs import (  # noqa: E402
    SUBS_REL,
    current_local_role_revision,
    package_identity,
    parse_outbox,
    sub_spawn,
)
from test_hermetic_env import isolate_host_session  # noqa: E402
from test_t1363_zero_manual_entry import cli  # noqa: E402

ROLES = ("saihunt", "saitest", "saipython", "saiui", "saitranslate", "saiwiki")


def setUpModule() -> None:
    isolate_host_session()


def _home(base: Path) -> Path:
    """An installed home with every crew charter and the sub template."""
    home = base / "home"
    (home / "saipen").mkdir(parents=True)
    (home / "saipen" / "BOOT.md").write_text("# probe installed protocol\n", encoding="utf-8")
    subs = home / "extensions" / "subs"
    (subs / "TEMPLATE" / "kitchen").mkdir(parents=True)
    (subs / "_shared").mkdir(parents=True)
    for name in ROLES:
        producer = name in ("saitranslate", "saiwiki")
        charter = subs / f"{name}.md"
        charter.write_text(
            f"# {name} -- role\n\n```yaml\n"
            f"role_kind: {'PRODUCER' if producer else 'SCOUT'}\n"
            f'write_scope: ".saipen/extensions/subs/{name}/"\ntrigger: "probe"\n'
            f"collect_policy: {'explicit' if producer else 'core-review'}\n"
            'done_condition: "probe"\nfreshness_inputs: ["source_head", '
            '"source_tree_fingerprint", "role_revision"]\n'
            'output_contract: "PROTOCOL.md § 2 complete package"\n'
            f'role_revision: "sha256:probe-{name}"\n```\n',
            encoding="utf-8",
        )
        text = charter.read_text(encoding="utf-8")
        charter.write_text(
            text.replace(
                re.search(r'role_revision: "[^"]+"', text).group(0),
                f'role_revision: "{compute_role_revision(charter)}"',
            ),
            encoding="utf-8",
        )
    for shared in ("PROTOCOL.md", "README.md", "crew.md"):
        (subs / shared).write_text(f"# {shared}\nprobe shared content\n", encoding="utf-8")
    (subs / "TEMPLATE" / "STATE.md").write_text(
        '---\nphase: PLAN\ntask: none\nnext_action: "saipen plan"\n'
        "blocker: none\nagent: <name>\nsaipen_version: 7\nschema_version: 3\n"
        'style_contract: ded-probe\nsaipen_home: ""\nmode: read-only\n'
        "transition_from: INIT\nupdated: 2026-01-01T00:00:00Z\n---\n",
        encoding="utf-8",
    )
    (subs / "TEMPLATE" / "BOARD.md").write_text(
        "# Board\n\n## DOING\n\n## TODO\n\n## DONE\n\n## BLOCKED\n", encoding="utf-8"
    )
    (subs / "TEMPLATE" / "LOG.md").write_text("# Log\n", encoding="utf-8")
    (subs / "TEMPLATE" / "kitchen" / "OUTBOX.md").write_text("# OUTBOX\n", encoding="utf-8")
    (subs / "_shared" / "inbox.md").write_text("# shared inbox\n\n- seed entry\n", encoding="utf-8")
    return home


class CrewRunReceiptTests(unittest.TestCase):
    def setUp(self) -> None:
        base = Path(tempfile.mkdtemp(prefix="saipen-t1430-"))
        self.addCleanup(shutil.rmtree, base, True)
        self.home = _home(base)
        self.root = base / "project"
        saipen = self.root / ".saipen"
        (saipen / "extensions").mkdir(parents=True)
        (saipen / "STATE.md").write_text(
            '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\nblocker: ""\n'
            "transition_from: SHIP\nsaipen_version: 7\nschema_version: 3\n"
            f'style_contract: ded-probe\nsaipen_home: "{self.home.as_posix()}"\n'
            'agent: probe\nmode: full\nupdated: "2026-08-13T00:00:00Z"\n---\n',
            encoding="utf-8",
        )
        (saipen / "LOG.md").write_text("# Log\n", encoding="utf-8")
        (saipen / "BOARD.md").write_text(
            "# Board\n\n## DOING\n\n## TODO\n\n## DONE\n\n## BLOCKED\n", encoding="utf-8"
        )
        ensure_project_lineage(self.root)
        # SC-1 needs every durable role present and idle.
        for name in ("saihunt", "saitest", "saipython", "saiui", "saiwiki"):
            spawned = sub_spawn(self.root, name, self.home.as_posix())
            self.assertTrue(spawned.ok, spawned.message)
            state = self.root / SUBS_REL / name / "STATE.md"
            state.write_text(
                state.read_text(encoding="utf-8")
                .replace("phase: PLAN", "phase: DONE")
                .replace("transition_from: INIT", "transition_from: PLAN"),
                encoding="utf-8",
            )
        self.source = compute_source_identity(self.root)
        self.outbox = self.root / SUBS_REL / "saihunt" / "kitchen" / "OUTBOX.md"

    def package(self, package_id: str, fingerprint: str | None = None) -> str:
        revision = current_local_role_revision(self.root, "saihunt", self.home.as_posix())
        return (
            f"## {package_id}: complete evidence\n- **status:** ready\n"
            "- **producer:** saihunt\n"
            f"- **source_head:** {self.source.source_head}\n"
            "- **source_tree_fingerprint:** "
            f"{fingerprint or self.source.source_tree_fingerprint}\n"
            f"- **role_revision:** {revision}\n"
            "- **coverage:** complete role surface\n"
            "- **payload:** []\n- **verified:** PASS -- probe\n"
            "- **instructions:** Core reviews evidence\n"
        )

    def write_outbox(self, *packages: str) -> None:
        self.outbox.write_text("# OUTBOX\n\n" + "\n".join(packages), encoding="utf-8")

    def enter_crew(self) -> str:
        entered = set_converge_intent(self.root, "probe", "crew")
        self.assertTrue(entered.ok, entered.message)
        return entered.op_id

    def sc2(self) -> dict:
        plan = crew_plan(self.root, current_capability="full", current_agent="probe")
        stages = {stage["stage"]: stage for stage in plan["stages"]}
        self.assertIn("SC-2", stages, plan)
        return stages["SC-2"]

    def test_sc2_waits_for_a_receipt_then_the_command_satisfies_it(self):
        self.write_outbox(self.package("HUNT-900"))
        self.enter_crew()
        before = self.sc2()
        self.assertFalse(before["satisfied"], before)
        self.assertIn("CURRENT != FRESH FOR THIS CREW EPOCH", before["reason"])

        code, payload, text = cli(self.root, "crew", "record-run", "saihunt", "--json")
        self.assertEqual(code, 0, text)
        self.assertEqual(payload["code"], "CREW_RUN_RECORDED", payload)
        after = self.sc2()
        self.assertTrue(after["satisfied"], after)
        # The journal wrote the receipt's LOG line, attributed to the actor.
        log = (self.root / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        line = next(item for item in log.splitlines() if "crew run -- epoch" in item)
        self.assertIn(f"[{payload['event_id']}]", line)
        self.assertIn("[agent: test-agent]", line)
        self.assertIn("role saihunt", line)

    def test_a_hand_written_receipt_is_not_accepted(self):
        self.write_outbox(self.package("HUNT-900"))
        epoch = self.enter_crew()
        model = parse_outbox(self.outbox.read_text(encoding="utf-8"), "saihunt")
        op_id = "crew-run-handwritten"
        receipt = {
            "op_id": op_id,
            "operation": "crew_run",
            "status": "COMMITTED",
            "created_at": "2026-08-13T00:00:03Z",
            "agent": "probe",
            "project_identity": project_identity(self.root),
            "project_lineage": project_lineage_identity(self.root),
            "semantic_payload_hash": "sha256:fixture",
            "verification_policy": "none",
            "preconditions": {},
            "read_preconditions": {},
            "progress_index": 1,
            "targets": [
                {
                    "path": ".saipen/LOG.md",
                    "role": "log",
                    "action": "write",
                    "before_hash": "",
                    "after_hash": "",
                    "applied": True,
                }
            ],
            "receipt_metadata": {
                "operation": "crew_run",
                "status": "COMMITTED",
                "role": "saihunt",
                "package_identities": [package_identity(model.packages[0])],
                "crew_epoch": epoch,
                "source_head": self.source.source_head,
                "source_tree_fingerprint": self.source.source_tree_fingerprint,
                "event_id": "E-1",
            },
        }
        directory = self.root / ".saipen" / "recovery" / "ops" / op_id
        directory.mkdir(parents=True)
        (directory / "operation.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
        stage = self.sc2()
        self.assertFalse(stage["satisfied"], stage)

    def test_the_producer_refuses_what_it_cannot_bind(self):
        # HUNT-800 was produced on another tree: stale for this source triple.
        stale = self.package("HUNT-800", fingerprint="no-git-tree-v1:" + "0" * 64)
        self.write_outbox(self.package("HUNT-900"), stale)
        code, payload, text = cli(self.root, "crew", "record-run", "saihunt", "--json")
        self.assertEqual((code, payload["code"]), (1, "CREW_NOT_READY"), text)
        self.enter_crew()
        for args, expected in (
            (("saihunt", "--package", "HUNT-800"), "STALE_PACKAGE"),
            (("saihunt", "--package", "HUNT-404"), "STALE_PACKAGE"),
            (("saifoo",), "INVALID_ROLE"),
            (("saitest",), "NO_READY_PACKAGE"),
        ):
            with self.subTest(args=args):
                code, payload, text = cli(self.root, "crew", "record-run", *args, "--json")
                self.assertEqual((code, payload["code"]), (1, expected), text)
        stage = self.sc2()
        self.assertFalse(stage["satisfied"], stage)
        code, payload, text = cli(
            self.root, "crew", "record-run", "saihunt", "--package", "HUNT-900", "--json"
        )
        self.assertEqual(code, 0, text)
        self.assertTrue(self.sc2()["satisfied"])


if __name__ == "__main__":
    unittest.main()
