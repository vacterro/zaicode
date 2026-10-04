import hashlib
import json
import pathlib
import shutil
import subprocess

root = pathlib.Path(__file__).resolve().parents[2]
product = (root / 'zcode').resolve()
manifest = json.loads((root / '.saipen/evidence/T-209-subject-final.json').read_text())
target = (root / '.saipen/kitchen/failed/T-209').resolve()
assert target.is_relative_to(root / '.saipen/kitchen/failed')
assert not target.exists(), 'park already exists; inspect before retry'
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
for p, expected in manifest['owned'].items():
    assert digest(product / p) == expected, p
for p, expected in manifest['foreign'].items():
    assert digest(product / p) == expected, p
assert not subprocess.check_output(['git', 'diff', '--cached', '--name-only'], cwd=product).strip()
target.mkdir(parents=True)
tracked = []
untracked = []
for p in manifest['owned']:
    src = (product / p).resolve()
    dst = (target / 'files' / p).resolve()
    assert src.is_relative_to(product) and dst.is_relative_to(target)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    probe = subprocess.run(['git', 'ls-files', '--error-unmatch', '--', p], cwd=product, capture_output=True)
    (tracked if probe.returncode == 0 else untracked).append(p)
patch = subprocess.check_output(['git', 'diff', '--binary', '--', *tracked], cwd=product)
(target / 'T-209.patch').write_bytes(patch)
(target / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf8')
subprocess.run(['git', 'restore', '--worktree', '--', *tracked], cwd=product, check=True)
for p in untracked:
    src = (product / p).resolve()
    dst = (target / 'untracked' / p).resolve()
    assert src.is_relative_to(product) and dst.is_relative_to(target)
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.replace(dst)
for p, expected in manifest['foreign'].items():
    assert digest(product / p) == expected, p
assert not subprocess.check_output(['git', 'diff', '--name-only', '--', *tracked], cwd=product).strip()
(target / 'parked.json').write_text(json.dumps({'tracked': tracked, 'untracked': untracked, 'foreignPreserved': len(manifest['foreign'])}, indent=2))
print(json.dumps({'parked': len(tracked) + len(untracked), 'foreignPreserved': len(manifest['foreign']), 'path': str(target)}))
