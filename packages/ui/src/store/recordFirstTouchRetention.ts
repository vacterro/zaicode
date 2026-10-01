/**
 * First-touch retention for the renderer's append-only `Record` caches.
 *
 * Every one of these maps is a mirror of something the host can re-read, not a source of
 * truth, and a missing key is the "I don't know, go fetch it" signal their readers
 * already handle. Left unbounded they each grew for the whole session -- one runtime plus
 * one UI state per task ever opened, one result set per query shape ever typed -- which is
 * a straight line on the performance timeline of a long autonomous run.
 */
export const ZAICODE_TASK_STATE_RETENTION = 40;

/** Distinct query shapes (search text, workspace set, limit) kept resident at once. */
export const ZAICODE_QUERY_CACHE_RETENTION = 32;

/**
 * Drops the oldest first-touched keys past the cap, never dropping a pinned key.
 *
 * Object key order is first-write order: spreading `{ ...current, [key]: next }` over an
 * existing key keeps its slot, so the head of the map is exactly the entries touched
 * longest ago and the tail the newest. That makes this a FIFO retention over first touch,
 * which is what a plain record can honestly answer without a per-entry timestamp.
 *
 * Returns the same reference when nothing was dropped, so a no-op write still preserves
 * referential equality for the selectors that read these maps.
 */
export function boundRecordByFirstTouch<T>(
  record: Record<string, T>,
  limit: number = ZAICODE_TASK_STATE_RETENTION,
  pinnedKeys: readonly (string | null | undefined)[] = [],
): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= limit) return record;

  const pinned = new Set<string>();
  for (const key of pinnedKeys) if (typeof key === "string" && key.length > 0) pinned.add(key);
  const keepFromTail = Math.max(0, limit - pinned.size);

  const dropped = new Set<string>();
  for (const key of keys.slice(0, keys.length - keepFromTail)) {
    if (!pinned.has(key)) dropped.add(key);
  }
  if (dropped.size === 0) return record;

  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!dropped.has(key)) next[key] = value;
  }
  return next;
}
