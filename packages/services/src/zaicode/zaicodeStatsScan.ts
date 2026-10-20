import type { DatabaseSync } from "node:sqlite";
import type { ZaicodeStatsEventRow } from "./zaicodeStatsRepo.js";

export const ZAICODE_STATS_PAGE_SIZE = 5000;
export const ZAICODE_STATS_OVERLAP_MS = 5 * 60_000;
export const ZAICODE_STATS_CLEAR_GENERATION = "clear-generation";
export type ZaicodeStatsStream = "queue" | "agent-model" | "agent-turn";
export interface ZaicodeStatsScan {
  source: ZaicodeStatsStream;
  generation: number;
  revision: number;
  floor: number;
  since: number;
  until: number | null;
  at: number;
  id: string;
  key: string;
}
export interface ZaicodeStatsPage {
  scan: ZaicodeStatsScan;
  until: number;
  at: number;
  id: string;
  key: string;
  complete: boolean;
  rows: ZaicodeStatsEventRow[];
}

export function readZaicodeStatsScan(db: DatabaseSync, source: ZaicodeStatsStream): ZaicodeStatsScan {
  // 同一 SQLite 快照读取清除代次、水位与页键，不能把 Clear 前后的值拼成一个有效凭据。
  const row = db.prepare(`SELECT p.*,
    COALESCE((SELECT cursor FROM zaicode_stats_cursor WHERE source='cleared'),0) AS floor,
    COALESCE((SELECT cursor FROM zaicode_stats_cursor WHERE source='clear-generation'),0) AS generation,
    COALESCE((SELECT cursor FROM zaicode_stats_cursor WHERE source=?),0) AS watermark,
    COALESCE((SELECT cursor FROM zaicode_stats_cursor WHERE source=?),0) AS revision
    FROM (SELECT ? AS stream) s LEFT JOIN zaicode_stats_progress p ON p.source=s.stream`)
    .get(source, `${source}:revision`, source)!;
  const floor = Number(row.floor);
  const since = row.since_at === null ? Math.max(0, floor, Number(row.watermark) - ZAICODE_STATS_OVERLAP_MS) : Number(row.since_at);
  return {
    source, floor, generation: Number(row.generation), revision: Number(row.revision), since,
    until: row.until_at === null ? null : Number(row.until_at),
    at: row.after_at === null ? since - 1 : Number(row.after_at),
    id: row.after_id === null ? "" : String(row.after_id),
    key: row.after_key === null ? "" : String(row.after_key),
  };
}

/** Called under the repository's event writer lock; no independent connection or accepted state. */
export function isCurrentZaicodeStatsScan(db: DatabaseSync, scan: ZaicodeStatsScan): boolean {
  const current = readZaicodeStatsScan(db, scan.source);
  return current.generation === scan.generation && current.revision === scan.revision;
}

export function saveZaicodeStatsPage(db: DatabaseSync, page: ZaicodeStatsPage, now: number): void {
  const { scan } = page;
  const cursor = db.prepare(`INSERT INTO zaicode_stats_cursor(source,cursor,updated_at) VALUES(?,?,?)
    ON CONFLICT(source) DO UPDATE SET cursor=MAX(cursor,excluded.cursor),updated_at=excluded.updated_at`);
  if (page.complete) {
    db.prepare("DELETE FROM zaicode_stats_progress WHERE source=?").run(scan.source);
    cursor.run(scan.source, Math.max(scan.floor, page.until), now);
  } else {
    db.prepare(`INSERT INTO zaicode_stats_progress VALUES(?,?,?,?,?,?)
      ON CONFLICT(source) DO UPDATE SET since_at=excluded.since_at,until_at=excluded.until_at,
      after_at=excluded.after_at,after_id=excluded.after_id,after_key=excluded.after_key`)
      .run(scan.source, scan.since, page.until, page.at, page.id, page.key);
  }
  cursor.run(`${scan.source}:revision`, scan.revision + 1, now);
}
