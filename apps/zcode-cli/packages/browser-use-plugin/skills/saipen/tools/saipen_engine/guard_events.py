"""Host tool-event translation for the guard CLI (SRC-030 Part 6).

Host adapters (e.g. the OpenCode plugin) translate THEIR native payloads into
one bounded JSON event; this module maps that common event onto the admission
action/effect model. No host-specific protocol semantics live in admission.py:
adapters translate, admission decides.

Closed mapping, three hard rules (SRC-028:R012 / T-1317 P0-1, P0-5, P0-8):

1. Canonical-operation exemption is all-or-nothing. A shell command reads as
   ``saipen_op`` ONLY when the ENTIRE command line is one bounded SAIPEN
   invocation: closed verb vocabulary, bounded argument alphabet, and no shell
   control syntax anywhere OUTSIDE quoted literal payload regions (T-1386) --
   canonical command structure defines the effect, and payload bytes are
   data, never shell syntax. ``saipen recover && rm -f .saipen/STATE.md`` is
   an ordinary SHELL effect and is judged as one.
2. Effect is decided from a target SET, never a first hit. Multi-file patches
   and both endpoints of a move/rename are carried explicitly for every
   consequential target.
3. Tool names grant nothing. Only an exact verified built-in read-only tool
   identity earns the read class; a namespaced or unknown tool is classified
   conservatively even when its last segment spells ``read``.
4. An unclassified consequential tool never reaches admission as an ordinary
   healthy mutation (T-1317 Target A). ``control_bash_process`` -- the Kiro
   process-control surface -- is translated explicitly as an unresolved
   consequential effect because its event carries a process id and arbitrary
   stdin, never an inspectable command line or a filesystem target. Every
   other unknown tool stays ``unknown``/mutating and `admission` refuses it
   on a bound project even when the protocol state is healthy: a healthy
   state is not evidence that an unclassified effect is safe.
5. OpenCode's exact built-in ``task`` identity is a consequential delegation
   boundary, not a file mutation. It is admitted only after normal protocol
   state/actor checks; the child session's concrete tools must traverse the
   same host hook. Namespaced/lookalike tools remain unclassified.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import shlex
from pathlib import Path, PurePosixPath, PureWindowsPath

from . import command_effects
from .admission import normalize_action

#: The guard accepts a bounded JSON document, never arbitrary structures.
MAX_EVENT_BYTES = 256 * 1024

#: tool_input keys consulted, in order, for a single file target. First hit wins.
_PATH_KEYS = (
    "file_path",
    "filePath",
    "notebook_path",
    "notebookPath",
    "target_file",
    "targetFile",
    "absolute_path",
    "absolutePath",
    "path",
    "file",
)

#: Move/rename endpoints. BOTH sides are consequential (P0-6): a move into
#: protected canonical state and a move out of it are different attacks and
#: neither may be classified from one first-hit path key.
_SOURCE_PATH_KEYS = (
    "source_path",
    "sourcePath",
    "src_path",
    "srcPath",
    "from_path",
    "fromPath",
    "old_path",
    "oldPath",
    "origin_path",
    "originPath",
)

_DESTINATION_PATH_KEYS = (
    "destination_path",
    "destinationPath",
    "dest_path",
    "destPath",
    "to_path",
    "toPath",
    "new_path",
    "newPath",
    "target_path",
    "targetPath",
)

#: Multi-target patch markers (OpenCode `apply_patch`/`patch` carry
#: ``patchText`` with no ``filePath`` at all). Bounded preflight grammar only:
#: target discovery, never a patch engine and never the diff body.
_PATCH_FILE_MARKERS = (
    "*** Add File:",
    "*** Update File:",
    "*** Delete File:",
    "*** Move to:",
    "*** Move File:",
    "*** Rename File:",
)

#: Verified exact OpenCode built-in read-only tool identities. Nothing else
#: earns the read class: no ``view``/``cat``/``find``/``search`` suffix trust
#: and no namespaced last-segment trust (P0-8).
_READ_TOOLS = frozenset(
    {
        "read",
        "glob",
        "grep",
        "list",
        "webfetch",
        # T-1317 APPEND: the bootstrap `skill` tool reads skill/protocol
        # material into context and writes nothing, so it earns the bounded
        # read class by verified identity. Bootstrap access must not fail
        # merely because mutation admission is unavailable.
        "skill",
        "question",
    }
)

_SHELL_TOOLS = frozenset(
    {
        "bash",
        "shell",
        "sh",
        "zsh",
        "cmd",
        "powershell",
        "exec",
        "terminal",
        "run_command",
        "runcommand",
        "runterminalcmd",
        "command",
    }
)

#: Explicitly reviewed Kiro v3 surface translation (T-1317 Target A). The
#: Kiro shell surface is `execute_bash` (one bounded command line the guard
#: can inspect) and `control_bash_process` (resume/steer an already-spawned
#: OS process by id, feeding arbitrary stdin). `control_bash_process` is
#: CONSEQUENTIAL and its event names no filesystem target and no command
#: line the canonical-verb check could judge, so the reviewed translation
#: classifies it as an UNRESOLVED consequential mutation: refused before
#: host execution, never an admitted targetless unknown, never an ordinary
#: shell event, and never read-trusted from its friendly name.
#: ``process_control`` is the translated identity the Kiro transport
#: (tools/host_guard.py) sends for this class.
_PROCESS_CONTROL_TOOLS = frozenset({"control_bash_process", "process_control"})

_WRITE_TOOLS = frozenset(
    {
        "write",
        "writefile",
        "edit",
        "editfile",
        "multiedit",
        "apply_patch",
        "applypatch",
        "patch",
        "create",
        "createfile",
        "save",
        "replace",
        "str_replace",
        "str_replace_editor",
        "notebookedit",
        "edit_notebook",
    }
)

_DELETE_TOOLS = frozenset({"delete", "remove", "rm", "unlink", "trash"})

_MOVE_TOOLS = frozenset({"move", "rename", "mv"})

#: Any of these makes an entire command line a COMPOUND shell expression:
#: command chaining, pipelines, redirection, command substitution, subshells,
#: glob/brace expansion, escaping, quoting, comments or a second
#: newline-separated command. Presence of one disqualifies the canonical
#: exemption for the whole line -- never a substring or regex guess at intent.
_SHELL_SYNTAX_CHARS = frozenset("|&;<>(){}[]$`*?~!\\\"'#\n\r\t")

#: Bounded argument alphabet for the `saipen <verb> [args]` grammar that
#: canonical operations actually use (flags, ids, dotted names, paths without
#: whitespace). Anything outside it is not a canonical argument.
_SAIPEN_ARG_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.,:/=+-@"
)

#: The same alphabet plus the one character Windows spells paths with. A
#: backslash is in `_SHELL_SYNTAX_CHARS` because POSIX shells escape with it;
#: on this platform it is a path separator, and `_backslashes_are_literal`
#: already owns that distinction for ingress payloads.
_SAIPEN_PATH_ARG_CHARS = _SAIPEN_ARG_CHARS | {"\\"}

#: A canonical operation never needs an unbounded argument list. The bound is
#: the documented grammar's own maximum plus headroom, not a guess: the full
#: `saipen improve sweep` line with every documented optional flag and `--json`
#: reaches 17 tokens, and the former 12-token bound made `_saipen_cli_tokens`
#: return None, so a documented canonical line fell through to action=shell
#: and was refused NO_ACTIVE_WORK in an idle DONE project (T-1401/T-1432). The
#: argument alphabet above, not the token count, remains the real limit.
_SAIPEN_MAX_TOKENS = 24

# This is a bounded accidental-mutation preflight, not a shell parser. A
# protected namespace segment is significant even inside quotes, a Python -c
# string, a Windows path or a simple traversal spelling. Deliberately computed
# paths and obfuscated code remain outside this preflight's proof boundary.
_PROTECTED_SHELL_SEGMENT = re.compile(
    r"(?<![A-Za-z0-9_.-])\.saipen(?![A-Za-z0-9_.-])", re.IGNORECASE
)

# ---- T-1354: destructive filesystem effects of a shell command -------------
#
# The literal text `.saipen` is not what makes a command dangerous. `rm -rf .`
# names no protected path and removes all of it, while the native delete of
# `.` is refused by containment -- one effect, two answers, the agent picks the
# surface. So a shell command's DESTRUCTIVE filesystem effects are resolved to
# targets here and admission judges each one exactly as the file-tool effect it
# is. Bounded on purpose: the verbs below, their documented flags, the
# explicit `bash -c` / `powershell -Command` / `cmd /c` / `eval` wrappers and
# command substitutions. A destructive verb whose operands cannot be resolved
# (variables, expressions, piped or encoded input, an unknown working
# directory) is reported UNRESOLVED and refused; everything else a shell
# program can do stays outside this proof, as CORE 1.4 says.

#: Normalized verb names (lower case, no directory, no executable extension).
_SHELL_DELETE_VERBS = frozenset(
    {"rm", "rmdir", "unlink", "shred", "del", "erase", "rd", "remove-item", "ri"}
)
_SHELL_MOVE_VERBS = frozenset({"mv", "move", "move-item", "mi"})
_SHELL_RENAME_VERBS = frozenset({"ren", "rename", "rename-item", "rni"})
_SHELL_MIRROR_VERBS = frozenset({"robocopy", "rsync"})
_POSIX_SHELL_VERBS = frozenset({"bash", "sh", "zsh", "dash", "ksh", "busybox"})
_POWERSHELL_VERBS = frozenset({"powershell", "pwsh"})
_EVAL_VERBS = frozenset({"eval", "iex", "invoke-expression"})
_CD_VERBS = frozenset({"cd", "chdir", "set-location", "sl"})
_PUSHD_VERBS = frozenset({"pushd", "push-location"})
_POPD_VERBS = frozenset({"popd", "pop-location"})
#: Words that run ANOTHER command rather than doing anything themselves. The
#: guard drops them to reach the real verb; when it cannot, the segment fails
#: closed below rather than being read as the launcher's own harmless effect.
_PREFIX_WORDS = frozenset(
    {
        "sudo",
        "doas",
        "command",
        "builtin",
        "exec",
        "nohup",
        "time",
        "call",
        "env",
        "timeout",
        "nice",
        "ionice",
        "stdbuf",
        "setsid",
        "chrt",
        "taskset",
        "&",
        ".",
    }
)
#: PowerShell parameters that take a value, matched by unambiguous prefix the
#: way PowerShell binds them. Everything else spelled `-Name` is a switch.
_PS_VALUE_PARAMETERS = (
    "path",
    "literalpath",
    "destination",
    "newname",
    "include",
    "exclude",
    "filter",
    "erroraction",
    "warningaction",
    "informationaction",
    "errorvariable",
    "warningvariable",
    "informationvariable",
    "outvariable",
    "outbuffer",
    "pipelinevariable",
    "credential",
    "stream",
)
_PS_ONLY_VERBS = frozenset({"remove-item", "ri", "move-item", "mi", "rename-item", "rni"})
#: A destructive verb spelled anywhere in a segment the parser could not read.
#: Used to fail closed rather than report an unread segment as read.
_DESTRUCTIVE_TEXT = re.compile(
    r"(?i)\b(rm|rmdir|rd|del|erase|remove-item|move-item|mv|move)\b"
)
#: A backslash-escaped quote. `_shell_words` runs `shlex` with escaping
#: disabled, so these tokenize into nonsense rather than raising.
_ESCAPED_QUOTE = re.compile(r"\\[\"']")
#: An operand carrying run-time syntax: variables, substitutions, expressions.
_COMPUTED_OPERAND = re.compile(r"[$`%]|^[(@{]")
_GLOB_CHARACTERS = frozenset("*?[")
_MAX_SHELL_NESTING = 3
_MAX_GLOB_ENTRIES = 2000
_MAX_REPO_WALK = 64
_MAX_CWD_STACK = 16


def _shell_segments(text: str) -> tuple[list[tuple[str, bool]], list[str]]:
    """Top-level simple commands (with "was piped into") and substitutions."""
    segments: list[tuple[str, bool]] = []
    nested: list[str] = []
    current: list[str] = []
    quote: str | None = None
    piped = False
    index = 0

    def close(next_piped: bool) -> None:
        nonlocal piped
        segment = "".join(current).strip()
        if segment:
            segments.append((segment, piped))
        current.clear()
        piped = next_piped

    while index < len(text):
        char = text[index]
        if quote == "'":
            current.append(char)
            if char == "'":
                quote = None
            index += 1
            continue
        if char == "$" and text[index + 1 : index + 2] == "(":
            depth, end = 1, index + 2
            while end < len(text) and depth:
                depth += {"(": 1, ")": -1}.get(text[end], 0)
                end += 1
            nested.append(text[index + 2 : end - 1])
            current.append("$(...)")
            index = end
            continue
        if char == "`" and quote != '"':
            end = text.find("`", index + 1)
            if end > index:
                nested.append(text[index + 1 : end])
                current.append("$(...)")
                index = end + 1
                continue
        if quote == '"':
            current.append(char)
            if char == '"':
                quote = None
            index += 1
            continue
        if char in "'\"":
            quote = char
            current.append(char)
            index += 1
            continue
        if char in ";\r\n":
            close(False)
            index += 1
            continue
        if char == "|":
            doubled = text[index + 1 : index + 2] == "|"
            close(not doubled)
            index += 2 if doubled else 1
            continue
        if char == "&" and not (current and current[-1] in "<>"):
            close(False)
            index += 2 if text[index + 1 : index + 2] == "&" else 1
            continue
        current.append(char)
        index += 1
    close(False)
    return segments, nested


def _shell_words(segment: str) -> list[str] | None:
    lexer = shlex.shlex(segment, posix=True)
    lexer.whitespace_split = True
    lexer.escape = ""
    lexer.commenters = ""
    try:
        words = list(lexer)
    except ValueError:
        return None
    if words:
        words[0] = words[0].lstrip("({")
        words[-1] = words[-1].rstrip(")}") or words[-1]
    return [word for word in words if word]


#: T-1387. One path operand spelled with the characters a project path uses:
#: an optional drive, then names and separators -- no glob, variable, quote,
#: `~`, `=` or anything else whose meaning the guard would have to guess.
_CLEAN_SHELL_PATH = re.compile(r"(?:[A-Za-z]:)?[A-Za-z0-9_.\-\\/]+")
#: A redirection glued to its operand (`>.saipen/kitchen/out.txt`).
_GLUED_REDIRECTION = re.compile(r"^\d?(?:>>?|<)")


def shell_namespace_paths(command: str | None, cwd: str | None) -> list[str] | None:
    """T-1387: every `.saipen` path a shell line names, spelled absolute so
    admission judges each one exactly as it judges a file-tool target.

    The write tool was admitted to create `.saipen/kitchen/<file>` while the
    shell was refused for running or deleting that same file, because the
    shell preflight refused the literal text `.saipen` and structured
    protection covers only the canonical path list: one file, two answers.

    None when one mention is not a path the guard can judge -- the namespace
    itself, a glob, a variable, a substitution, a word that merely contains the
    text -- and that keeps the whole-namespace refusal.
    """
    if not command or not cwd or not _PROTECTED_SHELL_SEGMENT.search(command):
        return None
    segments, nested = _shell_segments(command)
    if any(_PROTECTED_SHELL_SEGMENT.search(text) for text in nested):
        return None
    paths: list[str] = []
    for segment, _piped in segments:
        if not _PROTECTED_SHELL_SEGMENT.search(segment):
            continue
        words = _shell_words(segment)
        if words is None:
            return None
        for word in words:
            if not _PROTECTED_SHELL_SEGMENT.search(word):
                continue
            operand = _GLUED_REDIRECTION.sub("", word)
            if not _CLEAN_SHELL_PATH.fullmatch(operand):
                return None
            parts = [part.lower() for part in re.split(r"[\\/]", operand)]
            if ".saipen" not in parts or parts.index(".saipen") == len(parts) - 1:
                return None
            raw = Path(operand)
            paths.append(str(raw if raw.is_absolute() else Path(cwd) / raw))
    return paths or None


def _shell_verb(word: str) -> str:
    name = re.split(r"[\\/]", word)[-1].lower()
    for suffix in (".exe", ".cmd", ".bat", ".com", ".ps1"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def _ps_parameter(name: str) -> str | None:
    matches = [full for full in _PS_VALUE_PARAMETERS if full.startswith(name)]
    return matches[0] if len(matches) == 1 or name in _PS_VALUE_PARAMETERS else None


def _is_redirection(word: str) -> bool:
    return bool(re.fullmatch(r"\d?(>>?|<)(&\d)?", word)) or bool(
        re.fullmatch(r"\d?>>?\S+|<\S+", word)
    )


def _parse_arguments(verb: str, words: list[str]) -> tuple[list[str], dict, set]:
    """Operands, PowerShell named values and switches of one simple command."""
    operands: list[str] = []
    named: dict[str, list[str]] = {}
    switches: set[str] = set()
    powershell = verb in _PS_ONLY_VERBS
    index = 0
    options_done = False
    while index < len(words):
        word = words[index]
        index += 1
        if options_done:
            operands.append(word)
            continue
        if word == "--":
            options_done = True
            continue
        if _is_redirection(word):
            if re.fullmatch(r"\d?(>>?|<)", word):
                index += 1
            continue
        if word.startswith("-") and len(word) > 1:
            name, _sep, bound = word[1:].partition(":")
            lowered = name.lower().lstrip("-")
            parameter = (
                _ps_parameter(lowered) if (powershell or len(lowered) >= 3) and lowered else None
            )
            if parameter:
                if bound:
                    named.setdefault(parameter, []).append(bound)
                elif index < len(words):
                    named.setdefault(parameter, []).append(words[index])
                    index += 1
            else:
                switches.add(lowered)
            continue
        if re.fullmatch(r"/[A-Za-z?](:.*)?", word):
            switches.add(word[1:2].lower())
            continue
        if verb in _SHELL_MIRROR_VERBS and re.fullmatch(r"/[A-Za-z]{2,}(:.*)?", word):
            # Robocopy spells its switches as whole words. Reading only the
            # single-letter DOS form made `/MIR` an operand, so the one verb in
            # the mirror set that empties a directory resolved no effect at all
            # and the whole branch was unreachable. The form stays scoped to
            # the mirror verbs: on POSIX `/tmp` is a path, not a switch.
            switches.add(word[1:].partition(":")[0].lower())
            continue
        operands.append(word)
    return operands, named, switches


def _absolute(token: str, cwd: str | None) -> str | None:
    windows = os.name == "nt"
    if windows and re.fullmatch(r"/[A-Za-z](/.*)?", token):
        token = f"{token[1]}:\\{token[3:]}"
    pure = PureWindowsPath(token) if windows else PurePosixPath(token)
    if pure.is_absolute() or (windows and pure.root):
        return str(Path(token))
    if cwd is None:
        return None
    return str(Path(cwd) / token)


def _resolve_operand(token: str, cwd: str | None) -> tuple[list[str], str | None]:
    """The absolute paths one operand names, or why they cannot be known."""
    if _COMPUTED_OPERAND.search(token) or ("{" in token and "," in token):
        return [], f"operand '{token}' is computed when the command runs"
    if token.startswith("~"):
        token = os.path.expanduser(token)
    pure = PureWindowsPath(token) if os.name == "nt" else PurePosixPath(token)
    parts = pure.parts
    wild = next((i for i, part in enumerate(parts) if _GLOB_CHARACTERS & set(part)), None)
    if wild is None:
        absolute = _absolute(token, cwd)
        if absolute is None:
            return [], f"operand '{token}' is relative to a working directory that is not known"
        return [absolute], None
    base_text = str(type(pure)(*parts[:wild])) if wild else "."
    base = _absolute(base_text, cwd)
    if base is None:
        return [], f"operand '{token}' is relative to a working directory that is not known"
    try:
        with os.scandir(base) as entries:
            names = []
            for entry in entries:
                names.append(entry.name)
                if len(names) > _MAX_GLOB_ENTRIES:
                    return [], f"'{token}' matches in a directory too large to enumerate"
    except FileNotFoundError:
        return [], None
    except OSError as exc:
        return [], f"'{token}' cannot be expanded ({exc.strerror or exc})"
    # Case-insensitive and dot-inclusive: the widest reading any of the three
    # shells gives the pattern, so a match is never missed.
    pattern = parts[wild].lower()
    rest = parts[wild + 1 :]
    matched = [name for name in names if fnmatch.fnmatchcase(name.lower(), pattern)]
    targets = []
    for name in matched:
        if rest and not any(_GLOB_CHARACTERS & set(part) for part in rest):
            targets.append(str(Path(base, name, *rest)))
        else:
            targets.append(str(Path(base, name)))
    return targets, None


def _repository_top(cwd: str | None) -> str | None:
    if cwd is None:
        return None
    current = Path(cwd)
    for _ in range(_MAX_REPO_WALK):
        if (current / ".git").exists():
            return str(current)
        if current.parent == current:
            break
        current = current.parent
    return cwd


def _git_effect(words: list[str], cwd: str | None) -> tuple[dict | None, str | None]:
    """The worktree a git subcommand destroys, for the few that do."""
    index = 0
    while index < len(words) and words[index].startswith("-"):
        option = words[index]
        if option in ("-C", "-c") and index + 1 < len(words):
            if option == "-C":
                cwd = _absolute(words[index + 1], cwd)
            index += 2
            continue
        if option.startswith(("--git-dir", "--work-tree")):
            return None, "git runs against a worktree named by an option"
        index += 1
    if index >= len(words):
        return None, None
    subcommand, args = words[index].lower(), words[index + 1 :]
    operands, _named, switches = _parse_arguments("git", args)
    flags = "".join(sorted(switches))
    top = _repository_top(cwd)

    def scope(paths: list[str]) -> tuple[dict | None, str | None]:
        if not paths:
            if top is None:
                return None, "git runs in a working directory that is not known"
            return {"action": "delete", "verb": f"git {subcommand}", "targets": [top]}, None
        targets: list[str] = []
        for token in paths:
            resolved, why = _resolve_operand(token, cwd)
            if why:
                return None, why
            targets.extend(resolved)
        return {"action": "delete", "verb": f"git {subcommand}", "targets": targets}, None

    if subcommand == "clean":
        if "force" in switches or any("f" in flag for flag in switches if len(flag) <= 4):
            return scope(operands)
        return None, None
    if subcommand == "rm":
        return (scope(operands) if "cached" not in switches and operands else (None, None))
    if subcommand == "reset":
        return scope([]) if "hard" in switches else (None, None)
    if subcommand in ("checkout", "restore"):
        if subcommand == "restore" and "staged" in switches and not {"worktree", "w"} & switches:
            return None, None
        if "--" in args or subcommand == "restore":
            return scope(operands) if operands else (None, None)
        if any(token == "." or _GLOB_CHARACTERS & set(token) for token in operands):
            return scope(operands)
        return None, None
    if subcommand == "stash":
        action = operands[0].lower() if operands else "push"
        if action in ("push", "save", "apply", "pop") or not operands:
            paths = args[args.index("--") + 1 :] if "--" in args else []
            return scope(paths)
        return None, None
    del flags
    return None, None


def _navigate(verb: str, args: list[str], cwd: str | None, stack: list[str | None]) -> str | None:
    """The working directory after one navigation word; `stack` is the dir stack.

    A parser that models `pushd` and not `popd` attributes every later relative
    operand to the directory the shell already left, so
    `pushd <external>; popd; rm -rf .` reads as a safe external delete when it
    deletes the project root. An unprovable move -- `cd -`, a bare POSIX
    `pushd` swap, a computed operand, a stack deeper than the guard tracks --
    yields an unknown directory, which makes later relative destructive
    operands unresolved instead of guessed.
    """
    if verb in _POPD_VERBS:
        return stack.pop() if stack else None
    operands, named, _switches = _parse_arguments(verb, args)
    tokens = named.get("path") or named.get("literalpath") or operands
    if verb in _PUSHD_VERBS:
        if len(stack) >= _MAX_CWD_STACK:
            # Depth beyond the bound is no longer tracked, so no entry below
            # it can be trusted to restore a directory either.
            stack[:] = [None] * len(stack)
            return None
        stack.append(cwd)
        if not tokens:
            return None
    destination = (tokens or ["~"])[0]
    if destination == "-" or _COMPUTED_OPERAND.search(destination):
        return None
    return _absolute(os.path.expanduser(destination), cwd)


def destructive_shell_effects(command: str, cwd: str | None, _depth: int = 0) -> dict:
    """Resolve the delete/move effects of one shell command line (T-1354).

    Returns ``{"effects": [{"action", "verb", "targets"}...], "unresolved": str
    | None}``. Targets are absolute. An effect is reported whenever a bounded
    destructive verb runs; ``unresolved`` names the first one whose targets
    cannot be known, and admission refuses the command for it.
    """
    effects: list[dict] = []
    unresolved: str | None = None
    cwd_stack: list[str | None] = []
    if _depth > _MAX_SHELL_NESTING:
        return {"effects": [], "unresolved": "shell wrappers nest deeper than the guard reads"}
    segments, nested = _shell_segments(command)
    for script in nested:
        inner = destructive_shell_effects(script, cwd, _depth + 1)
        effects.extend(inner["effects"])
        unresolved = unresolved or inner["unresolved"]
    for segment, piped in segments:
        words = _shell_words(segment)
        if words is None:
            if _DESTRUCTIVE_TEXT.search(segment):
                unresolved = unresolved or f"destructive command cannot be parsed: {segment[:80]}"
            continue
        if _ESCAPED_QUOTE.search(segment) and _DESTRUCTIVE_TEXT.search(segment):
            # Escaping is disabled in the lexer, so `\"` does not raise -- it
            # tokenizes into nonsense, and the guard then reports a reading it
            # never made. Measured: `rm -rf \".\"` resolved to the single path
            # `\` rather than the project root, and one wrapper level deeper
            # the command disappeared, leaving no effect and no complaint. A
            # segment the guard cannot read whole is not a segment it read.
            unresolved = unresolved or (
                f"escaped quoting the guard cannot read whole: {segment[:80]}"
            )
            continue
        launched = False
        while words and (re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", words[0]) or
                         words[0].lower() in _PREFIX_WORDS):
            launched = launched or words[0].lower() in _PREFIX_WORDS
            words = words[1:]
        if not words:
            continue
        verb, args = _shell_verb(words[0]), words[1:]
        if verb in _POSIX_SHELL_VERBS or verb in _POWERSHELL_VERBS or verb == "cmd":
            script = _wrapped_script(verb, args)
            if script is _ENCODED:
                unresolved = unresolved or f"{verb} runs an encoded command the guard cannot read"
            elif script:
                inner = destructive_shell_effects(script, cwd, _depth + 1)
                effects.extend(inner["effects"])
                unresolved = unresolved or inner["unresolved"]
            continue
        if verb in _EVAL_VERBS:
            inner = destructive_shell_effects(" ".join(args), cwd, _depth + 1)
            effects.extend(inner["effects"])
            unresolved = unresolved or inner["unresolved"]
            continue
        if verb in _CD_VERBS or verb in _PUSHD_VERBS or verb in _POPD_VERBS:
            cwd = _navigate(verb, args, cwd, cwd_stack)
            continue
        if verb == "xargs":
            if any(_shell_verb(word) in _SHELL_DELETE_VERBS | _SHELL_MOVE_VERBS for word in args):
                unresolved = unresolved or (
                    "xargs takes its destructive operands from standard input"
                )
            continue
        if verb == "find":
            starts = []
            for word in args:
                if word.startswith(("-", "(", "!")):
                    break
                starts.append(word)
            lowered = [word.lower() for word in args]
            deletes = "-delete" in lowered or any(
                word in ("-exec", "-execdir", "-ok", "-okdir")
                and position + 1 < len(args)
                and _shell_verb(args[position + 1]) in _SHELL_DELETE_VERBS | _SHELL_MOVE_VERBS
                for position, word in enumerate(lowered)
            )
            if deletes:
                effect, why = _operand_effect("delete", "find", starts or ["."], cwd)
                effects.extend([effect] if effect else [])
                unresolved = unresolved or why
            continue
        if verb == "git":
            effect, why = _git_effect(args, cwd)
            effects.extend([effect] if effect else [])
            unresolved = unresolved or why
            continue
        if verb not in (
            _SHELL_DELETE_VERBS | _SHELL_MOVE_VERBS | _SHELL_RENAME_VERBS | _SHELL_MIRROR_VERBS
        ):
            if launched and _DESTRUCTIVE_TEXT.search(segment):
                # A launcher ran something the guard could not reduce to a
                # verb it knows -- `timeout 5 rm -rf .`, `sudo -u root rm -rf .`
                # -- so the destructive word in the line is unaccounted for.
                # Reading that as the launcher's own harmless effect is how
                # `env FOO=1 rm -rf .` was admitted on a healthy project.
                unresolved = unresolved or (
                    f"a launcher runs a destructive command the guard cannot "
                    f"reduce: {segment[:80]}"
                )
            continue
        operands, named, switches = _parse_arguments(verb, args)
        paths = named.get("path", []) + named.get("literalpath", []) + operands
        if verb in _SHELL_MIRROR_VERBS:
            mirror = {"mir", "purge", "delete", "delete-before", "delete-after", "delete-during"}
            if switches & mirror and len(operands) >= 2:
                target = operands[1] if verb == "robocopy" else operands[-1]
                effect, why = _operand_effect("delete", verb, [target], cwd)
                effects.extend([effect] if effect else [])
                unresolved = unresolved or why
            continue
        if verb in _SHELL_RENAME_VERBS:
            new_name = (named.get("newname") or operands[1:2] or [None])[0]
            paths = (named.get("path") or named.get("literalpath") or operands[:1])
            if not paths or new_name is None:
                if piped:
                    unresolved = unresolved or f"{verb} takes its target from the pipeline"
                continue
            effect, why = _operand_effect("move", verb, [paths[0]], cwd)
            if effect:
                parent = str(Path(effect["targets"][0]).parent)
                renamed, why = _operand_effect("move", verb, [new_name], parent)
                if renamed:
                    effect["targets"].extend(renamed["targets"])
                effects.append(effect)
            unresolved = unresolved or why
            continue
        if verb in _SHELL_MOVE_VERBS:
            paths = paths + named.get("destination", [])
        if not paths:
            if piped:
                unresolved = unresolved or f"{verb} takes its targets from the pipeline"
            continue
        action = "move" if verb in _SHELL_MOVE_VERBS else "delete"
        effect, why = _operand_effect(action, verb, paths, cwd)
        effects.extend([effect] if effect else [])
        unresolved = unresolved or why
    return {"effects": effects, "unresolved": unresolved}


_ENCODED = object()


def _wrapped_script(verb: str, args: list[str]):
    """The script a shell wrapper runs, `_ENCODED` for an unreadable one."""
    lowered = [word.lower() for word in args]
    if verb in _POSIX_SHELL_VERBS:
        for index, word in enumerate(lowered):
            if word.startswith("-") and not word.startswith("--") and "c" in word[1:]:
                return args[index + 1] if index + 1 < len(args) else None
        return None
    if verb in _POWERSHELL_VERBS:
        for index, word in enumerate(lowered):
            name = word.lstrip("-/")
            if word.startswith(("-", "/")) and name and "encodedcommand".startswith(name) and (
                len(name) >= 2 or name == "e"
            ):
                return _ENCODED
            if word.startswith(("-", "/")) and name and "command".startswith(name):
                return " ".join(args[index + 1 :])
        return None
    for index, word in enumerate(lowered):
        if word in ("/c", "/k", "/r"):
            return " ".join(args[index + 1 :])
    return None


def _operand_effect(
    action: str, verb: str, tokens: list[str], cwd: str | None
) -> tuple[dict | None, str | None]:
    targets: list[str] = []
    for token in tokens:
        resolved, why = _resolve_operand(token, cwd)
        if why:
            return None, why
        targets.extend(resolved)
    if not targets:
        return None, None
    return {"action": action, "verb": verb, "targets": targets}, None


class EventError(ValueError):
    """The event document is not a legal bounded guard event."""


def load_event(raw: str) -> dict:
    """Parse and validate one bounded JSON guard event document."""
    if len(raw.encode("utf-8", errors="replace")) > MAX_EVENT_BYTES:
        raise EventError(f"guard event exceeds {MAX_EVENT_BYTES} bytes")
    try:
        event = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise EventError(f"guard event is not valid JSON: {exc}") from None
    if not isinstance(event, dict):
        raise EventError("guard event must be a JSON object")
    for field in ("event", "host", "cwd", "tool_name"):
        value = event.get(field)
        if not isinstance(value, str) or not value.strip():
            raise EventError(f"guard event field {field!r} must be a non-empty string")
    tool_input = event.get("tool_input", {})
    if tool_input is None:
        tool_input = {}
    if not isinstance(tool_input, dict):
        raise EventError("guard event field 'tool_input' must be an object when present")
    if event.get("actor") is not None and not isinstance(event.get("actor"), str):
        raise EventError("guard event field 'actor' must be a string when present")
    event["tool_input"] = tool_input
    return event


def _tool_identity(tool_name: str) -> str | None:
    """The exact built-in tool identity, or None for a namespaced tool.

    A namespaced name (``mcp__server__read``) is deliberately NOT reduced to
    its last segment: a friendly suffix is not evidence of effect safety, so
    the event falls through to the conservative unknown class and is sent to
    admission for judgement (P0-8).
    """
    raw = str(tool_name).strip().lower()
    if not raw or "__" in raw or "." in raw:
        return None
    return raw


def _patch_targets(patch_text: object) -> tuple[list[str], bool]:
    """Every file target the bounded patch-marker grammar names.

    Returns ``(targets, unresolved)``. ``unresolved`` is True when patch text
    exists but yields no trustworthy target set, which must fail closed rather
    than pass as an ordinary healthy mutation.
    """
    if not isinstance(patch_text, str) or not patch_text.strip():
        return [], False
    targets: list[str] = []
    unresolved = False
    for line in patch_text.splitlines():
        stripped = line.strip()
        for marker in _PATCH_FILE_MARKERS:
            if stripped.startswith(marker):
                candidate = stripped[len(marker) :].strip()
                if candidate:
                    targets.append(candidate)
                else:
                    unresolved = True
                break
    if not targets:
        # Patch-shaped mutation with no recognisable target marker: the target
        # set is unknown, so it is not an ordinary project mutation.
        return [], True
    return targets, unresolved


def _extract_targets(tool_input: dict) -> tuple[list[str], bool]:
    """The full normalized target set an event carries, in declaration order."""
    targets: list[str] = []
    for key in _PATH_KEYS + _SOURCE_PATH_KEYS + _DESTINATION_PATH_KEYS:
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            targets.append(value.strip())
    patch_text = tool_input.get("patchText")
    if patch_text is None:
        patch_text = tool_input.get("patch_text")
    patched, patch_unresolved = _patch_targets(patch_text)
    targets.extend(patched)
    return list(dict.fromkeys(targets)), patch_unresolved


#: T-1363: characters an INGRESS payload may not carry INSIDE its quotes.
#: Measured against the three shells a real request travels through -- bash,
#: PowerShell 5.1/7, and the cmd.exe a PowerShell host forwards `saipen.cmd`
#: through. Inside a single-quoted argument bash and PowerShell expand
#: NOTHING, and PowerShell re-quotes the argument for cmd, which neutralises
#: `& | < > ^`. Three things survive that and are refused here:
#:
#: * the quote characters themselves -- one ends the argument, the other
#:   breaks PowerShell 5.1's re-quoting into cmd;
#: * a SECOND `%`, because `%NAME%` needs a pair and cmd expands it even
#:   inside double quotes (a lone `50%` is literal everywhere);
#: * control characters, including the newline no single argument can carry.
#:
#: Everything else -- `$`, backtick, `&`, `|`, `<`, `>`, `^`, backslashes,
#: every non-ASCII script -- is literal in all three, so a Windows path, a
#: shell-looking word and Cyrillic or Estonian prose all travel as typed. A
#: trailing backslash is refused separately: it would escape the closing quote
#: the C runtime sees.
#: ... and the EXTRA characters a DOUBLE-quoted payload may not carry, because
#: bash and PowerShell both expand inside `"`: `$` and the backtick. A
#: single-quoted payload expands nothing in either shell and keeps the wide
#: alphabet.
_INGRESS_PAYLOAD_FORBIDDEN = frozenset("'\"")
_INGRESS_DOUBLE_QUOTE_FORBIDDEN = frozenset("$`")
#: Inside `"..."` bash treats a backslash as an escape ONLY before these; every
#: other backslash is literal there, and PowerShell and cmd never escape with
#: one at all. Measured on the field incident: a task naming
#: `V:\_TEMP_astprompter_drag\SAIPENVIEW_main.py` carries three backslashes
#: and not one of them precedes a character any shell would act on, so refusing
#: the whole line as unquotable cost a route the request never needed.
_BASH_DQ_ESCAPES = frozenset('$`"\
')


def _backslashes_are_literal(payload: str) -> bool:
    for index, char in enumerate(payload):
        if char != "\\":
            continue
        following = payload[index + 1] if index + 1 < len(payload) else ""
        if following == "" or following in _BASH_DQ_ESCAPES:
            return False
    return True
#: Task text longer than this is not refused -- it stops being quotable, and
#: another transport carries it. The bound exists so a refusal can never print
#: an unbounded machine fact back to the host.
MAX_INGRESS_REWRITE_CHARS = 4096
#: How much text `--hex` may carry in a refusal. MEASURED in the field, not
#: chosen: a free routed model given a 700-character hex blob transcribed it
#: twice and corrupted it both times (once by inserting a literal ` app` into
#: the middle of the digits). A route a weak model cannot copy is not a route,
#: so past this size the refusal names the transport that needs no
#: transcription at all -- a file written with the host's own write tool,
#: where no shell quoting exists to get wrong.
MAX_INGRESS_HEX_PAYLOAD = 96


def ingress_payload_literal(payload: str, quote: str = "'") -> bool:
    """Whether these exact bytes survive ONE quoted shell argument as typed."""
    if not payload.strip() or payload.lstrip().startswith("-"):
        return False
    forbidden = _INGRESS_PAYLOAD_FORBIDDEN
    if quote == '"':
        forbidden = forbidden | _INGRESS_DOUBLE_QUOTE_FORBIDDEN
        if not _backslashes_are_literal(payload):
            return False
    if any(ch in forbidden or ord(ch) < 32 or ord(ch) == 127 for ch in payload):
        return False
    return payload.count("%") <= 1 and not payload.endswith("\\")


#: Sequence/pipe operators. The word after one is a command name, never
#: request content.
_SHELL_SEQUENCE_OPS = frozenset({"|", "||", "&", "&&", ";"})
#: `>`, `>>`, `2>`, `2>>` -- a redirection whose target is the NEXT token.
_SHELL_REDIRECT_NEXT = re.compile(r"(?:\d+)?>{1,2}")
#: `2>&1`, `>&2`, `1>&2` -- fd duplication, complete in one token.
_SHELL_DUP_REDIRECT = re.compile(r"(?:\d+)?>{1,2}&\d+")
#: A redirection with its target glued on: `>/dev/null`, `2>err.txt`, `&>all`.
_SHELL_REDIRECT_GLUED = re.compile(r"(?:\d+|&)?>{1,2}&?\S+")
#: Input redirection with the source glued on: `<file`, `0</dev/null`.
_SHELL_INPUT_GLUED = re.compile(r"(?:\d+)?<{1,2}\S+")


def shell_control_expression(payload: str) -> bool:
    """Whether this text is ONLY shell control syntax, not a request.

    T-1398. A shell never hands these bytes to the program: it consumes them
    as transport and executes a bare command with no task argument. So a
    payload made solely of redirect/pipe/sequence operators -- plus the words
    those operators bind, a redirect target or a piped command name -- is not
    user content under any spelling. Measured incident: `saipen start 2>&1`
    extracted `2>&1` as the request, the refusal named
    `saipen start --hex 323e2631`, and running that minted a real ticket
    titled `2>&1` with `user_explicit: true`. Mixed content (`fix login |
    cat`) keeps its operator bytes as ordinary characters inside a real
    request; only an operator-ONLY payload is refused, because only that one
    is pure transport.
    """
    tokens = str(payload or "").split()
    if not tokens:
        return False
    expect: str | None = None  # "target" | "command" once an operator binds one
    saw_operator = False
    for tok in tokens:
        if expect is not None:
            expect = None  # the bound word completes the unit, whatever it is
            continue
        if tok in _SHELL_SEQUENCE_OPS:
            saw_operator = True
            expect = "command"
            continue
        if _SHELL_DUP_REDIRECT.fullmatch(tok):
            saw_operator = True
            continue
        if tok == "<" or _SHELL_REDIRECT_NEXT.fullmatch(tok):
            saw_operator = True
            expect = "target"
            continue
        if _SHELL_REDIRECT_GLUED.fullmatch(tok) or _SHELL_INPUT_GLUED.fullmatch(tok):
            saw_operator = True
            continue
        return False
    return saw_operator


def ingress_payload(command: str) -> str | None:
    """The request text an ingress line carries, exactly as typed.

    `ingress_rewrite` computed this and threw it away, so the refusal could
    name a transport but never say which BYTES that transport owed. T-1372
    gives the payload a name: a refusal that records what it refused is the
    only thing that can tell the operator's request from a model's rewrite
    of it.
    """
    text = command.strip()
    head = text.split(" ", 2)
    if len(head) < 3 or head[0] != "saipen" or head[1] not in (
        command_effects.INGRESS_PAYLOAD_VERBS
    ):
        return None
    # ONE owner for "where does the request end". A quoted request ends at its
    # CLOSING quote; everything after it is transport, not words the operator
    # wrote. Stripping quotes only when the whole remainder was quoted meant a
    # single trailing `--json` made the recorded obligation undischargeable.
    from .pending_ingress import request_bytes

    payload = request_bytes(head[2])
    if not payload or len(payload) > MAX_INGRESS_REWRITE_CHARS or payload.startswith("-"):
        return None
    if shell_control_expression(payload):
        # T-1398: the shell consumes an operator-only tail as transport and
        # passes no task at all, so there is no request here to name, to
        # refuse, or to carry -- and no transport obligation may be recorded
        # over the operator's punctuation.
        return None
    return payload


def ingress_rewrite(command: str) -> str | None:
    """The exact command that carries THIS request when quoting cannot.

    A weak model must never be told to re-encode anything itself. When the
    payload of a `saipen start`/`user-request` line cannot travel literally,
    the guard computes the transport that does and names it -- `saipen start
    --hex <utf-8 hex>` -- so the next step is a command to run, not a puzzle.
    `start` is the route for both ingress verbs: it persists the identical
    request and claims it, which is what either caller wanted.
    """
    payload = ingress_payload(command)
    if payload is None:
        return None
    encoded = payload.encode("utf-8")
    if len(encoded) > MAX_INGRESS_HEX_PAYLOAD:
        return "saipen start --file <path>"
    return "saipen start --hex " + encoded.hex()


def _ingress_payload_tokens(command: str) -> list[str] | None:
    """Tokens of `saipen <ingress verb> ...` carrying ONE quoted request.

    The canonical grammar refuses every quote, which made the one operation
    whose job is to persist a user's request unreachable for any real request:
    `saipen user-request 'fix the login bug'` read as an ordinary shell effect
    and was refused behind unrelated debt. The exemption stays all-or-nothing:
    bare words keep the canonical argument alphabet, at most one token may be
    quoted, the quoted text may not start an option, may not touch another
    token, and may not carry a character any supported shell expands.
    """
    text = command.strip()
    tokens: list[str] = []
    quoted = False
    index = 0
    while index < len(text):
        char = text[index]
        if char == " ":
            index += 1
            continue
        if char in "'\"":
            end = text.find(char, index + 1)
            if quoted or end < 0:
                return None
            payload = text[index + 1 : end]
            # T-1398: quoting operator-only bytes does not make them a
            # request. The quoted form is the admitted grammar for real
            # payloads; shell control syntax stays transport, quoted or not.
            if not ingress_payload_literal(payload, char) or shell_control_expression(
                payload
            ):
                return None
            if end + 1 < len(text) and text[end + 1] != " ":
                return None
            tokens.append(payload)
            quoted = True
            index = end + 1
            continue
        end = index
        while end < len(text) and text[end] != " ":
            end += 1
        word = text[index:end]
        if not _SAIPEN_ARG_CHARS.issuperset(word):
            return None
        tokens.append(word)
        index = end
    if (
        not quoted
        or len(tokens) < 3
        or len(tokens) > _SAIPEN_MAX_TOKENS
        or tokens[0] != "saipen"
        or tokens[1] not in command_effects.INGRESS_PAYLOAD_VERBS
    ):
        return None
    return tokens


def _quoted_payload_tokens(command: str) -> list[str] | None:
    """Tokens of one canonical invocation carrying quoted payload regions (T-1386).

    A canonical command's OWN grammar decides where its payload begins and what
    those bytes ARE. ``saipen checkpoint RUN T-1 '<evidence>'`` is one bounded
    SAIPEN invocation whose final argument is text; the quoted bytes are DATA,
    so the generic shell preflight (``_PROTECTED_SHELL_SEGMENT``,
    ``destructive_shell_effects``) never reads them. Before this owner a quoted
    payload was admitted only for ``start``/``user-request``
    (``_ingress_payload_tokens``), so a checkpoint whose evidence prose named
    the protected namespace was judged an ordinary shell line and refused
    PROTECTED_CANONICAL_NAMESPACE -- repeatedly, because nothing told the
    session the prose itself was the trigger.

    The exemption stays all-or-nothing and structural:

    * every quoted region must survive ONE quoted host-shell argument
      literally (``ingress_payload_literal``: no quote characters, no
      expansion bytes in double quotes, no trailing backslash, no control
      characters), because the HOST shell does the real parsing. More than one
      region is admitted -- a session legitimately writes
      ``... '<evidence>' --project-root "<path>"`` -- and each is checked
      independently;
    * every token OUTSIDE the quotes keeps the bounded canonical alphabet, so
      ``;``, ``&&``, ``|``, ``>``, ``<``, ``$(`` or a second command line
      cannot hide behind the quotes -- real shell syntax outside the payload
      still disqualifies the whole line. The only exception is the closed
      stderr redirect set (``2>&1`` and friends): the shell consumes those
      before the program starts, so they transport nothing;
    * at most ``_SAIPEN_MAX_TOKENS`` tokens and the verb must be shell
      canonical;
    * the quoted payload is opaque beyond literalness: unlike the ingress
      grammar, operator-shaped text such as ``2>&1`` inside evidence is data,
      not transport, so it is NOT refused for that reason;
    * ingress verbs keep their own owner -- a quoted ``start``/``user-request``
      payload that is operator-only stays transport (T-1398), never a request.
    """
    text = command.strip()
    tokens: list[str] = []
    quoted = False
    index = 0
    while index < len(text):
        char = text[index]
        if char == " ":
            index += 1
            continue
        if char in "'\"":
            end = text.find(char, index + 1)
            if end < 0:
                return None
            payload = text[index + 1 : end]
            if not ingress_payload_literal(payload, char):
                return None
            if end + 1 < len(text) and text[end + 1] != " ":
                return None
            tokens.append(payload)
            quoted = True
            index = end + 1
            continue
        end = index
        while end < len(text) and text[end] != " ":
            end += 1
        word = text[index:end]
        if word not in _PROBE_SAFE_REDIRECTIONS and not _SAIPEN_PATH_ARG_CHARS.issuperset(
            word
        ):
            return None
        tokens.append(word)
        index = end
    if (
        not quoted
        or len(tokens) < 3
        or len(tokens) > _SAIPEN_MAX_TOKENS
        or tokens[0] != "saipen"
        # The ingress verbs own a stricter payload grammar (T-1398); a shortcut
        # or hush in front of one must not reach this generic one instead.
        or command_effects.routed_verb(tokens[1], tokens[2:])
        in command_effects.INGRESS_PAYLOAD_VERBS
        or not command_effects.is_shell_canonical_verb(tokens[1], tokens[2:])
    ):
        return None
    return tokens


def _windows_path_tokens(command: str) -> list[str] | None:
    """Tokens of a canonical line whose ONLY metacharacter is a literal `\`.

    MEASURED 2026-09-17, twice over. BOOT names `saipen start --file <path>` as
    the transport for a request the shell cannot carry, T-1380 made the refusal
    print that command with the declared task file's real path -- and on this
    platform that path is `V:\_TEMP_\...`, whose backslashes put the whole line
    in `_SHELL_SYNTAX_CHARS`. The guard then read the canonical entry command as
    an ordinary shell effect and refused it NO_ACTIVE_WORK. A field session ran
    the exact printed command twice and was refused twice.

    `shlex.split` is not usable here: it eats the separators. The line is split
    on whitespace, and it qualifies only when no OTHER shell metacharacter is
    present and no backslash precedes a character a shell would turn into
    another effect (`_backslashes_are_literal`), so `saipen recover && rm -rf x`
    and `saipen start --file a\$b` stay ordinary shell effects. This decides
    what the guard ADMITS, not what arrives: Git Bash still consumes an unquoted
    backslash, which is why the engine prints the path double-quoted
    (`operator_task.file_route`).
    """
    if "\\" not in command:
        return None
    if any(char in _SHELL_SYNTAX_CHARS and char != "\\" for char in command):
        return None
    if not _backslashes_are_literal(command):
        return None
    return command.split()


def _saipen_cli_tokens(command: str) -> list[str] | None:
    """Canonical `saipen <verb>` recognition over the WHOLE command line.

    The exemption is granted only when the entire shell expression is one
    bounded SAIPEN invocation: closed verb vocabulary (exact token equality),
    bounded argument alphabet, and no shell control syntax anywhere in the
    line. A compound expression -- chaining, pipeline, redirection, command
    substitution, subshell, background job, quoting/escaping, glob or a second
    newline-separated command -- is an ordinary SHELL effect for the whole
    line, so `saipen recover && rm -f .saipen/STATE.md` can never inherit the
    canonical recovery exemption. The quoted forms admitted are an INGRESS
    request payload (`_ingress_payload_tokens`; operator-only text stays
    transport, T-1398) and quoted literal payload regions of any other
    shell-canonical verb (`_quoted_payload_tokens`, T-1386: `saipen checkpoint
    RUN T-1 '<evidence>'` is judged by its own grammar, and its payload bytes
    are data).
    """
    if not isinstance(command, str) or not command.strip():
        return None
    if any(char in _SHELL_SYNTAX_CHARS for char in command):
        tokens = _windows_path_tokens(command)
        if tokens is None:
            ingress_tokens = _ingress_payload_tokens(command)
            if ingress_tokens is not None:
                return ingress_tokens
            # T-1386: the canonical grammar decides where the payload begins;
            # quoted payload bytes are data. Lines whose shell syntax sits
            # OUTSIDE the quotes still fail this recognizer and stay ordinary
            # shell effects.
            return _quoted_payload_tokens(command)
    else:
        try:
            tokens = shlex.split(command)
        except ValueError:
            return None
    if not tokens or len(tokens) > _SAIPEN_MAX_TOKENS:
        return None
    if tokens[0] != "saipen":
        # Path-routed (`./saipen`), environment-prefixed (`FOO=1 saipen`) and
        # wrapper invocations (`bash -lc 'saipen ...'`) are never canonical.
        return None
    for token in tokens:
        if not token or not _SAIPEN_PATH_ARG_CHARS.issuperset(token):
            return None
    if len(tokens) > 1 and not command_effects.is_shell_canonical_verb(tokens[1], tokens[2:]):
        return None
    return tokens


def saipen_line_problem(command: str | None) -> tuple[str, str | None] | None:
    """Why a line that starts with `saipen` is not a canonical operation, with
    the corrected command when the verb is a near miss (T-1401); None for a
    canonical line or one that does not start with `saipen`."""
    if not isinstance(command, str) or _saipen_cli_tokens(command) is not None:
        return None
    words = command.strip().split()
    if not words or words[0] != "saipen":
        return None
    if len(words) > 1 and not words[1].startswith(("-", "'", '"')):
        verb = words[1]
        if not command_effects.is_shell_canonical_verb(verb, words[2:]):
            import difflib

            close = difflib.get_close_matches(
                verb, sorted(command_effects.SHELL_CANONICAL_VERBS), n=1, cutoff=0.75
            )
            reason = f"`saipen {verb}` is not a canonical SAIPEN operation: {verb!r} is not a verb"
            if not close:
                return reason + " (`saipen --help` prints the grammar)", "saipen --help"
            corrected = " ".join(["saipen", close[0], *words[2:]])
            # A route is run verbatim: the correction is offered only when it
            # is itself ONE canonical operation. `saipen statuz && rm -rf x`
            # must never come back as `saipen status && rm -rf x`.
            if _saipen_cli_tokens(corrected) is None:
                return (
                    reason + f"; did you mean `saipen {close[0]}`? The rest of the line "
                    "is not part of one canonical operation either; run the saipen "
                    "command alone",
                    None,
                )
            return reason + f"; did you mean `saipen {close[0]}`?", corrected
    return (
        "the line starts with `saipen` but is not ONE canonical operation -- shell "
        "syntax outside a quoted payload, a path-routed launcher or its length took "
        "it outside the grammar; run the saipen command alone",
        None,
    )


def _saipen_cli_verb(command: str) -> str | None:
    tokens = _saipen_cli_tokens(command)
    if tokens is None:
        return None
    if len(tokens) == 1:
        return "bare"
    # `saipen --help` / `saipen -h` are the help verb: a usage probe whose
    # first token is a flag must not fall out of the canonical grammar and be
    # judged as an ordinary shell effect behind whatever the project owes.
    return "help" if tokens[1] in command_effects.HELP_TOKENS else tokens[1]


# ---- T-1363: provably read-only shell probes ---------------------------------
#
# Native `read` of `.saipen/STATE.md` is diagnostic access; `Test-Path
# '.saipen/MANIFEST.json'` asked the same question and was refused as
# PROTECTED_CANONICAL_NAMESPACE because the text named the namespace. One
# question, two answers, and the model spent its turn working around the
# refusal. A shell line earns the read class only when EVERY simple command in
# it is a verb from this closed set, nothing is substituted, redirected into a
# file, wrapped, evaluated or scripted, and nothing names a verb outside it.
_READ_ONLY_SHELL_VERBS = frozenset(
    {
        # PowerShell cmdlets and their stock aliases
        "test-path",
        "get-content",
        "gc",
        "type",
        "get-childitem",
        "gci",
        "dir",
        "ls",
        "get-item",
        "gi",
        "resolve-path",
        "rvpa",
        "split-path",
        "select-string",
        "sls",
        "measure-object",
        "measure",
        "select-object",
        "select",
        "format-list",
        "fl",
        "format-table",
        "ft",
        "get-filehash",
        "get-date",
        "get-location",
        "get-process",
        "gps",
        "get-command",
        "gcm",
        "write-output",
        "echo",
        # cmd.exe
        "ver",
        "tasklist",
        # POSIX
        "whoami",
        "hostname",
        "date",
        "uname",
        "id",
        "ps",
        "which",
        "where",
        "cat",
        "head",
        "tail",
        "wc",
        "stat",
        "grep",
        "pwd",
        "realpath",
        "basename",
        "dirname",
        "git",
    }
)
#: T-1402: reporters that also have a SETTING form, admitted only in the
#: reporting one. `hostname NAME` and `hostname -F FILE` set the host name;
#: `date -s ...`, `date --set=...` and `date MMDDhhmm` set the clock. Every
#: word must be a reporting flag (or, for `date`, a `+FORMAT`).
_REPORTING_ONLY_FLAGS = {
    "hostname": frozenset(
        {"-f", "--fqdn", "--long", "-s", "--short", "-d", "--domain", "-i",
         "--ip-address", "-I", "--all-ip-addresses", "-A", "--all-fqdns"}
    ),
    "date": frozenset({"-u", "--utc", "--universal", "-R", "--rfc-email", "-I",
                       "--iso-8601", "/t", "/T"}),
}


def _reporting_args(verb: str, args: list[str]) -> bool:
    allowed = _REPORTING_ONLY_FLAGS.get(verb)
    if allowed is None:
        return True
    return all(
        word in allowed
        or (verb == "date" and (word.startswith("+") or re.fullmatch(r"-I[a-z]+", word)))
        for word in args
    )


#: git subcommands that only report. No `-c` override is accepted in front of
#: them, and no option that writes a file or runs an external program.
_READ_ONLY_GIT = frozenset(
    {"rev-parse", "status", "log", "show", "ls-files", "diff", "blame", "cat-file"}
)
_GIT_WRITING_OPTIONS = ("--output", "--ext-diff", "--textconv", "-o")
#: Structure that can compute, call or script something the verb check never
#: sees -- variables, subexpressions, script blocks, type literals, splatting
#: -- and every redirection character. `cat a>b` tokenizes as one word, so a
#: redirection is refused by its character, never by recognizing its shape.
_PROBE_FORBIDDEN_TEXT = frozenset("$`(){}[]@%<>")
#: The only redirections a probe may carry: discarding or merging error output.
_PROBE_SAFE_REDIRECTIONS = frozenset({"2>$null", "2>/dev/null", "2>nul", "2>&1"})


def _read_only_git(args: list[str]) -> bool:
    if args[:1] == ["-C"] and len(args) >= 2:
        args = args[2:]
    if not args or args[0] not in _READ_ONLY_GIT:
        return False
    return not any(
        word == option or word.startswith(option + "=")
        for word in args[1:]
        for option in _GIT_WRITING_OPTIONS
    )


#: T-1432 / T-1402: bounded runtime/version probes a protocol-assigned
#: verification gate runs (`node --version`, `python --version`). The authority
#: is the CLOSED tool set plus a version-only argument grammar -- never a
#: substring search for `--version`, which any consequential command could
#: carry while doing something else.
_RUNTIME_PROBE_TOOLS = frozenset(
    {
        "python",
        "python3",
        "py",
        "node",
        "npm",
        "npx",
        "pip",
        "pip3",
        "ruff",
        "pwsh",
        "powershell",
        "cmd",
    }
)
_VERSION_ONLY_FLAGS = frozenset({"--version", "-V", "-v"})
#: `-v` means verbose for the Python family (`python -v` reads stdin as a REPL
#: rather than answering a version question), so those admit only the explicit
#: version flags.
_VERBOSE_AMBIGUOUS_TOOLS = frozenset({"python", "python3", "py"})


def _version_probe_args(verb: str, args: list[str]) -> bool:
    """True when the arguments are exactly a bounded version query."""
    if not args:
        return False
    allowed = _VERSION_ONLY_FLAGS - (
        {"-v"} if verb in _VERBOSE_AMBIGUOUS_TOOLS else set()
    )
    return all(word in allowed for word in args)


def provably_read_only_shell(command: str) -> bool:
    """True only when the whole line is a closed-set read-only probe."""
    if not isinstance(command, str) or not command.strip():
        return False
    stripped = command
    for token in _PROBE_SAFE_REDIRECTIONS:
        stripped = stripped.replace(" " + token, " ")
    if any(char in _PROBE_FORBIDDEN_TEXT for char in stripped):
        return False
    segments, nested = _shell_segments(stripped)
    if nested or not segments:
        return False
    for segment, _piped in segments:
        words = _shell_words(segment)
        if not words:
            return False
        # The verb is the bare name exactly: `_shell_verb` forgives a directory
        # and an executable suffix, and `./cat.ps1` or `C:\tmp\git.exe` is
        # whatever program sits at that path, not the read-only command.
        verb = words[0].lower()
        if verb != _shell_verb(words[0]) or (
            verb not in _READ_ONLY_SHELL_VERBS and verb not in _RUNTIME_PROBE_TOOLS
        ):
            return False
        if verb == "git":
            if not (
                _read_only_git(words[1:]) or _version_probe_args("git", words[1:])
            ):
                return False
        elif verb in _RUNTIME_PROBE_TOOLS:
            if not _version_probe_args(verb, words[1:]):
                return False
        elif not _reporting_args(verb, words[1:]):
            return False
    return True


def map_event(event: dict) -> dict:
    """Map a validated event onto the admission action/effect model.

    Returns ``{"action", "target_path", "target_paths", "targets_unresolved",
    "shell_protected_namespace", "shell_effects", "shell_effects_unresolved",
    "actor", "host", "event", "tool_name", "cwd", "session_id", "saipen_verb",
    "detail"}``.
    The ACTION decides nothing by itself; `admission.evaluate_admission`
    decides -- and it decides over EVERY target, refusing if any is refused.

    An ordinary shell command carries its resolved destructive effects
    (`destructive_shell_effects`) in `shell_effects`, so the host-event path
    hands admission the same effect a native delete or move would declare.
    Without them the guard judged `rm -rf .` on nothing but the absence of the
    literal text `.saipen` and admitted it.
    """
    tool = _tool_identity(event["tool_name"])
    tool_input = event.get("tool_input", {})
    actor = event.get("actor") or None
    targets, targets_unresolved = _extract_targets(tool_input)
    detail = ""
    verb: str | None = None
    command_class: str | None = None
    ingress_route: str | None = None
    action: str
    shell_protected_namespace = False
    shell_namespace_targets: list[str] | None = None
    shell_effects: list[dict] = []
    shell_effects_unresolved: str | None = None

    if tool in _READ_TOOLS:
        action = "read"
    elif tool == "todowrite" and event["host"].lower() == "opencode":
        # Verified OpenCode builtin: updates host/session-local Todo state in
        # OpenCode's own database and has no project or canonical-path effect.
        # Exact host + exact identity only; namespaced/lookalike Todo tools
        # remain unclassified consequential effects below.
        action = "read"
        detail = "exact OpenCode session-local Todo update; no project effect"
    elif tool in _PROCESS_CONTROL_TOOLS:
        # Reviewed Kiro translation (T-1317 Target A): consequential process
        # control with no trustworthy target set. Fail closed BEFORE host
        # execution via the admission TARGET_UNRESOLVED refusal; the healthy
        # protocol state must never clear it.
        action = "unknown"
        targets_unresolved = True
        detail = (
            f"process-control tool event '{event['tool_name']}': consequential "
            "effect with no trustworthy target set; refused before execution"
        )
    elif tool == "task" and event["host"].lower() == "opencode":
        action = "delegate"
        detail = "exact OpenCode task delegation; child tool effects require their own admission"
    elif tool in _SHELL_TOOLS:
        command = tool_input.get("command") if isinstance(tool_input.get("command"), str) else None
        cli_tokens = _saipen_cli_tokens(command) if command else None
        verb = _saipen_cli_verb(command) if cli_tokens is not None else None
        if verb is None and command:
            # T-1363: an ingress line whose payload no shell can carry
            # literally still has an exact transport. Compute it here, beside
            # the parser that rejected the payload, so the refusal downstream
            # can name a command instead of a rule.
            ingress_route = ingress_rewrite(command)
        if verb is not None:
            action = "saipen_op"
            command_class = command_effects.classify_tokens(cli_tokens)
            detail = f"canonical saipen operation ({verb}, {command_class})"
        elif command and provably_read_only_shell(command):
            # T-1363: the same answer native `read` gets. No target is
            # invented; the closed verb set is the proof, not a path list.
            action = "read"
            detail = "provably read-only shell probe"
        else:
            action = "shell"
            if not command or not command.strip():
                targets_unresolved = True
                detail = "shell tool supplied no inspectable command line"
            else:
                if _PROTECTED_SHELL_SEGMENT.search(command):
                    # Shell preflight covers the whole .saipen namespace, whereas
                    # structured target protection remains its narrower canonical
                    # path list. Carry the finding separately: no fake file target.
                    shell_protected_namespace = True
                    # T-1387: the paths named, for admission to canonicalize.
                    shell_namespace_targets = shell_namespace_paths(command, event["cwd"])
                    detail = (
                        "shell command explicitly references the protected .saipen namespace"
                    )
                resolved = destructive_shell_effects(command, event["cwd"])
                shell_effects = resolved["effects"]
                shell_effects_unresolved = resolved["unresolved"]
                if not detail and (shell_effects or shell_effects_unresolved):
                    detail = (
                        "shell command carries destructive filesystem effects; each is "
                        "judged as the file effect it is"
                    )
    elif tool in _WRITE_TOOLS:
        action = "write"
    elif tool in _DELETE_TOOLS:
        action = "delete"
    elif tool in _MOVE_TOOLS:
        action = "move"
    else:
        # Unknown tool events are potentially mutating (T-1317 Target A:
        # admission refuses them on a bound project even when the protocol
        # state is healthy); a recognizable path argument is still classified
        # so protected/traversal shapes stay visible to admission.
        action = "unknown"
        detail = (
            f"unknown tool event '{event['tool_name']}': unclassified "
            "consequential effect, refused unless a reviewed translation names it"
        )

    if action in ("write", "delete", "move") and not targets:
        # A mutating file-oriented tool that cannot name its target is not an
        # ordinary healthy mutation: admission fails closed on the empty set.
        targets_unresolved = True
    if action == "move" and len(targets) < 2:
        # BOTH endpoints of a move/rename are consequential, so a move that
        # names only one side cannot be classified from the other side's
        # shape: an unnamed destination could be protected state.
        targets_unresolved = True

    if command_class is None:
        # CMD-EFFECT-01: only a read is diagnostic outside the canonical
        # grammar; every other host effect is ordinary execution. The one
        # exception is a line that IS an ingress attempt and failed only on
        # transport: it is refused below with its exact replacement command, so
        # making it pay Fleet preparation would run recovery for a request
        # that never executes -- the precise shape of the bug T-1363 closes.
        command_class = (
            command_effects.INGRESS
            if ingress_route
            else command_effects.DIAGNOSTIC
            if action == "read"
            else command_effects.EXECUTION
        )

    return {
        "command_class": command_class,
        "fleet_preflight": command_effects.fleet_preflight_required(command_class),
        "canonical_next_command": ingress_route,
        "action": normalize_action(action),
        "target_path": targets[0] if targets else None,
        "target_paths": targets,
        "targets_unresolved": targets_unresolved,
        "shell_protected_namespace": shell_protected_namespace,
        "shell_namespace_targets": shell_namespace_targets,
        "shell_effects": shell_effects,
        "shell_effects_unresolved": shell_effects_unresolved,
        "actor": actor,
        "host": event["host"],
        "event": event["event"],
        "tool_name": event["tool_name"],
        "cwd": event["cwd"],
        # T-1384 slice 1 -- WITNESS ONLY, decides nothing. The adapter has
        # carried `session_id` from `input.sessionID` since T-1318
        # (saipen-guard.js:625) and the mapping dropped it, so no measurement
        # could ever show whether the host supplies it on every consequential
        # tool event. A binding built on a field nobody has watched arrive is
        # a guess; echoing it first makes the carrier provable before anything
        # depends on it. Absent stays None -- never a fabricated identity.
        "session_id": event.get("session_id") or None,
        "saipen_verb": verb,
        "detail": detail,
    }


#: Refusals an ingress transport route may never re-label: they are facts
#: about the TARGET or the ACTOR, not about how the text travelled.
_INTRINSIC_REFUSALS = frozenset(
    {
        "PROTECTED_CANONICAL_NAMESPACE",
        "PATH_ESCAPES_PROJECT",
        "TARGET_UNRESOLVED",
        "PROJECT_BINDING_INVALID",
        "PROJECT_LINEAGE_MISMATCH",
        "PROJECT_BINDING_AMBIGUOUS",
        "OWNERSHIP_CONFLICT",
    }
)


def _record_pending_ingress(event: dict, project_root: str | None, mapped: dict) -> None:
    """Remember WHICH bytes this transport refusal refused (T-1372).

    A refusal that names a command but not the request it owes is how a
    paraphrase bought an `exact` receipt in the field. Recording is
    best-effort by design: the guard is a classifier, and a project it cannot
    resolve or a disk it cannot write is not a reason to turn a transport
    refusal into a crash.
    """
    from .paths import resolve_project_root
    from .pending_ingress import record

    payload = ingress_payload(
        (event.get("tool_input") or {}).get("command")
        if isinstance((event.get("tool_input") or {}).get("command"), str)
        else ""
    )
    if not payload:
        return
    try:
        resolved = resolve_project_root(
            Path(event["cwd"]) if event.get("cwd") else None,
            explicit=project_root,
            honor_environment=False,
        )
    except (OSError, ValueError):
        return
    root = getattr(resolved, "root", None)
    if root is None:
        return
    record(root, payload, str(mapped["canonical_next_command"]))


def evaluate_event(event: dict, project_root: str | None = None) -> dict:
    """One host event -> one admission verdict carrying its mapped event.

    The guard CLI and every in-process caller share this, so the effect class a
    host consumes (`event.command_class`, `event.fleet_preflight`) is always the
    class the verdict was computed with.
    """
    from .admission import effective_strength, evaluate_admission

    mapped = map_event(event)
    verdict = evaluate_admission(
        event["cwd"] if not project_root else None,
        target_path=mapped["target_path"],
        action=mapped["action"],
        agent=mapped["actor"],
        explicit_root=project_root,
        target_paths=mapped["target_paths"],
        targets_unresolved=mapped["targets_unresolved"],
        shell_protected_namespace=mapped["shell_protected_namespace"],
        shell_namespace_targets=mapped["shell_namespace_targets"],
        shell_effects=mapped["shell_effects"],
        shell_effects_unresolved=mapped["shell_effects_unresolved"],
        session_id=mapped["session_id"],
    )
    if mapped.get("canonical_next_command"):
        # T-1363: an ingress line whose payload cannot travel literally is not
        # admitted as an ordinary shell effect. Running it would hand the
        # shell a request it mangles (or cannot parse) and hand the model no
        # route; refusing it names the exact transport that carries these
        # bytes. An intrinsic refusal keeps its own code and gains the route.
        verdict["canonical_next_command"] = mapped["canonical_next_command"]
        verdict["ingress_transport"] = "hex"
        if verdict.get("code") not in _INTRINSIC_REFUSALS:
            # Whatever ordinary admission made of the line, the answer the
            # caller needs is the transport: the ingress itself is reachable,
            # these bytes are not. An intrinsically forbidden effect keeps its
            # own code -- recovery cannot make such a payload safe, and the
            # route would read as a way around it.
            verdict["admitted"] = False
            verdict["code"] = "INGRESS_TRANSPORT_UNSAFE"
            _record_pending_ingress(event, project_root, mapped)
            route = str(verdict["canonical_next_command"])
            verdict["detail"] = (
                "the request text cannot survive one quoted shell argument "
                "unchanged; run the command in canonical_next_command instead"
                + (
                    ". Write the task text VERBATIM to a UTF-8 file with your own "
                    "write/edit tool -- no shell, so no quoting to get wrong -- then "
                    "run that command with the file's project-relative path"
                    if route.endswith("--file <path>")
                    else ""
                )
            )
    if not verdict.get("admitted") and mapped["action"] == "shell":
        # T-1401: a line that starts with `saipen` but is outside the canonical
        # grammar was judged an ordinary shell effect, so a typo (`saipen
        # statuz`) was told "consequential mutation requires ... DOING Work"
        # -- a rule about something the line never tried. Say what the
        # grammar refused, and the spelling it most likely meant.
        tool_input = event.get("tool_input") if isinstance(event.get("tool_input"), dict) else {}
        grammar = saipen_line_problem(tool_input.get("command"))
        if grammar is not None:
            reason, corrected = grammar
            verdict["detail"] = f"{reason}; {verdict.get('detail') or ''}".rstrip("; ")
            if corrected:
                verdict["canonical_next_command"] = corrected
    verdict["event"] = {
        "event": mapped["event"],
        "host": mapped["host"],
        "cwd": mapped["cwd"],
        "tool_name": mapped["tool_name"],
        "action": mapped["action"],
        "command_class": mapped["command_class"],
        "fleet_preflight": mapped["fleet_preflight"],
        "target_path": mapped["target_path"],
        "target_paths": mapped["target_paths"],
        "targets_unresolved": mapped["targets_unresolved"],
        "shell_protected_namespace": mapped["shell_protected_namespace"],
        "shell_effects": mapped["shell_effects"],
        "shell_effects_unresolved": mapped["shell_effects_unresolved"],
        "actor": mapped["actor"],
        "saipen_verb": mapped["saipen_verb"],
        "detail": mapped["detail"],
    }
    if isinstance(event.get("session_id"), str):
        # Host session identity is DIAGNOSTIC context, never an actor binding.
        verdict["event"]["session_id"] = event["session_id"]
    verdict["strength"] = effective_strength(mapped["host"])
    return verdict
