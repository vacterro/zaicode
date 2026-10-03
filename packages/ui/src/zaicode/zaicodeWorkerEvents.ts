/** Lifecycle notifications; worker records remain the sole identity owner. */
const removed = new Set<(id: string) => void>();
const cancelled = new Set<(id: string) => void>();
export function onZaicodeWorkerRemoved(listener: (id: string) => void): () => void {
  removed.add(listener);
  return () => removed.delete(listener);
}
export function onZaicodeWorkerCancelled(listener: (id: string) => void): () => void {
  cancelled.add(listener);
  return () => cancelled.delete(listener);
}
export function emitZaicodeWorkerRemoved(id: string): void {
  for (const listener of removed) listener(id);
}
export function emitZaicodeWorkerCancelled(id: string): void {
  for (const listener of cancelled) listener(id);
}
