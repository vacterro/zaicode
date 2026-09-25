"""Host-event translation tests for the guard CLI (SRC-030 Part 6)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import guard_events  # noqa: E402

from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


def _event(**overrides) -> dict:
    base = {
        "event": "before_tool",
        "host": "opencode",
        "cwd": str(Path.cwd()),
        "tool_name": "read",
        "tool_input": {"file_path": "src/app.py"},
    }
    base.update(overrides)
    return base


class LoadEventTests(unittest.TestCase):
    def test_a_valid_event_loads(self):
        event = guard_events.load_event(
            '{"event":"before_tool","host":"opencode","cwd":"x","tool_name":"bash",'
            '"tool_input":{"command":"saipen status"},"actor":"astra2"}'
        )
        self.assertEqual(event["tool_name"], "bash")
        self.assertEqual(event["actor"], "astra2")

    def test_oversized_events_are_refused(self):
        payload = '{"event":"x","host":"y","cwd":"z","tool_name":"t","pad":"'
        with self.assertRaises(guard_events.EventError):
            guard_events.load_event(payload + "a" * (guard_events.MAX_EVENT_BYTES + 10) + '"}')

    def test_invalid_json_is_refused(self):
        with self.assertRaises(guard_events.EventError):
            guard_events.load_event("{not json")

    def test_non_object_is_refused(self):
        with self.assertRaises(guard_events.EventError):
            guard_events.load_event("[1,2,3]")

    def test_missing_required_fields_are_refused(self):
        for field in ("event", "host", "cwd", "tool_name"):
            event = _event()
            event.pop(field)
            with self.assertRaises(guard_events.EventError, msg=field):
                guard_events.load_event(__import__("json").dumps(event))

    def test_non_dict_tool_input_is_refused(self):
        with self.assertRaises(guard_events.EventError):
            guard_events.load_event(
                __import__("json").dumps(_event(tool_input="rm -rf"))
            )


class MapEventTests(unittest.TestCase):
    def test_read_tools_map_to_read(self):
        mapped = guard_events.map_event(_event(tool_name="Read"))
        self.assertEqual(mapped["action"], "read")
        self.assertEqual(mapped["target_path"], "src/app.py")

    def test_a_namespaced_tool_is_never_resolved_to_its_last_segment(self):
        # T-1317 P0-8: a friendly suffix is not evidence of effect safety. A
        # namespaced/MCP/third-party tool is classified conservatively and
        # sent to the guard, never fast-pathed by its last name segment.
        for tool in (
            "mcp__server__edit", "mcp__server__read",
            "mcp__server__question", "plugin.read", "vendor__view",
        ):
            mapped = guard_events.map_event(_event(tool_name=tool))
            self.assertEqual(mapped["action"], "unknown", tool)

    def test_read_trust_is_never_granted_by_a_friendly_name(self):
        # Only a verified exact built-in read-only identity earns the read
        # class; `view`/`find`/`search`/`cat` style names do not.
        for tool in ("read", "glob", "grep", "list", "webfetch", "question"):
            self.assertEqual(guard_events.map_event(_event(tool_name=tool))["action"], "read", tool)
        for tool in ("view", "find", "search", "cat", "ls", "fetch"):
            self.assertNotEqual(
                guard_events.map_event(_event(tool_name=tool))["action"], "read", tool
            )

    def test_write_tools_map_to_write(self):
        for tool in ("write", "edit", "multiedit", "apply_patch"):
            mapped = guard_events.map_event(_event(tool_name=tool))
            self.assertEqual(mapped["action"], "write", tool)

    def test_delete_and_move_tools_map(self):
        self.assertEqual(guard_events.map_event(_event(tool_name="rm"))["action"], "delete")
        self.assertEqual(guard_events.map_event(_event(tool_name="mv"))["action"], "move")

    def test_shell_tools_map_to_shell(self):
        # T-1363: `ls -la` is now a PROVABLY read-only probe and earns the read
        # class by its closed verb set, so it no longer demonstrates the
        # property this control owns. An ordinary shell effect does.
        mapped = guard_events.map_event(
            _event(tool_name="bash", tool_input={"command": "npm install"})
        )
        self.assertEqual(mapped["action"], "shell")
        self.assertIsNone(mapped["target_path"])

    def test_a_direct_saipen_command_is_a_canonical_operation(self):
        mapped = guard_events.map_event(
            _event(tool_name="bash", tool_input={"command": "saipen recover"})
        )
        self.assertEqual(mapped["action"], "saipen_op")
        self.assertEqual(mapped["saipen_verb"], "recover")

    def test_a_routed_saipen_command_is_not_the_canonical_class(self):
        # Exact-token recognition only: bash -lc, eval, subshells and paths
        # are ordinary SHELL effects. Never pattern inference over free text.
        for command in (
            "bash -lc 'saipen recover'",
            "eval saipen recover",
            "cd /tmp && saipen recover",
            "sudo saipen recover",
            "./saipen recover",
        ):
            mapped = guard_events.map_event(
                _event(tool_name="bash", tool_input={"command": command})
            )
            self.assertEqual(mapped["action"], "shell", command)
            self.assertIsNone(mapped["saipen_verb"])

    def test_a_compound_saipen_command_is_an_ordinary_shell_effect(self):
        # T-1317 P0-1: the canonical exemption is all-or-nothing. Only the
        # ENTIRE command line being one bounded SAIPEN invocation qualifies.
        for command in (
            "saipen recover && rm -f .saipen/STATE.md",
            "saipen status && echo hacked > x.txt",
            "saipen recover ; rm -f x",
            "saipen recover || rm -f x",
            "saipen recover | tee x",
            "saipen recover > x",
            "saipen recover >> x",
            "saipen recover < x",
            "saipen recover $(touch x)",
            "saipen recover `touch x`",
            "saipen recover (touch x)",
            "saipen recover & touch x",
            "saipen recover\necho hacked",
            "SAIPEN_AGENT=x saipen recover",
            "bash -lc 'saipen recover'",
            "saipen recover --json && rm -f x",
        ):
            mapped = guard_events.map_event(
                _event(tool_name="bash", tool_input={"command": command})
            )
            self.assertEqual(mapped["action"], "shell", command)
            self.assertIsNone(mapped["saipen_verb"], command)

    def test_the_bounded_canonical_grammar_still_classifies(self):
        for command, verb in (
            ("saipen recover", "recover"),
            ("saipen recover --json", "recover"),
            ("saipen status", "status"),
            ("  saipen   status  ", "status"),
            ("saipen guard --event-json - --json", "guard"),
        ):
            mapped = guard_events.map_event(
                _event(tool_name="bash", tool_input={"command": command})
            )
            self.assertEqual(mapped["action"], "saipen_op", command)
            self.assertEqual(mapped["saipen_verb"], verb, command)

    def test_a_multi_file_patch_carries_every_target(self):
        # T-1317 P0-5: apply_patch supplies patchText, never filePath.
        patch = (
            "*** Begin Patch\n"
            "*** Update File: src/app.py\n"
            "*** Move to: src/app2.py\n"
            "@@\n-a\n+b\n"
            "*** Add File: docs/new.md\n"
            "*** Delete File: src/old.py\n"
            "*** End Patch\n"
        )
        mapped = guard_events.map_event(
            _event(tool_name="apply_patch", tool_input={"patchText": patch})
        )
        self.assertEqual(mapped["action"], "write")
        self.assertEqual(
            mapped["target_paths"],
            ["src/app.py", "src/app2.py", "docs/new.md", "src/old.py"],
        )
        self.assertFalse(mapped["targets_unresolved"])

    def test_patch_text_without_a_bounded_target_marker_is_unresolved(self):
        for patch in ("*** Begin Patch\n*** End Patch\n", "--- a/x\n+++ b/x\n"):
            mapped = guard_events.map_event(
                _event(tool_name="apply_patch", tool_input={"patchText": patch})
            )
            self.assertEqual(mapped["target_paths"], [], patch)
            self.assertTrue(mapped["targets_unresolved"], patch)

    def test_a_move_carries_both_endpoints(self):
        mapped = guard_events.map_event(
            _event(
                tool_name="move",
                tool_input={"source_path": "src/a.py", "destination_path": ".saipen/STATE.md"},
            )
        )
        self.assertEqual(mapped["action"], "move")
        self.assertEqual(mapped["target_paths"], ["src/a.py", ".saipen/STATE.md"])
        self.assertFalse(mapped["targets_unresolved"])

    def test_a_move_or_write_without_a_trustworthy_target_set_is_unresolved(self):
        for tool, tool_input in (
            ("write", {}),
            ("apply_patch", {}),
            ("delete", {}),
            # A move naming only one endpoint cannot be classified from the
            # other side's shape: the destination could be protected state.
            ("move", {"source_path": "src/a.py"}),
        ):
            mapped = guard_events.map_event(_event(tool_name=tool, tool_input=tool_input))
            self.assertTrue(mapped["targets_unresolved"], tool)
        for tool, tool_input in (("write", {}), ("apply_patch", {}), ("delete", {}), ("move", {})):
            mapped = guard_events.map_event(_event(tool_name=tool, tool_input=tool_input))
            self.assertEqual(mapped["target_paths"], [], tool)
            self.assertIsNone(mapped["target_path"], tool)

    def test_an_unknown_tool_is_potentially_mutating(self):
        mapped = guard_events.map_event(
            _event(tool_name="mystery_tool", tool_input={"path": "src/app.py"})
        )
        self.assertEqual(mapped["action"], "unknown")
        self.assertEqual(mapped["target_path"], "src/app.py")

    def test_a_process_control_tool_is_an_unresolved_consequential_effect(self):
        # T-1317 Target A: reviewed Kiro translation. `control_bash_process`
        # (and its translated identity `process_control`) carries a process id
        # and arbitrary stdin -- never an inspectable command line or a
        # filesystem target -- so it maps onto an unresolved consequential
        # mutation and is never an admitted targetless unknown.
        for tool in ("control_bash_process", "process_control"):
            for tool_input in (
                {"processId": "123", "input": "rm -rf src"},
                {"processId": "123", "input": "rm -rf src", "path": "src/app.py"},
            ):
                mapped = guard_events.map_event(
                    _event(tool_name=tool, tool_input=tool_input)
                )
                self.assertEqual(mapped["action"], "unknown", tool)
                self.assertTrue(mapped["targets_unresolved"], tool)
                self.assertIsNone(mapped["saipen_verb"], tool)

    def test_fallback_path_keys(self):
        for key in ("path", "file", "notebook_path", "absolute_path"):
            mapped = guard_events.map_event(_event(tool_name="write", tool_input={key: "a.py"}))
            self.assertEqual(mapped["target_path"], "a.py", key)


class DestructiveShellEffectTests(unittest.TestCase):
    """`destructive_shell_effects` resolves what a command line destroys.

    Defect class: a destructive command was judged on the absence of the
    literal text `.saipen`, so `rm -rf .` named no protected path and removed
    every one of them.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1354-parser-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name).resolve()
        self.project = self.base / "project"
        (self.project / "src").mkdir(parents=True)
        self.external = self.base / "external"
        self.external.mkdir()

    def effects(self, command: str) -> dict:
        return guard_events.destructive_shell_effects(command, str(self.project))

    def targets(self, command: str) -> list[str]:
        resolved = self.effects(command)
        self.assertIsNone(resolved["unresolved"], command)
        return [target for effect in resolved["effects"] for target in effect["targets"]]

    def test_the_project_root_is_resolved_however_it_is_spelled(self):
        for command in (
            "rm -rf .",
            "Remove-Item -Recurse .",
            "Remove-Item -LiteralPath {root} -Recurse",
            "cmd /c rd /s /q .",
            "rm -rf {root}",
            "bash -c 'rm -rf .'",
        ):
            spelled = command.format(root=self.project)
            with self.subTest(command=spelled):
                self.assertEqual(self.targets(spelled), [str(self.project)], spelled)

    def test_an_ancestor_deletion_resolves_to_the_ancestor(self):
        # The parser promises an ABSOLUTE target, not a normalized one:
        # `canonicalize_target` is the single canonicalizer, and a second one
        # here would be a second answer to the same question.
        for command in ("rm -rf ..", "rm -rf {base}"):
            spelled = command.format(base=self.base)
            with self.subTest(command=spelled):
                resolved = [Path(target).resolve() for target in self.targets(spelled)]
                self.assertEqual(resolved, [self.base], spelled)

    def test_a_non_destructive_command_resolves_to_no_effect(self):
        for command in ("echo hello", "git status", "ls -la", "python -V", "cat src/app.py"):
            with self.subTest(command=command):
                resolved = self.effects(command)
                self.assertEqual(resolved["effects"], [], command)
                self.assertIsNone(resolved["unresolved"], command)

    def test_an_external_destructive_operand_stays_external(self):
        self.assertEqual(self.targets(f"rm -rf {self.external}"), [str(self.external)])

    def test_a_mirror_copy_resolves_the_directory_it_empties(self):
        # `/MIR` is a whole word, and a single-letter-only reading of DOS
        # switches made it an operand -- so robocopy sat in the mirror verb
        # set while its branch could never fire.
        for command in ("robocopy src . /MIR", "robocopy src . /PURGE", "rsync --delete src/ ./"):
            with self.subTest(command=command):
                self.assertEqual(self.targets(command), [str(self.project)], command)

    def test_a_copy_that_deletes_nothing_is_not_an_effect(self):
        for command in ("robocopy src dst /E", "rsync -a src/ dst/"):
            with self.subTest(command=command):
                resolved = self.effects(command)
                self.assertEqual(resolved["effects"], [], command)
                self.assertIsNone(resolved["unresolved"], command)

    def test_escaped_quoting_is_unread_rather_than_misread(self):
        """`shlex` runs with escaping off, so `\\"` mis-tokenizes silently.

        Defect class: the guard reported a reading it never made. `rm -rf \\".\\"`
        resolved to the single path `\\` instead of the project root, and one
        wrapper level deeper the command vanished entirely -- no effect, no
        complaint, admitted.
        """
        for command in (
            r'rm -rf \".\"',
            r'bash -c "rm -rf \".\""',
            r"""bash -c 'bash -c "bash -c \"rm -rf .\""'""",
            r'powershell -Command "Remove-Item -Recurse \".\""',
        ):
            with self.subTest(command=command):
                resolved = self.effects(command)
                self.assertTrue(resolved["unresolved"], command)
                self.assertEqual(resolved["effects"], [], command)

    def test_a_launcher_never_hides_the_verb_behind_it(self):
        """A word that runs ANOTHER command is not the command.

        Defect class: `env FOO=1 rm -rf .` was admitted because `env` headed
        the segment, was not a destructive verb, and nothing looked past it.
        """
        for command in ("env FOO=1 rm -rf .", "sudo rm -rf .", "command rm -rf ."):
            with self.subTest(command=command):
                self.assertEqual(self.targets(command), [str(self.project)], command)

    def test_an_unreducible_launcher_fails_closed(self):
        """Its options are not a grammar the guard claims to parse."""
        for command in (
            "env -i rm -rf .",
            "timeout 5 rm -rf .",
            "sudo -u root rm -rf .",
            "nice -n 10 rm -rf .",
        ):
            with self.subTest(command=command):
                resolved = self.effects(command)
                self.assertTrue(resolved["unresolved"], command)

    def test_a_launcher_running_something_harmless_is_still_clean(self):
        for command in ("sudo systemctl restart nginx", "env FOO=1 python -V"):
            with self.subTest(command=command):
                resolved = self.effects(command)
                self.assertEqual(resolved["effects"], [], command)
                self.assertIsNone(resolved["unresolved"], command)

    def test_ordinary_quoting_and_wrappers_still_resolve(self):
        """The fix must not refuse the spellings people actually use."""
        for command in ("bash -c 'rm -rf .'", 'bash -c "rm -rf ."', "sh -c 'rm -rf .'"):
            with self.subTest(command=command):
                self.assertEqual(self.targets(command), [str(self.project)], command)
        clean = self.effects(r"echo \"hello\"")
        self.assertEqual(clean["effects"], [])
        self.assertIsNone(clean["unresolved"], "escaped quoting alone is not destructive")

    def test_a_computed_operand_is_unresolved_rather_than_guessed(self):
        for command in (
            "rm -rf $TARGET",
            'rm -rf "$(cat list.txt)"',
            "Remove-Item -Recurse $env:BUILD",
            "cat list.txt | xargs rm -rf",
            "powershell -EncodedCommand cgBtACAALQByAGYAIAAuAA==",
        ):
            with self.subTest(command=command):
                resolved = self.effects(command)
                self.assertTrue(resolved["unresolved"], command)


class DestructiveVerbReachabilityTests(unittest.TestCase):
    """Every verb the tables list must be able to produce an effect.

    Defect class: a verb sits in a table and its branch can never fire, so the
    table reads like coverage while the command is admitted. `robocopy` was
    exactly that -- it was in `_SHELL_MIRROR_VERBS` while `/MIR` parsed as an
    operand rather than a switch, so the only mirror verb that empties a
    directory resolved no effect at all. A membership list is not reachability;
    this test is the difference.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1354-verbs-")
        self.addCleanup(self._tmp.cleanup)
        self.project = Path(self._tmp.name).resolve() / "project"
        (self.project / "src").mkdir(parents=True)
        (self.project / "src" / "app.py").write_text("x = 1\n", encoding="utf-8")

    def effects(self, command: str) -> list[dict]:
        resolved = guard_events.destructive_shell_effects(command, str(self.project))
        self.assertIsNone(resolved["unresolved"], command)
        return resolved["effects"]

    def test_every_listed_verb_resolves_an_effect(self):
        #: One minimal, realistic invocation per verb -- the documented form a
        #: person would actually type, not a form chosen to make the parser win.
        invocations = {
            "rm": "rm -rf src",
            "rmdir": "rmdir src",
            "unlink": "unlink src/app.py",
            "shred": "shred -u src/app.py",
            "del": "del src/app.py",
            "erase": "erase src/app.py",
            "rd": "rd /s /q src",
            "remove-item": "Remove-Item -Recurse src",
            "ri": "ri -Recurse src",
            "mv": "mv src lib",
            "move": "move src lib",
            "move-item": "Move-Item -Path src -Destination lib",
            "mi": "mi -Path src -Destination lib",
            "ren": "ren src lib",
            "rename": "rename src lib",
            "rename-item": "Rename-Item -Path src -NewName lib",
            "rni": "rni -Path src -NewName lib",
            "robocopy": "robocopy other src /MIR",
            "rsync": "rsync --delete other/ src/",
        }
        listed = (
            guard_events._SHELL_DELETE_VERBS
            | guard_events._SHELL_MOVE_VERBS
            | guard_events._SHELL_RENAME_VERBS
            | guard_events._SHELL_MIRROR_VERBS
        )
        self.assertEqual(
            listed - set(invocations),
            set(),
            "a verb joined a table without a reachability case; the table would "
            "then claim coverage this test never measured",
        )
        for verb, command in sorted(invocations.items()):
            with self.subTest(verb=verb):
                self.assertTrue(
                    self.effects(command),
                    f"{verb!r} is in a destructive-verb table but {command!r} "
                    "resolved no effect at all, so the whole branch is unreachable",
                )


class ShellWorkingDirectoryStackTests(unittest.TestCase):
    """`popd` returns the shell to the directory `pushd` left.

    Defect class: the parser modelled `pushd` and not `popd`, so every later
    relative operand was attributed to a directory the shell had already left
    -- which turns a protected project-root delete into an apparently safe
    external one.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1354-cwd-")
        self.addCleanup(self._tmp.cleanup)
        base = Path(self._tmp.name).resolve()
        self.project = base / "project"
        self.project.mkdir()
        self.external = base / "external"
        self.external.mkdir()

    def resolve(self, command: str) -> dict:
        return guard_events.destructive_shell_effects(command, str(self.project))

    def assertTargets(self, command: str, expected: Path) -> None:
        resolved = self.resolve(command)
        self.assertIsNone(resolved["unresolved"], command)
        self.assertEqual(
            [target for effect in resolved["effects"] for target in effect["targets"]],
            [str(expected)],
            command,
        )

    def test_popd_returns_to_the_project(self):
        for command in (
            "pushd {external} ; popd ; rm -rf .",
            "pushd {external} && popd && rm -rf .",
            "Push-Location {external} ; Pop-Location ; Remove-Item -Recurse .",
        ):
            spelled = command.format(external=self.external)
            with self.subTest(command=spelled):
                self.assertTargets(spelled, self.project)

    def test_pushd_without_popd_stays_external(self):
        self.assertTargets(f"pushd {self.external} ; rm -rf .", self.external)

    def test_cd_stays_external(self):
        self.assertTargets(f"cd {self.external} ; rm -rf .", self.external)

    def test_unprovable_navigation_fails_closed(self):
        for command in (
            "cd {external} ; cd - ; rm -rf .",
            "pushd {external} ; popd ; popd ; rm -rf .",
            "pushd ; rm -rf .",
            "cd $TARGET ; rm -rf .",
        ):
            spelled = command.format(external=self.external)
            with self.subTest(command=spelled):
                resolved = self.resolve(spelled)
                self.assertEqual(resolved["effects"], [], spelled)
                self.assertTrue(resolved["unresolved"], spelled)

    def test_a_stack_deeper_than_the_bound_fails_closed(self):
        deep = " ; ".join([f"pushd {self.external}"] * 40 + ["popd", "rm -rf ."])
        resolved = self.resolve(deep)
        self.assertEqual(resolved["effects"], [])
        self.assertTrue(resolved["unresolved"])


class MapEventShellEffectTests(unittest.TestCase):
    """The mapped event carries the effects; no adapter re-parses the line."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1354-map-")
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name).resolve()

    def mapped(self, command: str) -> dict:
        return guard_events.map_event(
            _event(tool_name="bash", cwd=str(self.root), tool_input={"command": command})
        )

    def test_a_destructive_command_carries_its_resolved_effect(self):
        mapped = self.mapped("rm -rf .")
        self.assertEqual(mapped["action"], "shell")
        self.assertIsNone(mapped["shell_effects_unresolved"])
        self.assertEqual(
            mapped["shell_effects"],
            [{"action": "delete", "verb": "rm", "targets": [str(self.root)]}],
        )

    def test_an_unresolved_destructive_command_names_why(self):
        mapped = self.mapped("rm -rf $TARGET")
        self.assertEqual(mapped["shell_effects"], [])
        self.assertTrue(mapped["shell_effects_unresolved"])

    def test_an_ordinary_command_carries_no_effect(self):
        mapped = self.mapped("git status")
        self.assertEqual(mapped["shell_effects"], [])
        self.assertIsNone(mapped["shell_effects_unresolved"])

    def test_a_canonical_saipen_operation_keeps_its_own_path(self):
        mapped = self.mapped("saipen status --json")
        self.assertEqual(mapped["action"], "saipen_op")
        self.assertEqual(mapped["shell_effects"], [])
        self.assertIsNone(mapped["shell_effects_unresolved"])


class WindowsPathIsACanonicalArgumentTests(unittest.TestCase):
    """T-1380: the entry command the protocol prints must survive its own guard.

    Measured twice on 2026-09-17. BOOT names `saipen start --file <path>` as the
    transport for a request the shell cannot carry; T-1380 made the refusal
    print it with the declared task file's REAL path; and on this platform that
    path is drive-rooted with backslashes, which are in `_SHELL_SYNTAX_CHARS`
    because POSIX shells escape with them. The guard read the canonical entry
    command as an ordinary shell effect and refused it NO_ACTIVE_WORK -- a field
    session ran the exact printed command twice and was refused twice.
    """

    def verb(self, command: str):
        mapped = guard_events.map_event(
            _event(tool_name="bash", tool_input={"command": command})
        )
        return mapped["saipen_verb"], mapped["command_class"]

    def test_a_windows_path_argument_stays_canonical(self):
        verb, klass = self.verb(r"saipen start --file V:\_TEMP_\t1363-a\task.txt")
        self.assertEqual(verb, "start")
        self.assertEqual(klass, "INGRESS")

    def test_a_drive_rooted_path_on_another_verb_stays_canonical(self):
        verb, _klass = self.verb(r"saipen validate C:\Users\x\spec.md")
        self.assertEqual(verb, "validate")

    def test_a_compound_line_with_a_path_is_still_shell(self):
        """The exemption is for a path, never for a second command."""
        verb, _klass = self.verb(r"saipen recover && rm -rf V:\_TEMP_\x")
        self.assertIsNone(verb)

    def test_a_backslash_a_shell_would_act_on_is_still_shell(self):
        """A backslash before `$` is an escape in a double-quoted word."""
        verb, _klass = self.verb("saipen start --file C:\\a\\$b.txt")
        self.assertIsNone(verb)

    def test_a_pipeline_after_a_path_is_still_shell(self):
        verb, _klass = self.verb(r"saipen status --json V:\x | Out-String")
        self.assertIsNone(verb)


class IdleDoneReadOnlyAdmissionTests(unittest.TestCase):
    """SRC-085 M1: idle DONE admits read-only observation, never mutation.

    NO_ACTIVE_WORK may block consequential effects. It must not block the
    bounded read-only observation a session needs to determine what the
    project even is, and it must not turn a documented canonical line into an
    unrelated shell refusal. The corridor stays semantic: canonical
    diagnostics by the command-effect table, runtime version probes by a
    closed tool set plus a version-only argument grammar.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1432-idle-")
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name).resolve()
        saipen = self.root / ".saipen"
        saipen.mkdir(parents=True, exist_ok=True)
        (saipen / "STATE.md").write_text(
            "---\n"
            "phase: DONE\n"
            "task: none\n"
            'next_action: "saipen continue"\n'
            'blocker: ""\n'
            "transition_from: SHIP\n"
            "saipen_version: 7\n"
            "schema_version: 3\n"
            "last_event: 1\n"
            "mode: full\n"
            "agent: test-agent\n"
            'updated: "2026-09-20T00:00:00Z"\n'
            "---\n",
            encoding="utf-8",
        )
        (saipen / "BOARD.md").write_text(
            "## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8"
        )
        (saipen / "LOG.md").write_text("# LOG\n", encoding="utf-8")

    def verdict(self, command: str) -> dict:
        return guard_events.evaluate_event(
            _event(
                tool_name="bash",
                cwd=str(self.root),
                tool_input={"command": command},
            )
        )

    def test_canonical_read_only_diagnostics_are_admitted_in_idle_done(self):
        for command in (
            "saipen status --json",
            r"saipen status --json --project-root V:\_TEMP_\probe",
            "saipen permissions --json",
            "saipen explain-next --json",
        ):
            with self.subTest(command=command):
                v = self.verdict(command)
                self.assertTrue(v.get("admitted"), v)
                self.assertEqual(v.get("code"), "ADMITTED")
                self.assertEqual(v.get("action"), "saipen_op")

    def test_assigned_runtime_version_probes_are_admitted(self):
        for command in ("node --version", "python --version"):
            with self.subTest(command=command):
                mapped = guard_events.map_event(
                    _event(
                        tool_name="bash",
                        cwd=str(self.root),
                        tool_input={"command": command},
                    )
                )
                self.assertEqual(mapped["action"], "read")
                self.assertEqual(mapped["command_class"], "DIAGNOSTIC")
                v = self.verdict(command)
                self.assertTrue(v.get("admitted"), v)
                self.assertEqual(v.get("action"), "read")

    def test_a_documented_full_bound_canonical_line_is_admitted(self):
        line = (
            "saipen improve sweep imp-x IMP-001 FIXED --ticket T-1 --report r1 "
            "--reproduced y --fixed-by c1 --verification v1 --json"
        )
        v = self.verdict(line)
        self.assertTrue(v.get("admitted"), v)
        self.assertEqual(v.get("action"), "saipen_op")

    def test_consequential_effects_still_refuse_in_idle_done(self):
        for command, code in (
            ("npm install", "NO_ACTIVE_WORK"),
            ("git checkout main", "NO_ACTIVE_WORK"),
            ("rm -rf .saipen", "PROTECTED_CANONICAL_NAMESPACE"),
        ):
            with self.subTest(command=command):
                v = self.verdict(command)
                self.assertFalse(v.get("admitted"), v)
                self.assertEqual(v.get("code"), code)

    def test_the_token_bound_still_bounds(self):
        over = "saipen status " + " ".join(f"--x{index}" for index in range(30))
        v = self.verdict(over)
        self.assertFalse(v.get("admitted"), v)
        self.assertEqual(v.get("code"), "NO_ACTIVE_WORK")


if __name__ == "__main__":
    unittest.main()
