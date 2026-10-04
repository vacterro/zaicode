import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '../..');
const product = join(root, 'zcode');
const evidence = join(root, '.saipen/evidence');
const read = name => JSON.parse(readFileSync(join(evidence, name), 'utf8'));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const unit = read('T-208-regression-pair.json');
const wiring = read('T-208-wiring-pair.json');
const red = read('T-208-packaged-red.json');
const green = read('T-208-packaged-green.json');
const subject = read('T-208-subject-final.json');
assert.equal(unit.verifier, sha(join(product, 'packages/ui/test/zaicodeT208LivePresets.test.ts')));
assert.equal(wiring.verifier, sha(join(product, 'packages/ui/test/zaicodeT208PresetWiring.test.ts')));
for (const pair of [unit, wiring]) {
  assert.equal(pair.red.exit, 1);
  assert.equal(pair.green.exit, 0);
  assert.equal(pair.restored, true);
}
assert.equal(red.verifier, green.verifier);
assert.equal(green.verifier, sha(join(evidence, 'T-208-packaged.cjs')));
assert.equal(red.pass, false);
assert.ok(red.checks.some(check => check.name === 'zaicodeSounds: application, renderer and runtime stay attached' && check.pass));
assert.ok(red.checks.some(check => check.name === 'zaicodeNotifications: application, renderer and runtime stay attached' && !check.pass));
assert.equal(green.pass, true);
assert.equal(green.mainNavigations, 0);
const gates = ['typecheck', 'lint', 'architecture', 'tests', 'build', 'bundle'].map(kind => read(`T-208-${kind}-pass2.json`));
for (const gate of gates) {
  assert.equal(gate.exit, 0, gate.kind);
  assert.deepEqual(gate.sourceChanges, [], gate.kind);
}
for (const [ownership, paths] of Object.entries({ owned: subject.owned, foreign: subject.foreign })) {
  for (const [path, hash] of Object.entries(paths)) assert.equal(sha(join(product, path)), hash, `${ownership}: ${path}`);
}
const totals = {};
const log = readFileSync(join(evidence, 'T-208-tests-pass2.txt'), 'utf8');
for (const kind of ['tests', 'pass', 'fail', 'skipped']) {
  totals[kind] = [...log.matchAll(new RegExp(`ℹ ${kind} (\\d+)`, 'g'))].reduce((sum, match) => sum + Number(match[1]), 0);
}
assert.equal(totals.fail, 0);
assert.ok(totals.pass > 1400);
const boot = JSON.parse(readFileSync(join(product, 'packages/desktop/.release-work/t208-pass2-20261004/boot-receipt.json'), 'utf8'));
assert.equal(boot.ok, true);
const report = `# T-208 verification\n\nSource: SRC-142. Base: ${subject.base}. Frozen scope: ${Object.keys(subject.owned).length} owned paths; ${Object.keys(subject.foreign).length} foreign paths preserved byte-for-byte.\n\n- Original frozen regression: four tests red on restored pre-fix source, four green after; verifier ${unit.verifier}.\n- Owner wiring regression: two tests red on restored pre-correction source, two green after; verifier ${wiring.verifier}.\n- Full suite: ${totals.tests} collected, ${totals.pass} pass, ${totals.skipped} inherited skips, ${totals.fail} fail. Typecheck, lint (162 warnings, zero errors), architecture (zero violations), build and bundle exit zero; no source changed during gates.\n- Packaged oracle ${green.verifier}: ${green.checks.length} green checks; same oracle detects the old Notifications renderer reload after a positive Sounds and worker control.\n- All ten preset families preserve app PID ${green.before.appPid}, renderer PID ${green.before.rendererPid}, utility runtime PIDs, worker PID ${green.before.worker.pid}, run marker/start and final result. Draft, selected project, timer identity/deadline/cycles and notification flags remain coherent; zero renderer navigation.\n- Fresh package ${green.executablePath}; asar SHA256 ${green.appAsarSha256}. Boot gate opens ${boot.checks.settingsSections} Settings sections and draws ProTrail on ${boot.checks.protrail.monitors} monitors without renderer/console errors.\n\n## Oracle preparation\n\nEarlier packaged preparation used a hidden Dispatch control, a radio misidentified as a button, early keyboard input, and the legacy Hotkeys navigation id. These were instrument failures and supplied no product verdict. The notification flag seed was also corrected from a rejected JSON boolean to the schema-required serialized string. Each final oracle revision receives a fresh pre-fix run; no old-version red is spent on the final green. The original four-test verifier remains unchanged.\n\n## Section owner audit\n\n| Family | Existing owners refreshed |\n| --- | --- |\n| Sounds | Event sounds, audio, picker preferences |\n| Notifications | Notification settings and existing StoreProvider task flags |\n| Colors | Color studio, diamond preferences, appearance |\n| ProTrail | Existing ProTrail config owner |\n| Timers | Preference commands preserving live countdown, alarms and schedules |\n| Hotkeys | Existing hotkey owner; preset menu follows merged Shortcuts route |\n| Sidebar | Existing sidebar preferences and title alignment |\n| Layout | Layout, UI, composer, home and window-zone preferences |\n| Workers | Worker view preferences and dispatch preferences; runtime records untouched |\n| Engines | Meter preferences and style; account/runtime ownership untouched |\n\nHighlights/motion, Session text and SAIASUI presets use their existing store commands; source audit found no renderer reload in those paths. Profile selection/import belongs to the separate footer Profiles menu and is not called by Settings presets. No profile-switch publication is claimed here.\n\nREVIEW and publication remain pending.\n`;
writeFileSync(join(evidence, 'T-208-verification.md'), report);
writeFileSync(join(evidence, 'T-208-verification.json'), JSON.stringify({ at: new Date().toISOString(), totals, owned: Object.keys(subject.owned).length, foreign: Object.keys(subject.foreign).length, packagedChecks: green.checks.length, verifier: green.verifier, asar: green.appAsarSha256 }, null, 2));
console.log(JSON.stringify({ totals, packagedChecks: green.checks.length, owned: Object.keys(subject.owned).length, foreign: Object.keys(subject.foreign).length }));
