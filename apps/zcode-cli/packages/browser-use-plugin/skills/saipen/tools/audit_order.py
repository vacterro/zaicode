#!/usr/bin/env python3
"""No module-level name is read before the line that assigns it.

`tools/validate.py` is a 2300-line straight-line script: its checks execute in
file order, so a constant defined below its first use is a `NameError` waiting
for the one input that reaches that branch. Three of them landed in a single
day:

* `SAIPEN_COMMANDS`, declared beside its second consumer. The branch that
  reads it first only runs when `next_action` starts with `saipen `, and this
  repository's own `STATE.md` says `WAIT:` -- so every local run passed and a
  fixture caught it.
* `IS_SAIPEN_HOME`, read by a check spliced above the line that computes it.
* `saipen_dir`, a name that never existed at all.

Ruff does not catch these: the name IS defined in the module, just later, and
`F821` only reports names that are never bound. Nothing else was looking.

So this looks. It walks each module's top-level statements in order, tracking
what has been bound, and reports any read of a module-level name that happens
before its first binding. Reads inside a `def`/`class` body are skipped -- those
run when called, not where they sit, and treating them as ordered would flag
every ordinary forward reference.

Exit 0 when clean, 1 otherwise.
"""

from __future__ import annotations

import ast
import builtins
import io
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

_BUILTINS = frozenset(dir(builtins)) | {
    "__file__",
    "__name__",
    "__doc__",
    "__spec__",
    "__package__",
}


def _bound_by(node: ast.AST) -> set[str]:
    """Names this top-level statement binds."""
    out: set[str] = set()
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        out.add(node.name)
    elif isinstance(node, (ast.Import, ast.ImportFrom)):
        for a in node.names:
            out.add(a.asname or a.name.split(".")[0])
    elif isinstance(
        node,
        (
            ast.Assign,
            ast.AnnAssign,
            ast.AugAssign,
            ast.For,
            ast.AsyncFor,
            ast.With,
            ast.AsyncWith,
            ast.If,
            ast.While,
            ast.Try,
            ast.Match,
        ),
    ):
        for sub in ast.walk(node):
            if isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Store):
                out.add(sub.id)
                continue
            # Split into two locals deliberately: ruff's SIM114 wants these
            # combined with `or`, and its own autofix then produces a line
            # E501 rejects. Two names satisfy both rules instead of trading
            # one lint for the other.
            defines = isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            catches = isinstance(sub, ast.ExceptHandler) and sub.name
            if defines or catches:
                out.add(sub.name)
    return out


def _reads_outside_functions(node: ast.AST):
    """Every Name load in this statement that executes where it sits.

    A `def`/`class` body is skipped: its names resolve when called. Default
    values and decorators are NOT skipped -- those evaluate at definition time,
    which is exactly the ordering this audit is about.
    """
    # If the statement IS a def/class, only its decorators, defaults and bases
    # evaluate here -- the body (and its parameters, which are bindings, not
    # reads) resolves at call time. The first version only skipped NESTED
    # defs, so every top-level function's own parameters came back as
    # used-before-assigned.
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        stack = list(node.decorator_list)
        stack += [d for d in node.args.defaults if d]
        stack += [d for d in node.args.kw_defaults if d]
    elif isinstance(node, ast.ClassDef):
        stack = list(node.decorator_list) + list(node.bases)
    else:
        stack = [node]
    for _n in list(stack):
        if isinstance(_n, ast.Name) and isinstance(_n.ctx, ast.Load):
            yield _n
    while stack:
        cur = stack.pop()
        for child in ast.iter_child_nodes(cur):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                # decorators and defaults evaluate now; the body does not
                stack.extend(child.decorator_list)
                stack.extend(d for d in child.args.defaults if d)
                stack.extend(d for d in child.args.kw_defaults if d)
                continue
            if isinstance(child, ast.ClassDef):
                stack.extend(child.decorator_list)
                stack.extend(child.bases)
                continue
            if isinstance(child, ast.Lambda):
                # A lambda's parameters are bindings and its body runs when
                # called -- same reasoning as a def, and the reason
                # TYPE_CHECKS' five one-liners came back as five findings.
                stack.extend(d for d in child.args.defaults if d)
                stack.extend(d for d in child.args.kw_defaults if d)
                continue
            if isinstance(child, (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                # A comprehension binds its own targets in its own scope.
                for _g in child.generators:
                    stack.append(_g.iter)
                continue
            if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Load):
                yield child
            stack.append(child)


def audit(path: Path) -> list[str]:
    src = path.read_text(encoding="utf-8-sig")
    tree = ast.parse(src, filename=str(path))
    # Every name the module binds anywhere at top level. A read of something
    # never bound here is ruff's F821, not this audit's business.
    all_bound: set[str] = set()
    for stmt in tree.body:
        all_bound |= _bound_by(stmt)

    # Availability is per top-level STATEMENT, and includes what the statement
    # itself binds. Ordering inside one block is a different (and much harder)
    # analysis, and pretending to do it is what made the first version of this
    # audit report several hundred findings, none of them real: every read
    # inside a top-level `for` body was checked against the set from before the
    # loop, so the loop variable itself came back as used-before-assigned.
    # Fourth instrument in one day to fail by reporting everything.
    #
    # The defect actually being hunted is narrower and unambiguous: a name
    # whose ONLY binding is in a LATER top-level statement.
    per_stmt = [_bound_by(s) for s in tree.body]
    problems = []
    for i, stmt in enumerate(tree.body):
        available = set().union(*per_stmt[: i + 1]) if per_stmt else set()
        for name in _reads_outside_functions(stmt):
            if name.id in available or name.id in _BUILTINS:
                continue
            if name.id in all_bound:
                problems.append(
                    f"{path.as_posix()}:{name.lineno} reads {name.id!r}, which "
                    f"nothing binds until a later top-level statement"
                )
    return problems


def main() -> int:
    root = Path(__file__).resolve().parent
    targets = sorted(root.glob("*.py"))
    if not targets:
        print("SKIP: no tools/*.py found")
        return 0
    problems = []
    for t in targets:
        try:
            problems += audit(t)
        except SyntaxError as e:
            print(f"FAIL: {t.as_posix()} does not parse -- {e}")
            return 1
    if problems:
        for p in problems:
            print(f"FAIL: {p}")
        print(
            f"\n{len(problems)} module-level ordering problem(s). These are "
            f"NameErrors that only fire on the input reaching that branch, "
            f"which is why three of them survived a full local run."
        )
        return 1
    print(f"PASS: {len(targets)} tool(s) read no module-level name before assigning it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
