import re
import subprocess
import os

env = dict(os.environ)
env["SAIPEN_VALIDATE_ALL_WARNINGS"] = "1"
out = subprocess.run(
    ["python", "tools/validate.py"],
    capture_output=True, text=True, env=env, cwd=".",
)
lines = [l for l in out.stdout.splitlines() if "cross-doc drift" in l]
seen = set()
target = os.path.join(os.path.dirname(__file__), "drift-full.txt")
with open(target, "w", encoding="utf-8") as f:
    for l in lines:
        m = re.search(r"cross-doc drift \[([a-z0-9-]+)\]", l)
        if not m:
            continue
        key = m.group(1)
        if key in seen:
            continue
        seen.add(key)
        f.write("=== " + key + "\n")
        f.write(l + "\n\n")