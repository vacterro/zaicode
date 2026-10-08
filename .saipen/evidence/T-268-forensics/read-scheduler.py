import datetime
import json
import pathlib
import shutil
import sys
import types

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'snappy'))
SOURCE = pathlib.Path('C:/Users/vac34/AppData/Roaming/ZAICODE/session/Local Storage/leveldb')
COPY = HERE / 'leveldb-copy'
COPY.mkdir(exist_ok=True)
for file in SOURCE.iterdir():
    if file.is_file() and (file.suffix in {'.ldb', '.log'} or file.name == 'CURRENT' or file.name.startswith('MANIFEST-')):
        shutil.copy2(file, COPY / file.name)
package = types.ModuleType('ccl_chromium_reader')
package.__path__ = [str(HERE / 'reader/ccl_chromium_reader')]
sys.modules[package.__name__] = package
from ccl_chromium_reader.ccl_chromium_localstorage import LocalStoreDb

db = LocalStoreDb(COPY)
keys = {'zaicode-autostart-v1', 'zaicode-disabled-projects-v1'}
records = sorted((r for r in db.iter_all_records() if r.script_key in keys), key=lambda r: r.leveldb_seq_number)
def time(value):
    return datetime.datetime.fromtimestamp(value / 1000, datetime.timezone.utc).isoformat() if isinstance(value, (int, float)) else None

history = []
for record in records:
    value = json.loads(record.value)
    if record.script_key == 'zaicode-disabled-projects-v1':
        summary = value
    else:
        summary = [{
            'id': j['id'], 'name': j.get('name'), 'enabled': j.get('enabled'),
            'engineId': j.get('engineId'), 'trigger': j.get('trigger'),
            'lastRunAt': time(j.get('lastRunAt')), 'lastResult': j.get('lastResult'),
            'firedEvents': j.get('firedEvents', []),
            'runs': len(j.get('runs', [])),
            'continuationRuns': [{'state': r.get('state'), 'runnerId': r.get('runnerId'), 'result': r.get('result')} for r in j.get('continuationRuns', [])]
        } for j in value]
    history.append({'sequence': record.leveldb_seq_number, 'file': record.file, 'origin': record.storage_key, 'key': record.script_key, 'value': summary})
report = {'source': str(SOURCE), 'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'records': history}
(HERE / 'scheduler-history.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
latest = {}
for record in history:
    latest[record['key']] = record
print(json.dumps({'latest': latest, 'historicalRecords': len(history)}, ensure_ascii=False, indent=2))
