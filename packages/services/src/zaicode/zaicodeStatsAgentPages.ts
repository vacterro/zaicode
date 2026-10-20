import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { ZAICODE_STATS_PAGE_SIZE, type ZaicodeStatsScan } from "./zaicodeStatsScan.js";

/** Read-only adapter; scans are accepted and persisted only by ZaicodeStatsRepo. */
export function readZaicodeUsagePage(
  db: DatabaseSync,
  table: "model_usage" | "turn_usage",
  scan: ZaicodeStatsScan,
  hasSession: boolean,
): { batch: Record<string, unknown>[]; until: number } {
  const ended = "COALESCE(u.completed_at,u.started_at)";
  const keys = table === "model_usage" ? "u.id" : "u.session_id,u.turn_id";
  const select = `SELECT u.*,${hasSession ? "s.directory" : "NULL"} AS project_dir,${ended} AS ended
    FROM ${table} u ${hasSession ? "LEFT JOIN session s ON s.id=u.session_id" : ""}`;
  const terminal = "u.status != 'running'";
  const same = `${select} WHERE ${terminal} AND ${ended}=? AND ${keys.includes(",") ? `(${keys})>(?,?)` : `${keys}>?`}
    ORDER BY ${keys} LIMIT ?`;
  const later = `${select} WHERE ${terminal} AND ${ended}>? AND ${ended}<=?
    ORDER BY ${ended},${keys} LIMIT ?`;
  const maximum = `SELECT ${ended} AS ended FROM ${table} u WHERE ${terminal}
    ORDER BY ${ended} DESC,${keys.split(",").map(key => `${key} DESC`).join(",")} LIMIT 1`;
  const keyArgs: SQLInputValue[] = table === "model_usage" ? [scan.id] : [scan.id, scan.key];
  const sameArgs = [scan.at, ...keyArgs, ZAICODE_STATS_PAGE_SIZE];
  const laterArgs = [scan.at, scan.until ?? Number.MAX_SAFE_INTEGER, ZAICODE_STATS_PAGE_SIZE];

  // 表达式时间的行值比较只 Seek 第一列，巨大同时间页会重复扫描前缀；先同时间键，再下一时间范围。
  const plans = [
    db.prepare(`EXPLAIN QUERY PLAN ${same}`).all(...sameArgs),
    db.prepare(`EXPLAIN QUERY PLAN ${later}`).all(...laterArgs),
    db.prepare(`EXPLAIN QUERY PLAN ${maximum}`).all(),
  ];
  const indexed = plans.every(plan =>
    plan.some(row => /(?:SEARCH|SCAN) u USING (?:COVERING )?INDEX/.test(String(row.detail))) &&
    plan.every(row => !String(row.detail).includes("USE TEMP B-TREE")),
  );
  if (!indexed) {
    // 当前只读事务保证 probe 与查询的同一快照；大旧库待原 CLI 迁移，不能每次刷新全表排序。
    const count = Number(db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} LIMIT ?)`)
      .get(ZAICODE_STATS_PAGE_SIZE + 1)?.n);
    if (count > ZAICODE_STATS_PAGE_SIZE)
      throw new Error(`${table}: completion/key index upgrade required; scan not advanced`);
  }
  const until = Math.max(scan.since, scan.until ?? Number(db.prepare(maximum).get()?.ended ?? scan.since));
  const batch = scan.at < scan.since ? [] : db.prepare(same).all(...sameArgs);
  if (batch.length < ZAICODE_STATS_PAGE_SIZE) {
    batch.push(...db.prepare(later).all(scan.at, until, ZAICODE_STATS_PAGE_SIZE - batch.length));
  }
  return { batch, until };
}
