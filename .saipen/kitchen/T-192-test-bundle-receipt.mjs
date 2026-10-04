import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const evidence = join(root, '.saipen/evidence');
const dist = join(root, 'zcode/packages/desktop/dist-test-20261003-t192-pass3');
const load = async path => JSON.parse(await readFile(path, 'utf8'));
const bundle = await load(join(evidence, 'T-192-bundle-pass3.json'));
const build = await load(join(evidence, 'T-192-build-pass3.json'));
const boot = await load(join(dist, 'boot-receipt.json'));
const packaged = await load(join(evidence, 'T-192-packaged-final/receipt.json'));
const native = await load(join(evidence, 'T-192-native-pass3/receipt.json'));
const unicode = await load(join(evidence, 'T-192-unicode-stop.json'));
const subject = await load(join(evidence, 'T-192-subject.json'));
if (build.exitCode !== 0 || bundle.exitCode !== 0 || !boot.ok || !packaged.pass || !native.pass) {
  throw new Error('The test candidate has not passed its build, boot and process-continuity checks.');
}
if (unicode.exitCode !== 1) throw new Error('Reassess the documented Unicode limitation before producing the receipt.');
async function describe(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { path, bytes: (await stat(path)).size, sha256: hash.digest('hex') };
}
const installer = await describe(join(dist, 'ZAICODE-3.14.0-win-x64_TEST.exe'));
const asar = await describe(join(dist, 'win-unpacked/resources/app.asar'));
if (asar.sha256 !== packaged.appAsarSha256) throw new Error('The delivered archive differs from the packaged acceptance subject.');
const receipt = {
  schema: 't192-test-preview/1', at: new Date().toISOString(), source: 'SRC-128', work: 'T-193',
  featureWork: { id: 'T-192', phase: 'BUILD', verified: false, complete: false },
  productHead: subject.head, sourceFingerprint: subject.fingerprint, installer, appAsar: asar,
  unpackedExecutable: join(dist, 'win-unpacked/ZAICODE.exe'),
  checks: {
    build: { exitCode: build.exitCode, receipt: '.saipen/evidence/T-192-build-pass3.json' },
    bundle: { exitCode: bundle.exitCode, receipt: '.saipen/evidence/T-192-bundle-pass3.json' },
    boot: { pass: boot.ok, receipt: 'zcode/packages/desktop/dist-test-20261003-t192-pass3/boot-receipt.json' },
    packaged: { pass: packaged.pass, count: packaged.checks.length, receipt: '.saipen/evidence/T-192-packaged-final/receipt.json' },
    native: { pass: native.pass, count: native.checks.length, receipt: '.saipen/evidence/T-192-native-pass3/receipt.json' },
    unicode: { pass: false, exitCode: unicode.exitCode, receipt: '.saipen/evidence/T-192-unicode-stop.json', log: '.saipen/evidence/T-192-unicode-stop.txt' },
    latestFullGate: { pass: false, receipt: '.saipen/evidence/T-192-pre-push-pass5.json', rerunAfterFinalConsoleChanges: false }
  },
  preserved: { foreignFiles: subject.foreign.length, t188Paths: subject.t188 },
  knownLimitations: [
    'Emoji input is lost by the transferred PowerShell command reader. Cyrillic input is preserved by the current console bridge. The exact cause of the remaining emoji loss is unresolved.',
    'Workers started by older builds are owned by the original app host and cannot be retroactively extracted.',
    'The full mandatory gate is not green. This is a local test preview, not a verified release.'
  ],
  published: false
};
await writeFile(join(evidence, 'T-192-test-bundle.json'), JSON.stringify(receipt, null, 2) + '\n');
const guide = `# ZAICODE test preview — T-192 / SRC-128

This bundle lets you test moving a running internal CLI worker into a separate Windows PowerShell window. The current process continues there while ZAICODE closes. Emoji input still fails, so the feature remains unfinished and this preview is not a verified release.

## Candidate

- Installer: [ZAICODE-3.14.0-win-x64_TEST.exe](${installer.path.replaceAll('\\', '/')}).
- Run directly from the separate test directory: [ZAICODE.exe](${receipt.unpackedExecutable.replaceAll('\\', '/')}). Keep the complete win-unpacked directory together.
- Installer size: ${installer.bytes} bytes (${(installer.bytes / 1048576).toFixed(1)} MiB).
- Installer SHA256: \`${installer.sha256}\`.
- Packaged app.asar SHA256: \`${asar.sha256}\`.
- Source: ${subject.head}, plus the frozen local workspace changes recorded in [T-192-subject.json](T-192-subject.json). This candidate includes the current preserved workspace, not a clean committed release.
- Machine receipt: [T-192-test-bundle.json](T-192-test-bundle.json).

Use this new pass3 directory. The earlier dist-test-20261003-t192 installer contains the failed GUI-console implementation, and pass2 fails its real external launch with ENAMETOOLONG. Neither earlier candidate should be used for this test.

## Test the handoff

1. Launch the candidate and create a new internal Windows CLI worker. Workers created by an older running build cannot be moved retroactively.
2. Start a harmless long-running command and record its process PID and observable progress before transfer.
3. Open the worker context menu and select **Move to PowerShell**. The original worker should disappear from ZAICODE only after the external PowerShell is ready. The transfer is one-way.
4. Confirm the external window continues the original command and responds to input. Record the PID and progress again; the PID must stay the same and progress must continue.
5. Close and restart ZAICODE. Confirm the external command continues, without a duplicate worker. This operator restart check supplements the automated forced-host-termination check below.
6. Complete the command or close its external window when finished. Closing that window ends its own worker.

## Checks and known failure

The production build and bundle exited 0. The packaged boot smoke passed with paid vendor-window starts disabled in its temporary profile. The actual packaged factory/broker passed ${packaged.checks.length}/${packaged.checks.length} checks, including a real visible PowerShell transfer and same CLI PID/state after forced termination of the test app host. The unchanged native oracle passed ${native.checks.length}/${native.checks.length} checks against the final source. The earlier UI oracle passed 35/35; UI source remained unchanged afterward.

The final focused acceptance still fails on \`Write-Output ('UNICODE:' + 'tere-привет-🌙')\`: the expected emoji is missing in the transferred PowerShell command reader. Wire probes preserve the complete Unicode payload, and the original internal shell preserves it before transfer. The remaining cause is unresolved. See [T-192-unicode-stop.txt](T-192-unicode-stop.txt) and [T-192-worker-unicode-control.json](T-192-worker-unicode-control.json). The latest complete repository gate also failed and was not rerun after the final console changes. No current full-gate PASS or feature completion is claimed.

Native test cleanup also logged a node-pty \`AttachConsole failed\` diagnostic while the eight assertions and process exit passed; this receipt does not claim error-free logs.

T-192 stays in BUILD, unpublished and unfinished. All ${subject.foreign.length} foreign changed product files and ${subject.t188} frozen T-188 paths were preserved. SRC-128 requests saipen stop after this test bundle; no Scheduler or vendor acceptance work is part of this delivery.
`;
await writeFile(join(evidence, 'T-192-test-bundle.md'), guide);
console.log(JSON.stringify({ installer, appAsar: asar, guide: join(evidence, 'T-192-test-bundle.md'), preview: true, featureComplete: false }));
