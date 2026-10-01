from pathlib import Path
import json
import os
import subprocess

root = Path(__file__).resolve().parents[2]
executable = root/'zcode/packages/desktop/dist-next/win-unpacked/ZAICODE.exe'
assert executable.is_file()
env = os.environ.copy()
env['ZAICODE_TEST_EXECUTABLE'] = str(executable)
env['ZAICODE_TEST_OUTPUT'] = str(root/'.saipen/evidence/T-142-packaged-ui')
skill = Path('C:/Users/vac34/.agents/skills/playwright-skill')
result = subprocess.run(['node', 'run.js', str(root/'.saipen/evidence/playwright-test-zaicode-t142.js')], cwd=skill, env=env, capture_output=True)
(root/'.saipen/evidence/T-142-packaged-ui.log').write_bytes(result.stdout+result.stderr)
assert result.returncode == 0, result.stderr.decode(errors='replace')
receipt = json.loads((root/'.saipen/evidence/T-142-packaged-ui/receipt.json').read_text(encoding='utf-8'))
assert receipt['ok'] is True
print(json.dumps(dict(ok=True, executable=str(executable), checks=list(receipt['checks']))))
