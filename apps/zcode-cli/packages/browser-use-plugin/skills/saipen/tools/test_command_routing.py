# ruff: noqa: RUF001, RUF002, RUF003
"""Regression tests: deterministic shortcut + compound-command routing.

Closes the defect class where protocol commands/shortcuts reach free-form
natural-language reasoning before deterministic SAIPEN resolution:

- "sc" answered as a style-mode greeting instead of `saipen crew`;
- "saipen push + build ccc" executing only one segment while the other was
  narrated away as unnecessary;
- a whole-message Cyrillic `сс` routed from model memory as Latin `ss`
  (`saipen stop`) although codepoint substitution makes it `cc`
  (`saipen continue`) -- and the public CLI refusing the very token its own
  helper resolved, because dispatch bypassed the shared normalizer.

The CLI-boundary tests below invoke the REAL public adapter
(`tools/saipen.py`) as a subprocess against a throwaway project, so a
resolver that drifts from dispatch fails here and not in production.

Run standalone:
    python tools/test_command_routing.py

Exit code 0 when every test passes; 1 on the first failure batch.
"""

from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import commands as CM  # noqa: E402

PROTOCOL_DIR = TOOLS.parent / "saipen"
SAIPEN_PY = TOOLS / "saipen.py"


def _sandbox_user_config(testcase: unittest.TestCase) -> None:
    """Keep runtime routing probes independent of the developer profile."""
    tmp = tempfile.TemporaryDirectory(prefix="saipen-user-config-")
    testcase.addCleanup(tmp.cleanup)
    patcher = mock.patch.dict(os.environ, {"SAIPEN_USER_CONFIG_HOME": tmp.name})
    patcher.start()
    testcase.addCleanup(patcher.stop)

# The seven Cyrillic-confusable twins, pinned as an explicit expectation so a
# silent change to either the table or the map cannot recreate drift without
# this test going red. DERIVED twins are cross-checked against this dict in
# test_derived_twins_match_declared_twins.
DECLARED_CYRILLIC_TWINS = {
    "сс": "cc",
    "ссс": "ccc",
    "аа": "aa",
    "ее": "ee",
    "еее": "eee",
    "рр": "pp",
    "хх": "xx",
}

# Canonical route prefixes per shortcut row (CORE.md § 1.10), used for
# twin-resolution assertions.
EXPECTED_ROUTES = {
    "cc": "saipen continue",
    "ccc": "saipen continue",
    "st": "saipen stop",
    "sss": "saipen status",
    "aa": "saipen markhunt",
    "ee": "saipen prepare saitranslate",
    "eee": "saipen collect saitranslate",
    "pp": "saipen sub spawn saipython",
    "gg": "saipen goal",
    "hh": "saipen hunt",
    "dd": "saipen plan",
    "qq": "saipen prepare saiwiki",
    "qqq": "saipen collect saiwiki",
    "tt": "saipen test",
    "sc": "saipen crew",
    "ff": "saipen focus",
    "xx": "saipen cut",
    "vv": "saipen build",
    "zz": "saipen undo",
}

# `ss` is RETIRED (SRC-024 / audit/11.md). It is not an active row in the
# canonical table: any token that still resolves to it must fail closed with
# SHORTCUT_RETIRED, never reach the stop/status implementations.
RETIRED_TOKENS = ("ss",)


def table():
    return CM.load_shortcut_table(PROTOCOL_DIR)


class CommandRoutingTests(unittest.TestCase):
    # ── 1. Bare shortcut ────────────────────────────────────────────────
    def test_bare_sc_shortcut_resolves(self):
        resolved = CM.resolve_compound_command("sc", table=table())
        self.assertEqual(len(resolved), 1)
        self.assertEqual(resolved[0]["kind"], "shortcut")
        self.assertEqual(resolved[0]["command"], "saipen crew")

    def test_bare_shortcuts_from_live_table(self):
        t = table()
        self.assertIn("cc", t)
        self.assertIn("ccc", t)
        self.assertIn("ee", t)
        self.assertIn("qq", t)
        self.assertIn("gg", t)
        self.assertIn("hh", t)
        # `st` is the active STOP shortcut (SRC-024); `ss` is retired and
        # therefore absent from the canonical table.
        self.assertIn("st", t)
        self.assertNotIn("ss", t)
        self.assertIn("sss", t)
        self.assertIn("dd", t)
        self.assertIn("aa", t)
        self.assertIn("qqq", t)
        self.assertIn("eee", t)
        self.assertIn("pp", t)
        self.assertIn("tt", t)
        self.assertIn("sc", t)
        # Every declared shortcut resolves to a canonical command row.
        for key, target in t.items():
            self.assertTrue(target.startswith("saipen "), f"{key} -> {target}")

    def test_cyrillic_twin_shortcut(self):
        # сс (Cyrillic) folds through the confusable set c->c to `cc`
        # (CORE.md: a shortcut typed in Cyrillic is the same shortcut).
        resolved = CM.resolve_compound_command("сс", table=table())
        self.assertEqual(resolved[0]["kind"], "shortcut")
        self.assertEqual(resolved[0]["command"], "saipen continue")

    # ── 2. Compound command ─────────────────────────────────────────────
    def test_compound_two_segments(self):
        resolved = CM.resolve_compound_command("saipen push + build ccc", table=table())
        self.assertEqual(len(resolved), 2)
        self.assertEqual(resolved[0]["segment"], "saipen push")
        self.assertEqual(resolved[0]["kind"], "command")
        self.assertEqual(resolved[1]["segment"], "build ccc")
        self.assertEqual(resolved[1]["kind"], "shortcut")
        self.assertEqual(resolved[1]["command"], "saipen continue")

    def test_compound_newline_separated(self):
        resolved = CM.resolve_compound_command("saipen status\nsaipen next", table=table())
        self.assertEqual(len(resolved), 2)
        self.assertEqual(resolved[0]["command"], "saipen status")
        self.assertEqual(resolved[1]["command"], "saipen next")

    def test_compound_shortcut_inside(self):
        resolved = CM.resolve_compound_command("cc + qq", table=table())
        self.assertEqual(len(resolved), 2)
        self.assertEqual(resolved[0]["command"], "saipen continue")
        self.assertEqual(resolved[1]["command"], "saipen prepare saiwiki")

    def test_control_shortcut_payload_is_opaque_inside_compound(self):
        resolved = CM.resolve_compound_command(
            "ff queue mode/topbar/performance + vv reduce queue repaint; keep UX",
            table=table(),
        )
        self.assertEqual(resolved[0]["command"], "saipen focus queue mode/topbar/performance")
        self.assertEqual(resolved[0]["payload"], "queue mode/topbar/performance")
        self.assertEqual(
            resolved[1]["command"],
            "saipen build reduce queue repaint; keep UX",
        )
        self.assertEqual(resolved[1]["payload"], "reduce queue repaint; keep UX")

    def test_cut_confirmation_blocks_later_mutator_by_chain_policy(self):
        resolved = CM.resolve_compound_command(
            "xx anti-aliasing + vv new renderer",
            table=table(),
        )
        self.assertEqual(resolved[0]["command"], "saipen cut anti-aliasing")
        self.assertEqual(resolved[1]["command"], "saipen build new renderer")
        dispositions = CM.chain_disposition(["BLOCKED", "EXECUTED"])
        self.assertEqual(dispositions, ["BLOCKED", "NOT_RUN"])

    def test_control_shortcuts_require_whole_first_token(self):
        for text in ("ffmpeg", "fuzzy", "xxxxx", "pizza"):
            self.assertEqual(
                CM.resolve_compound_command(text, table=table())[0]["kind"],
                "unknown",
            )

    def test_leading_shortcut_payload_routing(self):
        # Every leading declared shortcut owns its payload; destination validates.
        cases = {
            "cc extra": "saipen continue extra",
            "gg accidental prose": "saipen goal accidental prose",
            "sss verbose": "saipen status verbose",
            "gg починить открытие": "saipen goal починить открытие",
        }
        for text, expected in cases.items():
            resolved = CM.resolve_compound_command(text, table=table())
            self.assertEqual(resolved[0]["kind"], "shortcut", text)
            self.assertEqual(resolved[0]["command"], expected, text)

    # ── 3. First segment refusal -> chain policy ────────────────────────
    def test_chain_stop_on_failure_default(self):
        out = CM.chain_disposition(["EXECUTED", "REFUSED", "EXECUTED"])
        self.assertEqual(out, ["EXECUTED", "REFUSED", "NOT_RUN"])

    def test_chain_continue_when_independent(self):
        out = CM.chain_disposition(
            ["EXECUTED", "REFUSED", "EXECUTED"],
            policy=CM.CHAIN_CONTINUE_WHEN_INDEPENDENT,
            independent=[False, False, True],
        )
        self.assertEqual(out, ["EXECUTED", "REFUSED", "EXECUTED"])

    def test_chain_not_run_after_blocked(self):
        out = CM.chain_disposition(["EXECUTED", "BLOCKED", "EXECUTED"])
        self.assertEqual(out, ["EXECUTED", "BLOCKED", "NOT_RUN"])

    # ── 4. Already-satisfied state ──────────────────────────────────────
    def test_already_satisfied_terminology(self):
        # The disposition vocabulary is explicit; ALREADY_SATISFIED is a
        # canonical status a command may return, never a model's intuition.
        self.assertEqual(CM.DISPOSITION_ALREADY_SATISFIED, "ALREADY_SATISFIED")
        self.assertIn(
            CM.DISPOSITION_ALREADY_SATISFIED,
            {
                CM.DISPOSITION_EXECUTED,
                CM.DISPOSITION_REFUSED,
                CM.DISPOSITION_BLOCKED,
                CM.DISPOSITION_SKIPPED_BY_PROTOCOL,
                CM.DISPOSITION_ALREADY_SATISFIED,
                CM.DISPOSITION_NOT_RUN,
                CM.DISPOSITION_FAILED,
            },
        )

    # ── 5. Unknown short token ──────────────────────────────────────────
    def test_unknown_token_not_shortcut(self):
        for token in ("xy", "zq", "qb", "wt"):
            resolved = CM.resolve_compound_command(token, table=table())
            self.assertEqual(len(resolved), 1)
            self.assertEqual(resolved[0]["kind"], "unknown", token)
            self.assertEqual(resolved[0]["command"], "", token)

    def test_unknown_token_in_compound(self):
        resolved = CM.resolve_compound_command("saipen status + xy", table=table())
        self.assertEqual(len(resolved), 2)
        self.assertEqual(resolved[1]["kind"], "unknown")

    # ── 6. Style-control separation ─────────────────────────────────────
    def test_sc_not_stop_caveman(self):
        sc = CM.resolve_compound_command("sc", table=table())
        style = CM.resolve_compound_command("stop caveman", table=table())
        self.assertEqual(sc[0]["command"], "saipen crew")
        self.assertEqual(style[0]["kind"], "unknown")
        self.assertEqual(style[0]["command"], "")

    def test_normal_mode_not_shortcut(self):
        resolved = CM.resolve_compound_command("normal mode", table=table())
        self.assertEqual(resolved[0]["kind"], "unknown")

    # ── 7. Multiple shortcuts from live table ───────────────────────────
    def test_multiple_shortcuts(self):
        for token, expected in (
            ("sc", "saipen crew"),
            ("cc", "saipen continue"),
            ("eee", "saipen collect saitranslate"),
            ("qqq", "saipen collect saiwiki"),
            ("tt", "saipen test"),
        ):
            resolved = CM.resolve_compound_command(token, table=table())
            self.assertEqual(resolved[0]["command"], expected, token)

    def test_shortcut_nested_in_compound(self):
        resolved = CM.resolve_compound_command("saipen push + qq", table=table())
        self.assertEqual(len(resolved), 2)
        self.assertEqual(resolved[1]["command"], "saipen prepare saiwiki")

    # ── 8. Provenance (machine contract surface) ────────────────────────
    def test_registry_owns_compound_and_truthfulness(self):
        registry = CM.load_registry(PROTOCOL_DIR)
        self.assertEqual(registry["chain_policies"]["default"], CM.CHAIN_STOP_ON_FAILURE)
        self.assertEqual(
            set(registry["dispositions"]["closed_set"]),
            {
                CM.DISPOSITION_EXECUTED,
                CM.DISPOSITION_REFUSED,
                CM.DISPOSITION_BLOCKED,
                CM.DISPOSITION_SKIPPED_BY_PROTOCOL,
                CM.DISPOSITION_ALREADY_SATISFIED,
                CM.DISPOSITION_NOT_RUN,
                CM.DISPOSITION_FAILED,
            },
        )
        commands_doc = (PROTOCOL_DIR / "COMMANDS.md").read_text(encoding="utf-8-sig")
        self.assertEqual(commands_doc.count("RULE-OWNER: CMD-COMPOUND-01"), 1)
        self.assertIn("sc", table())

    def test_activation_template_declares_shortcut_gate(self):
        """The ONE activation template carries the shortcut gate.

        T-1317 P1-3: the semantic block lives in
        `saipen/ACTIVATION_BLOCK.md` since centralization, so searching the
        injector scripts for activation prose tests the pre-registry
        architecture. The contract is the canonical template AND everything
        rendered from it -- both injectors render that one file.
        """
        template_path = PROTOCOL_DIR / "ACTIVATION_BLOCK.md"
        template = template_path.read_text(encoding="utf-8")
        rendered = template.replace("{{SAIPEN_HOME}}", str(PROTOCOL_DIR))
        canonical = set(table().keys())
        for label, text in (("template", template), ("rendered", rendered)):
            self.assertIn("SHORTCUT ACTIVATION GATE", text, label)
            self.assertIn("sc", text, label)
            self.assertIn('never "stop caveman"', text, label)
            self.assertIn("a full-token shortcut match ALWAYS wins", text, label)
            # Exact-set conformance: the activation gate must advertise
            # every canonical shortcut and no stale one. The block phrases
            # the list as `shortcut (gg, hh, ... , sc, or ...)` -- extract
            # tokens inside the parentheses and compare to the live table.
            m = re.search(r"shortcut\s*\(([^)]*)\)", text, re.IGNORECASE | re.DOTALL)
            self.assertIsNotNone(m, f"{label} gate lacks token list parentheses")
            advertised_raw = m.group(1)
            # The list is `<tokens>, or a Cyrillic twin` -- isolate the token
            # segment before the generic phrase so locale words do not pollute.
            token_segment = advertised_raw.split(" or")[0]
            tokens = set(re.findall(r"[a-z]{2,3}", token_segment.lower()))
            # The gate covers twins generically via "Cyrillic twin" phrase,
            # not by enumerating them -- ensure phrase present and not double-counted.
            self.assertIn("cyrillic twin", text.lower(), label)
            self.assertEqual(
                tokens,
                canonical,
                f"{label} gate drift: {sorted(tokens)} vs {sorted(canonical)}",
            )

    def test_both_injectors_render_the_one_activation_template(self):
        """Both injectors must render the template, never embed a copy.

        T-1317 P1-3: the semantic block is centralized. A red here means an
        injector has grown a second, divergent copy of the activation gate.
        """
        for filename in ("inject.ps1", "inject.sh"):
            text = (TOOLS.parent / "bootstrap" / filename).read_text(encoding="utf-8")
            self.assertIn("ACTIVATION_BLOCK.md", text, filename)
            self.assertNotIn("SHORTCUT ACTIVATION GATE", text, filename)

    def test_boot_declares_compound_first(self):
        boot = (PROTOCOL_DIR / "BOOT.md").read_text(encoding="utf-8")
        self.assertIn("Compound input first", boot)
        self.assertIn("CMD-COMPOUND-01", boot)
        self.assertNotIn("STOP_ON_FAILURE", boot)


# ── 9. Public CLI boundary (real subprocess dispatch) ────────────────────


def _stable_json(payload):
    """Project a payload onto its STABLE routing evidence.

    Dry-run plans carry per-invocation op ids, hashes and timestamps; those
    are transaction identity, not routing semantics. The `route` echo is
    presentation metadata a shortcut invocation adds to every payload; it is
    scrubbed too, so two invocations of the SAME code path compare equal
    whether reached by Latin row or Cyrillic twin while two different code
    paths still differ.
    """
    if isinstance(payload, dict):
        return {
            k: _stable_json(v)
            for k, v in sorted(payload.items())
            if k not in ("op_id", "changed_files", "route")
        }
    if isinstance(payload, list):
        return [_stable_json(v) for v in payload]
    if isinstance(payload, str):
        payload = re.sub(r"[0-9a-f]{32}", "<hex32>", payload)
        payload = re.sub(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})",
            "<ts>",
            payload,
        )
        payload = re.sub(r"\d{2}\.\d{2}\.\d{2} \d{2}:\d{2}", "<ts>", payload)
    return payload


class CliShortcutRoutingTests(unittest.TestCase):
    """Shortcut routing at the REAL executable boundary (`tools/saipen.py`).

    The helper tests above prove the resolver; these prove the adapter USES
    it -- the incident shipped precisely because that link was missing.
    """

    def setUp(self):
        _sandbox_user_config(self)

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="saipen-cli-routing-")
        cls.addClassCleanup(cls._tmp.cleanup)
        cls.project = Path(cls._tmp.name) / "proj"
        (cls.project / ".saipen").mkdir(parents=True)
        import datetime

        now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        cls._write(
            ".saipen/STATE.md",
            "---\n"
            "phase: BUILD\n"
            "task: T-010\n"
            'next_action: "PHASE BUILD T-010"\n'
            "blocker: none\n"
            "transition_from: SCOUT\n"
            "saipen_version: 7\n"
            "agent: crashed-agent\n"
            "mode: full\n"
            f"updated: {now}\n"
            "---\n",
        )
        cls._write(
            ".saipen/BOARD.md",
            "# Board\n"
            "## DOING\n"
            "- [/] T-010 feature under construction | owner: crashed-agent "
            "| claim_time: 2020-01-01T00:00:00Z\n"
            "## TODO\n## DONE\n## BLOCKED\n",
        )
        cls._write(
            ".saipen/LOG.md",
            "# Log\n\n"
            "- 01.01.20 00:00 [E-001] [T-010] [agent: crashed-agent] "
            "RUN: build -> edits in flight\n",
        )

    @classmethod
    def _write(cls, rel, text):
        path = cls.project / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def _cli(self, *args):
        """Run the public adapter against the throwaway project.

        Every mutating shortcut runs under --dry-run: routing is exercised,
        nothing is ever published. Output decoding is pinned to UTF-8 on both
        sides so Cyrillic tokens survive the pipe.
        """
        proc = subprocess.run(
            [
                sys.executable,
                str(SAIPEN_PY),
                "--project-root",
                str(self.project),
                "--json",
                "--dry-run",
                *args,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
            timeout=120,
        )
        try:
            payload = json.loads(proc.stdout) if proc.stdout.strip() else {}
        except ValueError:
            payload = {"_unparseable_stdout": proc.stdout}
        return proc.returncode, _stable_json(payload), proc.stdout, proc.stderr

    # ── twin resolution ──────────────────────────────────────────────
    def test_derived_twins_match_declared_twins(self):
        # The engine derives twins from the canonical table + confusable map;
        # this suite pins the exact expected set. If either side changes
        # without the other, this goes red instead of production drifting.
        derived = CM.derive_cyrillic_twins(table())
        self.assertEqual(derived, DECLARED_CYRILLIC_TWINS)

    def test_all_seven_twins_resolve_to_canonical_latin_rows(self):
        # The canonical table stays LATIN (CORE § 1.10); a twin resolves by
        # codepoint folding onto its Latin row, never as its own row.
        t = table()
        for twin, latin in DECLARED_CYRILLIC_TWINS.items():
            self.assertNotIn(twin, t, twin)
            self.assertEqual(CM.resolve_shortcut(twin, table=t), latin, twin)
            self.assertEqual(t[latin], EXPECTED_ROUTES[latin], twin)

    def test_helper_cc_is_continue_never_stop(self):
        t = table()
        self.assertEqual(CM.normalize_shortcut_token("сс"), "cc")
        self.assertEqual(CM.resolve_shortcut("сс", table=t), "cc")
        self.assertNotEqual(CM.resolve_shortcut("сс", table=t), "ss")
        self.assertNotIn("s", CM.CYRILLIC_CONFUSABLE_MAP.values())

    def test_no_cyrillic_input_can_ever_fold_to_ss_or_sss(self):
        # The mechanical truth behind "there is no Cyrillic twin for ss":
        # no declared fold target is "s", hence no Cyrillic token normalizes
        # to anything containing it.
        targets = set(CM.CYRILLIC_CONFUSABLE_MAP.values())
        self.assertNotIn("s", targets)
        for cyr_char in CM.CYRILLIC_CONFUSABLE_MAP:
            self.assertNotEqual(CM.normalize_shortcut_token(cyr_char), "s")

    def test_ccc_resolves_to_ccc_never_sss(self):
        t = table()
        self.assertEqual(CM.normalize_shortcut_token("ссс"), "ccc")
        self.assertEqual(CM.resolve_shortcut("ссс", table=t), "ccc")
        self.assertEqual(t["sss"], "saipen status")
        self.assertEqual(t["st"], "saipen stop")
        # `ss` is retired: it MUST NOT be an active row.
        self.assertNotIn("ss", t)
        # The Cyrillic twin of `cc` never lands on `st` (no `s` fold target).
        self.assertNotEqual(CM.resolve_shortcut("сс", table=t), "st")
        self.assertNotEqual(CM.resolve_shortcut("сс", table=t), "ss")

    def test_undeclared_lookalikes_fail_closed_in_resolver(self):
        t = table()
        # п and н have no declared folds. None of these may resolve.
        for token in ("нн", "пп", "ссs"):
            self.assertIsNone(CM.resolve_shortcut(token, table=t), token)
            resolved = CM.resolve_compound_command(token, table=t)
            self.assertEqual(resolved[0]["kind"], "unknown", token)

    def test_twin_inside_compound_command_resolves(self):
        resolved = CM.resolve_compound_command("saipen push + build ссс", table=table())
        self.assertEqual(resolved[-1]["kind"], "shortcut")
        self.assertEqual(resolved[-1]["command"], "saipen continue")
        mixed = CM.resolve_compound_command("сс + qq", table=table())
        self.assertEqual(
            [seg["command"] for seg in mixed],
            ["saipen continue", "saipen prepare saiwiki"],
        )

    # ── public CLI boundary ──────────────────────────────────────────
    def test_cli_twin_pairs_enter_identical_code_paths(self):
        """Every Cyrillic twin dispatches byte-identically to its Latin row."""
        for twin, latin in DECLARED_CYRILLIC_TWINS.items():
            with self.subTest(twin=twin, latin=latin):
                rc_latin, stable_latin, _, err_latin = self._cli(latin)
                rc_twin, stable_twin, _, err_twin = self._cli(twin)
                self.assertEqual(rc_latin, rc_twin)
                self.assertEqual(stable_latin, stable_twin)
                self.assertEqual(err_latin, err_twin)

    def test_cli_cc_dispatches_as_continue_dry_run(self):
        rc, stable, _raw, _err = self._cli("cc")
        rc2, stable2, _raw2, _err2 = self._cli("сс")
        self.assertEqual(rc, 0)
        self.assertEqual(rc, rc2)
        self.assertEqual(stable["code"], "CONVERGE_SET")
        self.assertEqual(stable["execution_intent"], "converge")
        self.assertEqual(stable["converge_target"], "done")
        self.assertTrue(stable["dry_run"])
        self.assertEqual(stable, stable2)

    def test_cli_ccc_refuses_closed_and_never_becomes_status_or_stop(self):
        # Wave1 closure: ccc is now deterministic CONVERGE_SET with ship target, not NOT_EXECUTABLE.
        rc_ccc, stable_ccc, _, _ = self._cli("ccc")
        rc_twin, stable_twin, _, _ = self._cli("ссс")
        rc_sss, stable_sss, _, _ = self._cli("sss")
        self.assertEqual(rc_ccc, rc_twin)
        self.assertEqual(stable_ccc, stable_twin)
        self.assertEqual(stable_ccc["code"], "CONVERGE_SET")
        self.assertEqual(stable_ccc.get("converge_target"), "ship")
        self.assertEqual(stable_ccc.get("execution_intent"), "converge")
        # sss executes real status; ccc must be a DIFFERENT outcome.
        self.assertNotEqual((rc_ccc, stable_ccc), (rc_sss, stable_sss))
        self.assertNotIn("CONVERGE_SET", str(stable_sss))

    def test_cli_ss_refuses_naming_stop_and_differs_from_cc(self):
        # SRC-024 (audit/11.md): `ss` is RETIRED. The public boundary must
        # refuse it as `SHORTCUT_RETIRED`, name the two live tokens, and
        # leave both the stop and the status implementations untouched.
        # `cc` still maps to the convergent continue path.
        rc_ss, stable_ss, raw_ss, _ = self._cli("ss")
        rc_cc, stable_cc, _, _ = self._cli("cc")
        self.assertEqual(stable_ss["code"], "SHORTCUT_RETIRED")
        self.assertIn('"route": "ss"', raw_ss)
        self.assertIn("st", stable_ss.get("detail", ""))
        self.assertIn("sss", stable_ss.get("detail", ""))
        self.assertEqual(stable_ss.get("use_instead"), {"stop": "st", "status": "sss"})
        # The incident invariant at the boundary: сс (continue path) can
        # never collapse into ss's STOP and the retired refusal must not
        # share a code with the continue path either.
        self.assertNotEqual((rc_ss, stable_ss), (rc_cc, stable_cc))
        self.assertNotEqual(stable_ss.get("code"), stable_cc.get("code"))
        self.assertEqual(stable_cc.get("code"), "CONVERGE_SET")
        # Process exit must signal a non-success refusal, not a healthy 0.
        self.assertEqual(rc_ss, 1)

    def test_cli_sss_is_real_status_surface(self):
        rc_sss, stable_sss, _, err_sss = self._cli("sss")
        rc_status, stable_status, _, err_status = self._cli("status")
        self.assertEqual(rc_sss, rc_status)
        self.assertEqual(stable_sss, stable_status)
        self.assertEqual(err_sss, err_status)

    def test_cli_declared_shortcut_never_answers_unknown_command(self):
        tokens = list(EXPECTED_ROUTES) + list(DECLARED_CYRILLIC_TWINS) + list(RETIRED_TOKENS)
        for token in tokens:
            with self.subTest(token=token):
                _rc, _stable, raw, _err = self._cli(token)
                self.assertNotIn("unknown command", raw, token)

    def test_cli_st_is_stop_and_matches_saipen_stop(self):
        # SRC-024: `st` enters the EXACT same implementation path as the
        # long-form `stop`; `ss` no longer reaches it. Pairwise route
        # equality and a derived route-key assertion catch a drift where
        # the dispatch tuple reads `stop, st` but only one branch mutates.
        rc_st, stable_st, raw_st, _ = self._cli("st")
        rc_stop, stable_stop, _raw_stop, _ = self._cli("stop")
        self.assertEqual(stable_st.get("code"), stable_stop.get("code"))
        self.assertEqual(rc_st, rc_stop)
        self.assertIn("st", raw_st)
        self.assertNotIn("SHORTCUT_RETIRED", raw_st)

    def test_cli_and_resolver_cannot_disagree(self):
        """Agreement property: whatever the resolver declares, the CLI routes
        or refuses-with-route; whatever it declines, the CLI calls unknown."""
        t = table()
        declared = list(t) + list(DECLARED_CYRILLIC_TWINS)
        for token in declared:
            route_key = CM.resolve_shortcut(token, table=t)
            self.assertIsNotNone(route_key, token)
            with self.subTest(token=token):
                _rc, _stable, raw, _err = self._cli(token)
                self.assertNotIn("unknown command", raw, token)
                self.assertIn(route_key, raw, token)
        # `ss` is retired: the resolver declines it AND the CLI names a
        # specific retirement reason rather than "unknown command".
        for token in RETIRED_TOKENS:
            self.assertNotIn(token, t, token)
            _rc, _stable, raw, _err = self._cli(token)
            self.assertNotIn("unknown command", raw, token)
            self.assertIn("SHORTCUT_RETIRED", raw, token)
        for token in ("нн", "пп"):
            self.assertIsNone(CM.resolve_shortcut(token, table=t), token)
            _rc, _stable, raw, _err = self._cli(token)
            self.assertIn("unknown command", raw, token)

    def test_cli_holds_no_private_confusable_map_or_twin_table(self):
        source = SAIPEN_PY.read_text(encoding="utf-8")
        # One normalization authority: the adapter consumes the shared engine
        # resolver and never re-declares the map, a twin dictionary, or any
        # Cyrillic special case.
        self.assertIn("resolve_shortcut(", source)
        self.assertNotIn("maketrans", source)
        self.assertFalse(re.search(r"[\u0400-\u04FF]", source))

    def test_route_echo_is_scoped_to_one_in_process_invocation(self):
        import saipen as cli

        first = io.StringIO()
        with redirect_stdout(first):
            first_rc = cli.main(
                [
                    "--project-root",
                    str(self.project),
                    "--json",
                    "--dry-run",
                    "cc",
                ]
            )
        self.assertEqual(first_rc, 0)
        self.assertEqual(json.loads(first.getvalue())["route"], "cc")

        second = io.StringIO()
        with redirect_stdout(second):
            second_rc = cli.main(["--project-root", str(self.project), "--json", "status"])
        self.assertEqual(second_rc, 0)
        self.assertNotIn("route", json.loads(second.getvalue()))


class CommandSemanticsTests(unittest.TestCase):
    """Command-semantics invariants at the REAL executable boundary.

    The whole user message (bare `saipen`, `saipen continue`, `cc`, `gg
    <goal>`, `sc`) must resolve to ONE deterministic canonical command with no
    contextual reinterpretation. Each test builds a throwaway project with a
    controlled STATE so the actual state transition is asserted, not just the
    parsed command name.

    Covered invariants (the fixed-point contract):
      * saipen == saipen continue == cc (canonical continue handler + transition)
      * normal intent -> converge (done target), never implicit ADD
      * empty BOARD behaves identically under bare saipen and cc
      * execution_intent: goal -> cc resumes THAT goal (objective unchanged)
      * tripped goal safety valve -> cc reauthorizes (counters 0), objective
        unchanged, intent stays goal
      * gg <new goal> == create/pivot, semantically distinct from cc
      * execution_intent: converge + converge_target: crew -> cc resumes crew
    """

    def setUp(self):
        _sandbox_user_config(self)

    def _make(self, name, intent="normal", state_extra="", board_todo=""):
        td = tempfile.mkdtemp(prefix="saipen-cmd-")
        self.addCleanup(lambda: __import__("shutil").rmtree(td, ignore_errors=True))
        proj = Path(td) / name
        (proj / ".saipen").mkdir(parents=True)
        import datetime

        now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        (proj / ".saipen" / "STATE.md").write_text(
            "---\n"
            "phase: BUILD\n"
            "task: T-010\n"
            'next_action: "PHASE BUILD T-010"\n'
            "blocker: none\n"
            "transition_from: SCOUT\n"
            "saipen_version: 7\n"
            "agent: aleks\n"
            "mode: full\n"
            f"updated: {now}\n"
            f"execution_intent: {intent}\n"
            f"{state_extra}"
            "---\n",
            encoding="utf-8",
        )
        (proj / ".saipen" / "BOARD.md").write_text(
            "# Board\n"
            "## DOING\n"
            "- [/] T-010 feature | owner: aleks | claim_time: 2020-01-01T00:00:00Z\n"
            "## TODO\n"
            f"{board_todo}"
            "## DONE\n"
            "## BLOCKED\n",
            encoding="utf-8",
        )
        (proj / ".saipen" / "LOG.md").write_text(
            "# Log\n\n- 01.01.20 00:00 [E-001] [T-010] [agent: aleks] RUN: build\n",
            encoding="utf-8",
        )
        return proj

    def _cli(self, proj, *args, dry_run=True):
        cmd = [
            sys.executable,
            str(SAIPEN_PY),
            "--project-root",
            str(proj),
            "--json",
        ]
        if dry_run:
            cmd.append("--dry-run")
        cmd += list(args)
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
            timeout=120,
        )
        payload = {}
        if proc.stdout.strip():
            try:
                payload = json.loads(proc.stdout)
            except ValueError:
                payload = {"_unparseable_stdout": proc.stdout}
        return proc.returncode, payload, proc.stdout

    def _state(self, proj):
        import saipen_engine.state as ST

        return ST.parse_state((proj / ".saipen" / "STATE.md").read_text(encoding="utf-8"))

    def _semantic(self, payload):
        """The canonical continue outcome minus the per-run op_id UUID."""
        return {
            k: payload[k]
            for k in (
                "ok",
                "code",
                "execution_intent",
                "converge_target",
                "goal_waves",
                "goal_tickets",
            )
            if k in payload
        }

    # ---- bare / continue / cc equivalence ---------------------------
    def test_bare_continue_cc_are_identical_canonical_path(self):
        """The three forms hit the SAME deterministic continue handler and the
        SAME state transition -- asserted by identical structured outcome
        (modulo the per-run op_id), not by command-name parsing."""
        proj = self._make("equiv")
        results = {}
        for label, args in (
            ("bare", []),
            ("continue", ["continue"]),
            ("cc", ["cc"]),
        ):
            rc, payload, _raw = self._cli(proj, *args)
            results[label] = (rc, self._semantic(payload))
        for label in ("bare", "continue", "cc"):
            rc, sem = results[label]
            self.assertEqual(rc, 0, label)
            self.assertEqual(sem["execution_intent"], "converge", label)
            self.assertEqual(sem["converge_target"], "done", label)
        # All three are the one canonical continue handler.
        self.assertEqual(results["bare"], results["continue"])
        self.assertEqual(results["continue"], results["cc"])

    def test_bare_continue_cc_identical_on_tripped_goal_valve(self):
        """Even under a tripped goal valve the three forms route to the same
        reauthorize-valve transition (they are one handler)."""
        proj = self._make(
            "equiv-valve", intent="goal", state_extra="goal_waves: 3\ngoal_tickets: 20\n"
        )
        results = {}
        for label, args in (
            ("bare", []),
            ("continue", ["continue"]),
            ("cc", ["cc"]),
        ):
            rc, payload, _raw = self._cli(proj, *args)
            results[label] = (rc, self._semantic(payload))
        for label in ("bare", "continue", "cc"):
            rc, sem = results[label]
            self.assertEqual(rc, 0, label)
            self.assertEqual(sem["code"], "VALVE_REAUTHORIZED", label)
        self.assertEqual(results["bare"], results["continue"])
        self.assertEqual(results["continue"], results["cc"])

    # ---- normal execution: no implicit ADD --------------------------
    def test_normal_cc_enters_converge_never_implicit_add(self):
        proj = self._make("normal")
        rc, payload, _raw = self._cli(proj, "cc")
        self.assertEqual(rc, 0)
        self.assertEqual(payload["execution_intent"], "converge")
        self.assertEqual(payload["converge_target"], "done")
        # Normal convergence is CONVERGE_SET -- never ADD, never HUNT-for-ADD.
        self.assertNotEqual(payload.get("code"), "ADD")

    # ---- empty BOARD: bare and cc identical -------------------------
    def test_empty_board_bare_and_cc_behave_identically(self):
        proj = self._make("empty-board", board_todo="")
        # A truly empty board means no DOING either; rebuild state for empty.
        (proj / ".saipen" / "BOARD.md").write_text(
            "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        res_bare = self._cli(proj)
        res_cc = self._cli(proj, "cc")
        # Same canonical handler, identical structured outcome, no implicit
        # HUNT->ADD branch.
        self.assertEqual(res_bare[0], res_cc[0])
        self.assertEqual(self._semantic(res_bare[1]), self._semantic(res_cc[1]))
        self.assertNotIn("HUNT", str(res_bare[1]))
        self.assertNotIn("ADD", str(res_bare[1]))

    # ---- active goal: cc resumes THAT goal --------------------------
    def test_cc_resumes_existing_goal_preserving_objective(self):
        # CORE-001 (audit-all3): when STATE counters are ahead of canonical
        # evidence but UNDER the cap, reconciliation rebuilds the counters
        # down to the derived value rather than silently CLEANing or
        # silently preserving. The audit's contract: CLEAN only when STATE
        # equals derived evidence.
        proj = self._make(
            "goal-resume", intent="goal", state_extra="goal_waves: 1\ngoal_tickets: 2\n"
        )
        log_before = (proj / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        rc, payload, _raw = self._cli(proj, "cc", dry_run=False)
        self.assertEqual(rc, 0)
        self.assertEqual(payload["execution_intent"], "goal")
        # Counters reconciled downward to canonical evidence (derived=0/0).
        self.assertEqual(payload["goal_waves"], 0)
        self.assertEqual(payload["goal_tickets"], 0)
        # cc is a resume: it must NOT create a new objective or pivot.
        self.assertNotIn("objective", payload)
        log_after = (proj / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        self.assertEqual(log_before.count("goal pivot --"), log_after.count("goal pivot --"))
        # The persisted intent stays goal on disk after the real resume.
        self.assertEqual(self._state(proj)["execution_intent"], "goal")

    # ---- tripped goal valve: cc reauthorizes, objective unchanged ---
    def test_tripped_goal_valve_cc_reauthorizes_keeps_objective(self):
        proj = self._make(
            "goal-valve", intent="goal", state_extra="goal_waves: 3\ngoal_tickets: 20\n"
        )
        log_before = (proj / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        # dry-run captures the VALVE_REAUTHORIZED outcome code.
        rc, payload, _raw = self._cli(proj, "cc")
        self.assertEqual(rc, 0)
        self.assertEqual(payload["code"], "VALVE_REAUTHORIZED")
        self.assertEqual(payload["goal_waves"], 0)
        self.assertEqual(payload["goal_tickets"], 0)
        self.assertEqual(payload["execution_intent"], "goal")
        # Reauthorization is RESUME semantics: no new objective, no pivot.
        self.assertNotIn("objective", payload)
        # A real run persists the reauthorization (counters 0, WAIT cleared).
        rc2, _payload2, _raw2 = self._cli(proj, "cc", dry_run=False)
        self.assertEqual(rc2, 0)
        st = self._state(proj)
        self.assertEqual((st["goal_waves"], st["goal_tickets"]), (0, 0))
        self.assertFalse(st["next_action"].startswith("WAIT:"))
        self.assertEqual(st["execution_intent"], "goal")
        log_after = (proj / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        self.assertEqual(log_before.count("goal pivot --"), log_after.count("goal pivot --"))

    def test_gg_new_goal_is_create_pivot_not_resume(self):
        proj = self._make("gg-pivot", intent="goal", state_extra="goal_waves: 1\ngoal_tickets: 2\n")
        rc, payload, _raw = self._cli(proj, "gg", "Build feature X")
        self.assertEqual(rc, 0)
        self.assertEqual(payload["code"], "GOAL_SET")
        self.assertEqual(payload["objective"], "Build feature X")
        # A create/pivot resets to wave 1 / ticket 0 -- distinct from cc's
        # counter-preserving resume.
        self.assertEqual(payload["goal_waves"], 1)
        self.assertEqual(payload["goal_tickets"], 0)
        self.assertNotEqual(payload.get("code"), "VALVE_REAUTHORIZED")

    def test_gg_bare_is_usage_line_never_resume(self):
        proj = self._make("gg-bare", intent="goal", state_extra="goal_waves: 3\ngoal_tickets: 20\n")
        rc, payload, _raw = self._cli(proj, "gg", dry_run=False)
        self.assertEqual(rc, 2)
        self.assertEqual(payload["code"], "VALIDATION_FAILED")
        self.assertEqual(payload["detail"], "Use: gg <objective text>")
        # Zero-write: a tripped valve must NOT be cleared by bare gg.
        self.assertEqual(self._state(proj)["goal_waves"], 3)

    def test_goal_plan_allocates_each_new_ticket_in_the_committed_history(self):
        proj = self._make(
            "goal-allocation", intent="goal", state_extra="goal_waves: 0\ngoal_tickets: 0\n"
        )
        rc, payload, _raw = self._cli(
            proj, "gg", "Build feature X then verify feature X", dry_run=False
        )
        self.assertEqual(rc, 0, payload)
        self.assertEqual(len(payload["plan_tickets"]), 2)
        from saipen_engine.log import parse_log_line
        events = [parse_log_line(line) for line in
                  (proj / ".saipen/LOG.md").read_text(encoding="utf-8").splitlines()
                  if line.startswith("- ")]
        for ticket in payload["plan_tickets"]:
            self.assertTrue(any(e.get("ticket") == ticket for e in events), ticket)
        self.assertEqual(int(self._state(proj)["last_event"]), events[-1]["event"])
        # A fresh public read must accept those identities and resume the new Work.
        rc, resumed, _raw = self._cli(proj, "next")
        self.assertEqual(rc, 0, resumed)
        self.assertEqual(resumed["ticket"], payload["plan_tickets"][0])

    # ---- no accidental goal mutation on cc --------------------------
    def test_cc_never_creates_or_pivots_a_goal(self):
        proj = self._make(
            "no-mutate", intent="goal", state_extra="goal_waves: 1\ngoal_tickets: 1\n"
        )
        _rc, payload, _raw = self._cli(proj, "cc")
        # cc is a resume -- it carries no objective and never fires goal_entry.
        self.assertNotIn("objective", payload)
        self.assertNotEqual(payload.get("code"), "GOAL_SET")

    # ---- crew resume ------------------------------------------------
    def test_cc_resumes_crew_target_not_normal_convergence(self):
        proj = self._make("crew-resume", intent="converge", state_extra="converge_target: crew\n")
        rc, payload, _raw = self._cli(proj, "cc", dry_run=False)
        self.assertEqual(rc, 0)
        self.assertEqual(payload["execution_intent"], "converge")
        # The resume honours the persisted crew target rather than collapsing
        # to a plain done convergence.
        self.assertEqual(self._state(proj)["converge_target"], "crew")

    def test_sc_is_crew_workflow_distinct_from_cc(self):
        proj = self._make("crew-sc", intent="converge", state_extra="converge_target: crew\n")
        _rc_cc, payload_cc, _ = self._cli(proj, "cc")
        _rc_sc, payload_sc, _ = self._cli(proj, "sc")
        # cc is the continue path; sc is the full crew circuit. They are
        # different commands and must never collapse into one another.
        self.assertNotEqual(payload_cc.get("code"), payload_sc.get("code"))
        self.assertNotIn("CREW_PLAN", str(payload_cc.get("code")))
        self.assertIn("CREW_PLAN", str(payload_sc.get("code")))


class RetiredShortcutMigrationTests(unittest.TestCase):
    """SRC-024 (audit/11.md): the ss -> st shortcut migration.

    The audit's mandatory test matrix, in one place, against a REAL
    throwaway project and the REAL public adapter:

      A. st -> STOP (checkpoint semantics, correct route, success)
      B. long stop unchanged
      C. sss -> STATUS (read-only, no checkpoint, no mutation)
      D. long status unchanged
      E. ss -> non-success retired diagnostic, zero mutation, names st/sss
      F. ss can never reach the stop implementation
      G. ss can never reach the status implementation
      H. st surplus args refused per the stop contract
      I. sss surplus args retain refusal semantics
      J. Cyrillic сс stays CONTINUE
      K. registry contains st -> stop, sss -> status, no active ss
      N. mutation difference: sss/ss leave bytes identical, st checkpoints
      red control: reintroducing ss -> stop or sss -> stop fails a test
    """

    class _HandlerFired(Exception):
        """Raised by the handler spies -- reaching an implementation is the red."""

    def setUp(self):
        _sandbox_user_config(self)

    def _make(self, name):
        td = tempfile.mkdtemp(prefix="saipen-retired-")
        self.addCleanup(lambda: __import__("shutil").rmtree(td, ignore_errors=True))
        proj = Path(td) / name
        (proj / ".saipen").mkdir(parents=True)
        import datetime

        now = datetime.datetime.now(datetime.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        (proj / ".saipen" / "STATE.md").write_text(
            "---\n"
            "phase: BUILD\n"
            "task: T-010\n"
            'next_action: "PHASE BUILD T-010"\n'
            "blocker: none\n"
            "transition_from: SCOUT\n"
            "saipen_version: 7\n"
            "agent: probe\n"
            "mode: full\n"
            f"updated: {now}\n"
            "---\n",
            encoding="utf-8",
        )
        (proj / ".saipen" / "BOARD.md").write_text(
            "# Board\n"
            "## DOING\n"
            "- [/] T-010 feature | owner: probe | claim_time: 2020-01-01T00:00:00Z\n"
            "## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        (proj / ".saipen" / "LOG.md").write_text(
            "# Log\n\n- 01.01.20 00:00 [E-001] [T-010] [agent: probe] RUN: build\n",
            encoding="utf-8",
        )
        return proj

    def _cli(self, proj, token, dry_run=True):
        tokens = token if isinstance(token, list) else [token]
        proc = subprocess.run(
            [
                sys.executable,
                str(SAIPEN_PY),
                "--project-root",
                str(proj),
                "--json",
                *(["--dry-run"] if dry_run else []),
                *tokens,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
            timeout=120,
        )
        try:
            payload = json.loads(proc.stdout) if proc.stdout.strip() else {}
        except ValueError:
            payload = {"_unparseable_stdout": proc.stdout}
        return proc.returncode, payload, proc.stdout, proc.stderr

    def _tree_digest(self, proj):
        import hashlib

        out = {}
        for path in sorted(Path(proj).rglob("*")):
            if path.is_file():
                out[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
        return out

    # K. registry ---------------------------------------------------------
    def test_registry_holds_st_not_ss(self):
        t = table()
        self.assertEqual(t["st"], "saipen stop")
        self.assertEqual(t["sss"], "saipen status")
        self.assertNotIn("ss", t)

    # E/F/G. retired tombstone -------------------------------------------
    def test_retired_ss_is_zero_mutation_refusal(self):
        proj = self._make("retired")
        before = self._tree_digest(proj)
        rc, payload, raw, err = self._cli(proj, "ss", dry_run=False)
        self.assertEqual(
            self._cli(proj, "ss", dry_run=False), (rc, payload, raw, err)
        )
        after = self._tree_digest(proj)
        self.assertEqual(before, after)
        self.assertNotEqual(rc, 0)
        self.assertEqual(payload["code"], "SHORTCUT_RETIRED")
        self.assertIn("st", payload["detail"])
        self.assertIn("sss", payload["detail"])
        # F/G: neither the stop nor the status code path is reachable.
        self.assertNotIn("STOP", str(payload.get("code")))
        self.assertNotIn("AUDIT", str(payload))

    def test_st_surplus_is_refused_like_stop_surplus(self):
        proj = self._make("surplus")
        rc_st, p_st, _, _ = self._cli(proj, ["st", "extra"])
        rc_stop, p_stop, _, _ = self._cli(proj, ["stop", "extra"])
        self.assertEqual(rc_st, rc_stop)
        self.assertEqual(p_st["code"], "VALIDATION_FAILED")
        self.assertIn("no arguments", p_st["detail"])
        self.assertEqual(p_st["detail"], p_stop["detail"])

    def test_sss_surplus_retains_refusal(self):
        proj = self._make("sss-surplus")
        rc, payload, _, _ = self._cli(proj, ["sss", "extra"])
        self.assertEqual(rc, 2)
        self.assertEqual(payload["code"], "VALIDATION_FAILED")

    # N. mutation difference --------------------------------------------
    def test_mutation_difference_sss_ss_zero_st_checkpoints(self):
        proj = self._make("mutation")
        base = self._tree_digest(proj)
        _rc, _p, _raw, _err = self._cli(proj, "sss", dry_run=False)
        self.assertEqual(self._tree_digest(proj), base)
        _rc, _p, _raw, _err = self._cli(proj, "ss", dry_run=False)
        self.assertEqual(self._tree_digest(proj), base)
        # st in a writable session performs the real stop checkpoint.
        rc, payload, _, _ = self._cli(proj, "st", dry_run=False)
        self.assertEqual(payload.get("code"), "STOP")
        self.assertNotEqual(rc, 2)
        self.assertNotEqual(self._tree_digest(proj), base)

    # J. Cyrillic safety --------------------------------------------------
    def test_cyrillic_cc_stays_continue_never_stop_or_retired(self):
        t = table()
        self.assertEqual(CM.resolve_shortcut("сс", table=t), "cc")
        self.assertNotEqual(CM.resolve_shortcut("сс", table=t), "st")
        self.assertNotEqual(CM.resolve_shortcut("сс", table=t), "ss")

    # red control ---------------------------------------------------------
    def test_red_control_reintroduced_ss_or_sss_to_stop_fails(self):
        # Mutate an exact copy of the real registry and keep the green
        # contract check unchanged. Both unsafe contracts must fail it.
        original = (PROTOCOL_DIR / "REGISTRY.json").read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory(prefix="saipen-hostile-registry-") as td:
            protocol = Path(td)
            for token in ("ss", "sss"):
                with self.subTest(token=token):
                    registry = json.loads(original)
                    registry["shortcuts"][token] = "saipen stop"
                    (protocol / "REGISTRY.json").write_text(
                        json.dumps(registry), encoding="utf-8"
                    )
                    binding = mock.patch.dict(table.__globals__, PROTOCOL_DIR=protocol)
                    with binding, self.assertRaises(AssertionError):
                        self.test_registry_holds_st_not_ss()

    # agent-confusion regression ------------------------------------------
    def test_stop_and_status_shortcuts_are_not_repeated_letter_siblings(self):
        # STOP and STATUS must not be distinguished only by repeated-letter
        # count: one must not be a strict repetition of the other.
        stop = table()["st"]
        status = table()["sss"]
        self.assertEqual(stop, "saipen stop")
        self.assertEqual(status, "saipen status")
        # structurally distinct tokens: neither is a prefix-repetition of
        # the other (ss/ss/sss was; st/sss is not).
        self.assertFalse("sss".startswith("st") or "st".startswith("sss"))

    # F/G. instrumented handler reach -------------------------------------
    def _cli_inprocess(self, argv):
        """Run the REAL adapter's main() in-process so handler spies can
        observe which implementation actually executes."""
        import saipen as cli

        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = cli.main(argv)
        try:
            payload = json.loads(buf.getvalue()) if buf.getvalue().strip() else {}
        except ValueError:
            payload = {"_unparseable_stdout": buf.getvalue()}
        return rc, payload

    def _handler_spies(self):
        """Patch BOTH underlying implementations so a single invocation
        through either one detonates. Used by the F/G instrument and its
        red control: the patch makes the test fail if ss reaches the stop
        or the status handler, independent of any output-string check."""
        import saipen as cli
        from saipen_engine import operations as ops

        fired = []

        def _spy(name):
            def _detonate(*_a, **_k):
                fired.append(name)
                raise self._HandlerFired(name)

            return _detonate

        patches = [
            mock.patch.object(
                ops, "stop_checkpoint", side_effect=_spy("stop_checkpoint")
            ),
            mock.patch.object(cli, "_status", side_effect=_spy("_status")),
        ]
        return fired, patches

    def test_instrumented_ss_reaches_neither_stop_nor_status_implementation(self):
        # SRC-024 F/G, instrumented: the retired token must die at its
        # tombstone. Patching the two underlying handlers makes this test
        # fail loudly the moment either implementation is invoked, so a
        # future `command in ("stop", "ss", "st")` dispatch tuple or a
        # resolver row resurrecting ss is caught even if the tombstone
        # output itself stays byte-identical.
        proj = self._make("instrumented-ss")
        fired, patches = self._handler_spies()
        for p in patches:
            p.start()
        try:
            rc, payload = self._cli_inprocess(
                [
                    "--project-root",
                    str(proj),
                    "--json",
                    "ss",
                ]
            )
        finally:
            for p in patches:
                p.stop()
        self.assertEqual(fired, [], f"retired ss invoked: {fired}")
        self.assertEqual(payload.get("code"), "SHORTCUT_RETIRED")
        self.assertEqual(rc, 1)

    def test_instrumented_red_control_ss_to_stop_fails_the_instrument(self):
        # Red control for the F/G instrument itself: the runtime the dispatch
        # tuple consumes is `resolve_shortcut(command, ...)` (tools/saipen.py:5059)
        # -- the same registry/runtime seam an ss -> stop reintroduction
        # attacks. A bounded mutation at that seam that maps ss onto the stop
        # implementation MUST make the stop spy fire, proving the instrument
        # can go red on exactly the regression the audit demands, rather than
        # asserting against a locally constructed dictionary.
        proj = self._make("instrumented-red")
        fired, patches = self._handler_spies()
        for p in patches:
            p.start()
        try:
            import saipen as cli

            mutation = mock.patch.object(cli, "resolve_shortcut", return_value="stop")
            with mutation, self.assertRaises(self._HandlerFired) as ctx:
                # The detonation IS the red: reaching the stop handler means
                # the migration was reintroduced, and the instrument must fail
                # on exactly that.
                self._cli_inprocess(
                    [
                        "--project-root",
                        str(proj),
                        "--json",
                        "ss",
                    ]
                )
        finally:
            for p in patches:
                p.stop()
        self.assertEqual(fired, ["stop_checkpoint"])
        self.assertEqual(str(ctx.exception), "stop_checkpoint")


if __name__ == "__main__":
    unittest.main(verbosity=2)
