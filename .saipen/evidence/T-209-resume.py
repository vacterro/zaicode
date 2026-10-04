import hashlib
import json
import pathlib
import shutil
import subprocess

root = pathlib.Path(__file__).resolve().parents[2]
product = (root / 'zcode').resolve()
park = root / '.saipen/kitchen/failed/T-209'
manifest = json.loads((park / 'manifest.json').read_text())
receipt = json.loads((root / '.saipen/evidence/T-212-publish.json').read_text())
assert receipt['remoteMatches']
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=product, text=True).strip() == receipt['commit']
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
paths = list(manifest['owned'])
for p, expected in manifest['foreign'].items():
    assert digest(product / p) == expected, p
tracked = json.loads((park / 'parked.json').read_text())['tracked']
assert not subprocess.check_output(['git', 'diff', '--name-only', '--', *tracked], cwd=product).strip()
assert not subprocess.check_output(['git', 'diff', manifest['base'], receipt['commit'], '--', *tracked], cwd=product).strip()
for p in json.loads((park / 'parked.json').read_text())['untracked']:
    assert not (product / p).exists(), p
for p in paths:
    src = (park / 'files' / p).resolve()
    dst = (product / p).resolve()
    assert src.is_relative_to(park.resolve()) and dst.is_relative_to(product)
    assert digest(src) == manifest['owned'][p], p
    shutil.copy2(src, dst)
for p, expected in manifest['owned'].items():
    assert digest(product / p) == expected, p
for p, expected in manifest['foreign'].items():
    assert digest(product / p) == expected, p
history = park / 'cycle-2-receipts'
assert not history.exists(), 'resume already recorded'
history.mkdir()
for name in ['subject-final', 'packaged-red', 'packaged-green', 'typecheck-final', 'lint-final', 'architecture-final', 'tests-final', 'build-final', 'bundle-final']:
    p = root / '.saipen/evidence' / ('T-209-' + name + '.json')
    shutil.copy2(p, history / p.name)
    text = p.with_suffix('.txt')
    if text.exists():
        shutil.copy2(text, history / text.name)
current = root / '.saipen/evidence/T-209-subject-final.json'
manifest['base'] = receipt['commit']
current.write_text(json.dumps(manifest, indent=2), encoding='utf8')
before = root / '.saipen/evidence/T-209-before.json'
data = json.loads(before.read_text())
data['base'] = receipt['commit']
before.write_text(json.dumps(data, indent=2), encoding='utf8')
gate = root / '.saipen/evidence/T-209-gate.mjs'
original = gate.read_text()
(history / gate.name).write_text(original, encoding='utf8')
gate.write_text(original.replace('t209-20261004', 't209-resumed-20261004').replace("'--skip-build']", "'--skip-build', '--skip-prepare']"), encoding='utf8')
print(json.dumps({'restoredUnchanged': len(paths), 'foreignPreserved': len(manifest['foreign']), 'dependencyCommit': receipt['commit']}))
