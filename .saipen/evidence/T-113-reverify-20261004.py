from pathlib import Path
import json
import subprocess

root = Path(__file__).resolve().parents[2]
product = root / "zcode"
ancestry = subprocess.run(["git", "merge-base", "--is-ancestor", "d359a2a9", "HEAD"], cwd=product, capture_output=True, text=True)
assert ancestry.returncode == 0, "The published locale carrier must remain in product history"
result = subprocess.run(["C:/nodejs/node.exe", "--import", "tsx", "--test", "test/zaicodeLocaleParity.test.ts"], cwd=product / "packages/ui", capture_output=True, text=True, encoding="utf-8")
print(result.stdout + result.stderr)
print(json.dumps({"carrier_ancestor": ancestry.returncode == 0, "gate_exit": result.returncode, "command": result.args}))
raise SystemExit(result.returncode)
