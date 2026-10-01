from pathlib import Path
import hashlib
import json
import os
import subprocess

root = Path(__file__).resolve().parents[2]
repo = root / 'zcode'
out = root / '.saipen/evidence/T-142-regression'
out.mkdir(parents=True, exist_ok=True)
baseline = 'e90914815ad3c607132cc6aafeea0a106f848cb4'
cases = [
    ('appearance', 'packages/ui/src/zaicode/zaicodeModelAppearance.ts', 'packages/ui/test/zaicodeT142Appearance.test.ts', 'ZAICODE_T142_APPEARANCE_SUBJECT'),
    ('start', 'packages/ui/src/prompt-editor/ZaicodeSaipenControls.tsx', 'packages/ui/test/zaicodeT142Start.test.ts', 'ZAICODE_T142_START_SUBJECT'),
    ('sidebar', 'packages/ui/src/WorkspaceSidebar.tsx', 'packages/ui/test/zaicodeT142Sidebar.test.ts', 'ZAICODE_T142_SIDEBAR_SUBJECT'),
]
receipts = []
for name, source, test, variable in cases:
    old = subprocess.check_output(['git', 'show', f'{baseline}:{source}'], cwd=repo)
    before = out / f'{name}-before{Path(source).suffix}'
    before.write_bytes(old)
    test_relative = str(Path(test).relative_to('packages/ui')).replace('\\', '/')
    command = ['pnpm.cmd', '--filter', '@zcode/ui', 'exec', 'node', '--import', 'tsx', '--test', test_relative]
    env = os.environ.copy()
    temporary = repo / 'packages/ui/src/zaicode/zaicodeModelAppearance.T142-before.ts'
    created_temporary = False
    try:
        if name == 'appearance':
            if temporary.exists():
                raise RuntimeError('Refusing to overwrite existing regression subject')
            temporary.write_bytes(old)
            created_temporary = True
            env[variable] = temporary.as_uri()
        else:
            env[variable] = str(before)
        red = subprocess.run(command, cwd=repo, env=env, capture_output=True)
        (out / f'{name}-before.log').write_bytes(red.stdout + red.stderr)
    finally:
        if created_temporary and temporary.exists():
            temporary.unlink()
    green = subprocess.run(command, cwd=repo, capture_output=True)
    (out / f'{name}-after.log').write_bytes(green.stdout + green.stderr)
    receipt = dict(name=name, verifier=hashlib.sha256((repo/test).read_bytes()).hexdigest(), before=hashlib.sha256(old).hexdigest(), after=hashlib.sha256((repo/source).read_bytes()).hexdigest(), beforeExit=red.returncode, afterExit=green.returncode)
    receipts.append(receipt)
    assert red.returncode != 0 and green.returncode == 0, receipt
pixel = 'packages/ui/src/zaicode/zaicodePixelSnap.ts'
(out / 'pixels-before.ts').write_bytes(subprocess.check_output(['git', 'show', f'{baseline}:{pixel}'], cwd=repo))
(out / 'start-before.tsx').write_bytes(subprocess.check_output(['git', 'show', f'{baseline}:packages/ui/src/prompt-editor/ZaicodeSaipenControls.tsx'], cwd=repo))
(out / 'receipts.json').write_text(json.dumps(receipts, indent=2), encoding='utf-8')
print(json.dumps(receipts))
