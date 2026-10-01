from pathlib import Path
import hashlib
import json
import os
import subprocess

root = Path(__file__).resolve().parents[2]
out = root / '.saipen/evidence/T-142-regression'
skill = Path('C:/Users/vac34/.agents/skills/playwright-skill')
scripts = root / '.saipen/evidence'
results = []
for name, variable, subject in [('pixels', 'ZAICODE_PIXEL_SUBJECT', 'pixels-before.ts'), ('start-browser', 'ZAICODE_START_SUBJECT', 'start-before.tsx')]:
    verifier = scripts / ('playwright-test-zaicode-t142-pixels.js' if name == 'pixels' else 'playwright-test-zaicode-t142-start.js')
    env = os.environ.copy()
    env[variable] = str(out / subject)
    command = ['node', 'run.js', str(verifier)]
    red = subprocess.run(command, cwd=skill, env=env, capture_output=True)
    (out / f'{name}-before.log').write_bytes(red.stdout + red.stderr)
    green = subprocess.run(command, cwd=skill, capture_output=True)
    (out / f'{name}-after.log').write_bytes(green.stdout + green.stderr)
    receipt = dict(name=name, verifier=hashlib.sha256(verifier.read_bytes()).hexdigest(), before=hashlib.sha256((out/subject).read_bytes()).hexdigest(), beforeExit=red.returncode, afterExit=green.returncode)
    results.append(receipt)
    assert red.returncode != 0 and green.returncode == 0, receipt
(out/'browser-receipts.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
print(json.dumps(results))
