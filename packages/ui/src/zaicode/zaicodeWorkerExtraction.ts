import { terminalControl } from "../terminal/terminalOutputTap.js";

interface ExtractableWorker {
  id: string;
  generation: number;
  exitCode: number | null;
}
interface ExtractionDependencies {
  read(): readonly ExtractableWorker[];
  remove(id: string): void;
}
const attempts = new Map<string, Promise<{ pid: number }>>();

export function extractZaicodeWorker(
  worker: ExtractableWorker,
  dependencies: ExtractionDependencies,
): Promise<{ pid: number }> {
  if (worker.exitCode !== null) return Promise.reject(new Error("This worker has exited"));
  const control = terminalControl(worker.id);
  if (!control?.extractToPowerShell)
    return Promise.reject(
      new Error("PowerShell handoff is unavailable until the worker has started"),
    );
  const admitted = dependencies.read().find((entry) => entry.id === worker.id);
  if (!admitted || admitted.generation !== worker.generation || admitted.exitCode !== null)
    return Promise.reject(new Error("Worker terminal is no longer current"));
  const key = `${worker.id}:${worker.generation}`;
  const existing = attempts.get(key);
  if (existing) return existing;
  const result = control.extractToPowerShell().then((outcome) => {
    const current = dependencies.read().find((entry) => entry.id === worker.id);
    // 交接回执可能晚于重启/关闭；不能删除相同 id 下新一代 worker。
    if (
      current?.generation === worker.generation &&
      current.exitCode === null &&
      terminalControl(worker.id) === control
    )
      dependencies.remove(worker.id);
    return outcome;
  });
  attempts.set(key, result);
  void result
    .finally(() => {
      if (attempts.get(key) === result) attempts.delete(key);
    })
    .catch(() => {});
  return result;
}
