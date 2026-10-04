import { createRequire } from 'node:module';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const product = join(root, 'zcode');
const require = createRequire(join(product, 'packages/services/package.json'));
const { build } = require('esbuild');
const scratch = await mkdtemp(join(tmpdir(), 't192-launch-length-'));
const entry = join(scratch, 'process.mjs');
await build({ entryPoints: [join(product, 'packages/services/src/terminal/workerTerminalProcess.ts')],
  outfile: entry, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
const { externalClientCommand } = await import(pathToFileURL(entry).href);
const client = externalClientCommand({ configPath: 'V:/_TEMP_/zaicode-worker-SAMPLE/terminal.json', cwd: product, lease: 'a'.repeat(64) });
const innerEncoded = Buffer.from(client, 'utf16le').toString('base64');
const launcher = `$ErrorActionPreference='Stop'; Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoLogo -NoProfile -EncodedCommand ${innerEncoded}' -WorkingDirectory '${product.replaceAll("'", "''")}' | Out-Null`;
const result = { schema: 't192-launch-length/1', at: new Date().toISOString(), sampleConfiguration: true,
  clientCharacters: client.length, innerEncodedCharacters: innerEncoded.length,
  previousOuterEncodedCharacters: Buffer.from(launcher, 'utf16le').toString('base64').length,
  correctedDirectLauncherCharacters: launcher.length };
await writeFile(join(root, '.saipen/evidence/T-192-launch-length.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
