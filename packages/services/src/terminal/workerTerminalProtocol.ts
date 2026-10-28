import type { Socket } from "node:net";

export interface WorkerTerminalConfig {
  pipe: string;
  token: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
}

export interface WorkerFrame {
  type: string;
  [key: string]: unknown;
}

const fields: Record<string, string[]> = {
  hello: ["token", "role", "lease"],
  welcome: ["pid"],
  prepare: ["id"],
  abort: ["id", "lease"],
  write: ["data"],
  resize: ["cols", "rows"],
  stop: [],
  reply: ["id", "ok", "pid", "lease", "state", "error"],
  data: ["data"],
  exit: ["code"],
  handoff: ["pid"],
};

export function validSize(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 1000;
}

export function sendFrame(socket: Socket, message: WorkerFrame): void {
  if (socket.destroyed) return;
  if (socket.writableLength > 2 * 1024 * 1024) {
    socket.destroy();
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

export function closeConnection(socket: Socket): void {
  // Windows named pipe 没有 TCP 的半关闭握手；flush 后必须销毁读侧句柄，否则双方一直等 EOF。
  socket.end(() => socket.destroy());
}

/** A bounded, closed wire format. Invalid peers cannot issue partial commands. */
export function readFrames(socket: Socket, receive: (message: WorkerFrame) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (data: string) => {
    buffer += data;
    if (buffer.length > 1024 * 1024) {
      socket.destroy();
      return;
    }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message: unknown = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message))
          throw new Error("frame");
        const frame = message as WorkerFrame;
        if (
          !Object.hasOwn(fields, frame.type) ||
          Object.keys(frame).some((key) => key !== "type" && !fields[frame.type]!.includes(key))
        )
          throw new Error("frame");
        receive(frame);
      } catch {
        socket.destroy();
        return;
      }
    }
  });
  socket.on("error", () => socket.destroy());
}
