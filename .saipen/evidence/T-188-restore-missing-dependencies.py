"""Restore absent dependency files from the successful, locked scratch install.

Existing files, loaded native libraries, workspace junctions, and installer
metadata stay untouched. This repairs an interrupted import without stopping
the operator's application or claiming that its installer completed.
"""
import json
import os
import shutil
import stat
from pathlib import Path

workspace = Path(__file__).resolve().parents[2]
source = workspace / ".saipen/kitchen/t188-check/node_modules"
target = workspace / "zcode/node_modules"
assert source.is_dir() and target.is_dir()
assert source.resolve().is_relative_to(workspace.resolve())
assert target.resolve().is_relative_to(workspace.resolve())
copied = []
skipped_links = []
for directory, directories, files in os.walk(source, followlinks=False):
    parent = Path(directory)
    for name in directories[:]:
        child = parent / name
        if child.is_symlink() or child.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            directories.remove(name)
            skipped_links.append(str(child.relative_to(source)))
    for name in files:
        original = parent / name
        relative = original.relative_to(source)
        if relative.parts[0] in {".modules.yaml", ".pnpm", ".pnpm-workspace-state-v1.json"}:
            continue
        destination = target / relative
        if not destination.exists() and not destination.is_symlink():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, destination)
            copied.append(str(relative))
report = {"source": str(source), "target": str(target), "copied_count": len(copied),
          "copied": copied, "skipped_links": skipped_links, "overwritten_count": 0}
(workspace / ".saipen/evidence/T-188-dependency-repair-20261004.json").write_text(
    json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps({key: report[key] for key in ("copied_count", "overwritten_count")}))
