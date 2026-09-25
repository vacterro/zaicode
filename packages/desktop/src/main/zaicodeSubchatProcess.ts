import { spawn, type ChildProcess } from "node:child_process";
import { parseZaicodeSubchatLine, type ZaicodeSubchatEvent, type ZaicodeSubchatVendor } from "@zcode/shared";

/**
 * One subscription chat turn as a child process (T-51), free of Electron so
 * the transport is testable with a stand-in CLI: the prompt goes in on stdin,
 * stdout is split into lines and parsed with the vendor's parser, and the
 * last event is always exactly one `result` -- the CLI's own, or one derived
 * from the exit (a Stop is "Stopped.", a crash carries the last stderr line).
 */

const STDERR_TAIL_BYTES = 4096;
const LINE_MAX_BYTES = 8 * 1024 * 1024;

export interface ZaicodeSubchatProcessOptions {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  vendor: ZaicodeSubchatVendor;
  /** Engine tile name for messages ("C1 exited with code 2"). */
  short: string;
  onEvent: (event: ZaicodeSubchatEvent) => void;
  /** Kills the whole process tree (taskkill /T on Windows); defaults to a plain kill. */
  kill?: (child: ChildProcess) => void;
}

export interface ZaicodeSubchatProcess {
  /** Ends the turn on purpose; its result is ok with the message "Stopped.". */
  stop(): void;
  readonly done: Promise<void>;
}

export function startZaicodeSubchatProcess(options: ZaicodeSubchatProcessOptions): ZaicodeSubchatProcess {
  const kill = options.kill ?? ((child: ChildProcess) => void child.kill());
  let sawResult = false;
  let finished = false;
  let stopping = false;
  let buffer = "";
  let stderrTail = "";
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const send = (event: ZaicodeSubchatEvent) => {
    if (finished) return;
    if (event.type === "result") {
      if (sawResult) return;
      sawResult = true;
    }
    options.onEvent(event);
  };
  const consume = (line: string) => {
    for (const event of parseZaicodeSubchatLine(options.vendor, line)) send(event);
  };
  const finish = (fallback: ZaicodeSubchatEvent) => {
    if (finished) return;
    if (buffer) consume(buffer);
    buffer = "";
    if (!sawResult) send(fallback);
    finished = true;
    resolveDone();
  };

  let child: ChildProcess;
  try {
    child = spawn(options.file, options.args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    finish({ type: "result", ok: false, message: error instanceof Error ? error.message : String(error) });
    return { stop: () => undefined, done };
  }

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      consume(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    // A single line this long is not a stream event; drop it rather than grow without bound.
    if (buffer.length > LINE_MAX_BYTES) buffer = "";
  });
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(options.stdin, "utf8");
  child.on("error", (error) => finish({ type: "result", ok: false, message: error.message }));
  child.on("close", (code, signal) => {
    if (stopping || signal !== null || code === null) {
      finish({ type: "result", ok: true, message: "Stopped." });
      return;
    }
    // A Node-based CLI that crashes ends its stderr with "Node.js v24.x": the line before it is the reason.
    const reason =
      stderrTail
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.trim() && !/^Node\.js v\d/.test(line.trim()))
        .at(-1) ?? "";
    finish({
      type: "result",
      ok: code === 0,
      message: code === 0 ? null : reason.slice(0, 240) || `${options.short} exited with code ${code}`,
    });
  });

  return {
    stop() {
      if (finished || stopping) return;
      stopping = true;
      kill(child);
    },
    done,
  };
}
