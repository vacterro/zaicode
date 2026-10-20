#!/usr/bin/env python3
"""Page-parity check for a ready saiwiki package.

The OUTBOX grammar (`saipen outbox check <role>`) proves the package is
well-FORMED. It cannot prove that the pages are the pages the package claims:
a page rebuilt by position, a page whose marker names a different source
triple, or a payload entry that does not exist all pass the grammar.

This script closes that gap for this instance. It reads the FIRST `status:
ready` package in `kitchen/OUTBOX.md` and checks the artifact against the
package's own claims:

  1. every `payload` entry resolves to an existing file;
  2. every payload CONTENT page (a name not starting with `_`) carries exactly
     one mirror marker on line 1, and that marker's `package`, `page`,
     `source_head`, `source_tree_fingerprint` and `role_revision` equal the
     package's fields;
  3. every payload content page ends with a `## Source binding` section;
  4. every path in the marker's `sources=` list exists in the project;
  5. `_Sidebar.md` (navigation) links exactly the payload's content pages;
  6. a navigation page (`_Footer.md`) may carry a marker too -- if it does, its
     identity values must still equal the package's.

Exit 0 = every check passed; exit 1 = violations, each named on its own line.
Read-only: this script writes nothing.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

MARKER_RE = re.compile(r"^<!-- saiwiki-mirror: (?P<body>.*?) -->$")
KV_RE = re.compile(r"(\S+)=(\S+)")
FIELD_RE = re.compile(r"^- \*\*(?P<name>[a-z_]+):\*\*\s*(?P<value>.*)$")
PACKAGE_RE = re.compile(r"^##\s+(?P<id>[A-Z]+-\d+):\s*(?P<title>.*)$")
SIDEBAR_LINK_RE = re.compile(r"^\*\s+\[[^\]]*\]\((?P<target>[^)]+)\)\s*$")

IDENTITY_KEYS = ("source_head", "source_tree_fingerprint", "role_revision")
REQUIRED_MARKER_KEYS = ("package", "page", "sources") + IDENTITY_KEYS


def default_paths() -> tuple[Path, Path, Path]:
    script = Path(__file__).resolve()
    instance = script.parent.parent  # <instance>/kitchen/_verify_pages.py
    project_root = instance.parents[3]  # <root>/.saipen/extensions/subs/<name>
    return project_root, instance, instance / "kitchen" / "OUTBOX.md"


def parse_ready_package(outbox: Path) -> dict[str, object]:
    packages: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    for line in outbox.read_text(encoding="utf-8").splitlines():
        heading = PACKAGE_RE.match(line)
        if heading:
            current = {"id": heading.group("id"), "fields": {}}
            packages.append(current)
            continue
        if current is None:
            continue
        field = FIELD_RE.match(line)
        if field:
            current["fields"][field.group("name")] = field.group("value").strip()
    for package in packages:
        if package["fields"].get("status") == "ready":
            return package
    raise SystemExit("FAIL no `status: ready` package in %s" % outbox)


def payload_entries(project_root: Path, instance: Path, raw: str) -> list[Path]:
    """Resolve `payload` entries: a path is project-relative, a bare name is a
    page in the instance's staging wiki directory."""
    text = raw.strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    pages_dir = instance / "kitchen" / "wiki"
    resolved: list[Path] = []
    for item in text.split(","):
        item = item.strip().strip("`").strip()
        if not item:
            continue
        candidate = Path(item)
        if candidate.is_absolute():
            resolved.append(candidate)
        elif "/" in item or "\\" in item:
            resolved.append(project_root / candidate)
        else:
            resolved.append(pages_dir / candidate)
    return resolved


def marker_kv(text: str) -> dict[str, str] | None:
    first = text.splitlines()[0] if text else ""
    marker = MARKER_RE.match(first)
    if not marker:
        return None
    return dict(KV_RE.findall(marker.group("body")))


def check_identity(
    name: str,
    kv: dict[str, str],
    fields: dict[str, str],
    project_root: Path,
    violations: list[str],
    *,
    require_page_name: bool,
) -> None:
    for key in REQUIRED_MARKER_KEYS:
        if key not in kv:
            violations.append("%s: marker is missing key %s" % (name, key))
    if kv.get("package") != fields.get("package_id"):
        violations.append("%s: marker package=%s, package id is %s" % (name, kv.get("package"), fields.get("package_id")))
    if require_page_name and kv.get("page") != name:
        violations.append("%s: marker page=%s names another page" % (name, kv.get("page")))
    for key in IDENTITY_KEYS:
        if kv.get(key) != fields.get(key):
            violations.append(
                "%s: marker %s=%s does not equal the package value %s" % (name, key, kv.get(key), fields.get(key))
            )
    sources = kv.get("sources", "")
    if not sources:
        violations.append("%s: marker carries no sources=" % name)
        return
    for source in sources.split(","):
        source = source.strip()
        if source and not (project_root / source).exists():
            violations.append("%s: source path does not exist: %s" % (name, source))


def main() -> int:
    root_default, instance_default, outbox_default = default_paths()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", default=str(root_default))
    parser.add_argument("--instance", default=str(instance_default))
    parser.add_argument("--outbox", default=str(outbox_default))
    parser.add_argument("--pages-dir", default="", help="override the payload directory (red-control runs)")
    args = parser.parse_args()

    project_root = Path(args.project_root)
    instance = Path(args.instance)
    pages_override = Path(args.pages_dir) if args.pages_dir else None

    package = parse_ready_package(Path(args.outbox))
    fields: dict[str, str] = dict(package["fields"])  # type: ignore[arg-type]
    fields["package_id"] = str(package["id"])
    violations: list[str] = []

    for key in IDENTITY_KEYS + ("payload",):
        if not fields.get(key):
            violations.append("package %s is missing required field %s" % (package["id"], key))

    payload = payload_entries(project_root, instance, fields.get("payload", ""))
    if not payload:
        violations.append("package %s has an empty payload" % package["id"])

    content_pages: list[str] = []
    marked = 0
    for path in payload:
        target = pages_override / path.name if pages_override is not None else path
        if not target.is_file():
            violations.append("payload entry missing: %s" % path)
            continue
        name = target.name
        text = target.read_text(encoding="utf-8")

        if name.startswith("_"):
            kv = marker_kv(text)
            if kv is not None:
                marked += 1
                check_identity(name, kv, fields, project_root, violations, require_page_name=False)
            continue

        content_pages.append(name)
        kv = marker_kv(text)
        if kv is None:
            violations.append("%s: line 1 is not a mirror marker" % name)
            continue
        marked += 1
        check_identity(name, kv, fields, project_root, violations, require_page_name=True)
        if "## Source binding" not in text:
            violations.append("%s: no `## Source binding` section" % name)

    sidebar = (pages_override / "_Sidebar.md") if pages_override is not None else (instance / "kitchen" / "wiki" / "_Sidebar.md")
    if not sidebar.is_file():
        violations.append("payload navigation missing: _Sidebar.md")
    else:
        linked: list[str] = []
        for line in sidebar.read_text(encoding="utf-8").splitlines():
            match = SIDEBAR_LINK_RE.match(line)
            if match and match.group("target").endswith(".md"):
                linked.append(match.group("target"))
        for name in content_pages:
            if name not in linked:
                violations.append("_Sidebar.md does not link %s" % name)
        for target in linked:
            if target not in content_pages:
                violations.append("_Sidebar.md links a page outside the payload: %s" % target)

    if violations:
        print("FAIL %d violation(s) over %d payload file(s), %d marked, package %s" % (len(violations), len(payload), marked, package["id"]))
        for violation in violations:
            print("  - %s" % violation)
        return 1
    print(
        "PASS package %s: %d payload file(s), %d marked page(s), %d content page(s), every marker matches the package identity"
        % (package["id"], len(payload), marked, len(content_pages))
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
