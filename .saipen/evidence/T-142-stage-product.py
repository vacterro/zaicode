"""Bind only T-142's reviewed paths in the separate product repository."""
from pathlib import Path
import hashlib
import json
import subprocess

root = Path(__file__).resolve().parents[2]
repo = root / 'zcode'
scope = json.loads((root/'.saipen/kitchen/release_scope/T-142.json').read_text(encoding='utf-8'))
paths = [path.removeprefix('zcode/') for path in scope['paths'] if path.startswith('zcode/')]
assert len(paths) == 28

def git(*args):
    return subprocess.check_output(['git', *args], cwd=repo).decode('utf-8').strip()

assert git('diff', '--cached', '--name-only') == '', 'Existing staged bytes must remain untouched'
assert set(git('ls-files', '--modified', '--others', '--exclude-standard').splitlines()) == set(paths), 'Product delta is not the exact reviewed scope'
for path in paths:
    assert hashlib.sha256((repo/path).read_bytes()).hexdigest() == scope['paths']['zcode/'+path], path
saved_index = git('write-tree')
(root/'.saipen/evidence/T-142-product-index-before.txt').write_text(saved_index+'\n', encoding='utf-8')
try:
    subprocess.run(['git', 'add', '--', *paths], cwd=repo, check=True, capture_output=True)
    assert set(git('diff', '--cached', '--name-only').splitlines()) == set(paths)
    subprocess.run(['git', 'diff', '--cached', '--check'], cwd=repo, check=True)
    subprocess.run(['git', 'diff', '--exit-code', '--', *paths], cwd=repo, check=True, capture_output=True)
    staged_index = git('write-tree')
    (root/'.saipen/evidence/T-142-product-index-gate.json').write_text(json.dumps(dict(ok=True, savedIndex=saved_index, stagedIndex=staged_index, paths=paths, blobs=git('ls-files', '-s', '--', *paths)), indent=2), encoding='utf-8')
    print(json.dumps(dict(ok=True, reviewedPaths=len(paths), stagedIndex=staged_index)))
except BaseException:
    subprocess.run(['git', 'restore', '--staged', '--source', saved_index, '--', *paths], cwd=repo, check=True)
    raise
