import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import test from "node:test";
import {
  createWorkerTerminalProcess,
  externalClientCommand,
} from "../src/terminal/workerTerminalProcess.js";

const require = createRequire(import.meta.url);
const windows = process.platform === "win32";
const entryPath = new URL("../src/terminal/workerTerminalBroker.ts", import.meta.url);

function waitFor(read: () => string, pattern: RegExp): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const timer = setInterval(() => {
      const match = read().match(pattern);
      if (match) {
        clearInterval(timer);
        resolve(match);
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`No ${pattern}: ${read().slice(-1500)}`));
      }
    }, 20);
  });
}

test(
  "a running Windows worker transfers its existing shell and interactive state once",
  { skip: !windows, timeout: 45_000 },
  async () => {
    const nodePty = require("node-pty") as typeof import("node-pty");
    let external: import("node-pty").IPty | undefined;
    let externalOutput = "";
    let launches = 0;
    let externalExit!: Promise<number>;
    const worker = await createWorkerTerminalProcess(
      {
        shell: "powershell.exe",
        cwd: process.cwd(),
        cols: 90,
        rows: 25,
        env: process.env,
      },
      {
        entryPath,
        launchClient: async (launch) => {
          launches++;
          external = nodePty.spawn(
            "powershell.exe",
            [
              "-NoLogo",
              "-NoProfile",
              "-EncodedCommand",
              Buffer.from(externalClientCommand(launch), "utf16le").toString("base64"),
            ],
            {
              cols: 90,
              rows: 25,
              cwd: process.cwd(),
              env: process.env,
              useConpty: true,
            },
          );
          external.onData((data) => {
            externalOutput += data;
          });
          externalExit = new Promise((resolve) =>
            external!.onExit(({ exitCode }) => {
              resolve(exitCode);
            }),
          );
        },
      },
    );
    let appOutput = "";
    worker.onData((data) => {
      appOutput += data;
    });
    try {
      worker.write(
        "$handoffMarker = [guid]::NewGuid().ToString(); Write-Output ('READY:' + $PID + ':' + $handoffMarker)\r",
      );
      const ready = await waitFor(() => appOutput, /READY:(\d+):([a-f0-9-]{36})/);
      const results = await Promise.all([
        worker.extractToPowerShell(),
        worker.extractToPowerShell(),
      ]);
      assert.equal(launches, 1);
      assert.equal(results[0].pid, Number(ready[1]));
      assert.deepEqual(results[0], results[1]);
      worker.kill(); // app shutdown must release its connection without killing the transferred PTY
      external!.resize(110, 32);
      external!.write("Write-Output ('UNICODE:' + 'tere-привет-🌙')\r");
      await waitFor(() => externalOutput, /UNICODE:tere-привет-🌙/);
      external!.write("Write-Output ('CONTINUED:' + $PID + ':' + $handoffMarker); exit 7\r");
      const continued = await waitFor(() => externalOutput, /CONTINUED:(\d+):([a-f0-9-]{36})/);
      assert.equal(continued[1], ready[1]);
      assert.equal(continued[2], ready[2]);
      assert.equal(await externalExit, 7);
      assert.throws(() => worker.write("STALE\r"), /transferred|closed/);
    } finally {
      external?.kill();
      worker.kill();
    }
  },
);

test(
  "a failed external launch retains the original Windows worker and input owner",
  { skip: !windows, timeout: 30_000 },
  async () => {
    const worker = await createWorkerTerminalProcess(
      {
        shell: "powershell.exe",
        cwd: process.cwd(),
        cols: 90,
        rows: 25,
        env: process.env,
      },
      {
        entryPath,
        launchClient: async (launch) => {
          const config = JSON.parse(await readFile(launch.configPath, "utf8")) as { pipe: string };
          await new Promise<void>((resolve, reject) => {
            const invalid = createConnection(config.pipe);
            invalid.once("error", reject);
            invalid.once("connect", () =>
              invalid.write(
                `${JSON.stringify({ type: "hello", role: "external", token: "invalid", lease: launch.lease })}\n`,
              ),
            );
            invalid.once("close", () => resolve());
          });
          throw new Error("fixture launch refusal");
        },
      },
    );
    let output = "";
    worker.onData((data) => {
      output += data;
    });
    try {
      await assert.rejects(worker.extractToPowerShell(), /fixture launch refusal/);
      worker.write("Write-Output ('STILL:' + $PID)\r");
      const match = await waitFor(() => output, /STILL:(\d+)/);
      assert.equal(Number(match[1]), worker.pid);
      worker.resize(100, 28);
    } finally {
      worker.kill();
    }
  },
);
