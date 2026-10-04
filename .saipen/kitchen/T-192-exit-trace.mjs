import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const frozen = await readFile(resolve(root, '.saipen/evidence/T-192-native.mjs'), 'utf8');
const target = "check('external console receives original nonzero exit', await active.externalExit() === 7);";
if (!frozen.includes(target)) throw new Error('Frozen oracle target absent');
const diagnostics = process.env.T192_TRACE_BROKER ? `
      b.onLoad({ filter: /workerTerminalBroker\\.ts$/ }, async args => {
        let source = await readFile(args.path, 'utf8');
        const trace = JSON.stringify(join(scratch, 'broker-trace.jsonl'));
        source = 'import {appendFileSync as traceAppend} from "node:fs"; const traceBroker = v => traceAppend(' + trace + ', JSON.stringify({at:Date.now(), ...v}) + "\\\\n");\\n' + source;
        source = source.replace('const stop = (kill = true) => {', 'const stop = (kill = true) => { traceBroker({event:"stop",kill,terminalExited,closing,stack:new Error().stack});');
        source = source.replace('pty.onExit(({ exitCode }) => {', 'pty.onExit(({ exitCode }) => { traceBroker({event:"ptyExit",exitCode});');
        source = source.replace('peer.on("close", () => {', 'peer.on("close", () => { traceBroker({event:"peerClose",role});');
        source = source.replace('readFrames(peer, (message) => {', 'readFrames(peer, (message) => { traceBroker({event:"frame",role,type:message.type,terminalExited});');
        source = source.replace('pty!.resize(message.cols, message.rows);', '(() => {try { pty!.resize(message.cols, message.rows); } catch(error) { traceBroker({event:"resizeError",error:String(error)}); throw error; }})();');
        return { contents: source, loader: 'ts' };
      });
` : '';
const diagnostic = frozen.replace("if (subject !== 'working')", diagnostics + "if (subject !== 'working')").replace(target,
  "const actualExit = await active.externalExit(); check('external console receives original nonzero exit', actualExit === 7, {exitCode: actualExit, output: active.read().slice(-10000)});");
await writeFile(resolve(root, '.saipen/kitchen/T-192-native-exit-diagnostic.mjs'), diagnostic);
await import('./T-192-native-exit-diagnostic.mjs');
