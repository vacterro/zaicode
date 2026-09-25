/**
 * ZAICODE（SRC-046）：持久终端（worker）的输出旁路与控制入口。
 *
 * worker 终端里跑的是订阅 CLI；为了识别 "Trust this folder?" 首次信任提问与
 * "hit your session limit" 限额提示，需要读到 PTY 输出，并能向 PTY 写一个回车。
 * 输出只是旁听（不改变写入 xterm 的数据），控制入口按 persistentKey 登记，
 * 随 registry entry 的生命周期注销。
 */

export type TerminalOutputListener = (key: string, data: string) => void;

export interface TerminalControl {
  /** Writes raw input into the PTY (as if typed). */
  write: (data: string) => void;
  /** Makes the program repaint: the PTY is resized by one column and back. */
  redraw: () => void;
}

const outputListeners = new Set<TerminalOutputListener>();
const controls = new Map<string, TerminalControl>();

export function onTerminalOutput(listener: TerminalOutputListener): () => void {
  outputListeners.add(listener);
  return () => outputListeners.delete(listener);
}

export function emitTerminalOutput(key: string, data: string): void {
  for (const listener of outputListeners) {
    try {
      listener(key, data);
    } catch {
      // a listener never breaks the terminal
    }
  }
}

export function registerTerminalControl(key: string, control: TerminalControl): () => void {
  controls.set(key, control);
  return () => {
    if (controls.get(key) === control) controls.delete(key);
  };
}

export function terminalControl(key: string): TerminalControl | null {
  return controls.get(key) ?? null;
}
