/**
 * 清理计划：给定类别与候选文件列表，决定哪些能删。纯函数，删除动作由 adapters 执行。
 */
import {
  classifyStoragePath,
  getStorageCategoryCleanability,
  isProtectedStoragePath,
  normalizeStorageRelativePath,
  type StorageCatalogContext,
} from "./storageCatalog.js";
import type { StorageCategoryId } from "@zcode/shared";

export interface StorageCleanCandidate {
  relativePath: string;
  bytes: number;
  mtimeMs: number;
  fileIdentity?: string;
}

interface StorageCleanPlan {
  targets: StorageCleanCandidate[];
  skippedCount: number;
}

/** 时间只能阻止清理；超过窗口仍需要运行时明确确认 inactive。 */
const SUBAGENT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function planStorageClean(params: {
  categoryId: StorageCategoryId;
  candidates: StorageCleanCandidate[];
  context: StorageCatalogContext;
  now: number;
  isSessionActive?: (sessionId: string) => boolean | undefined;
}): StorageCleanPlan {
  const { categoryId, candidates, context, now, isSessionActive } = params;
  if (getStorageCategoryCleanability(categoryId) === "none") {
    return { targets: [], skippedCount: candidates.length };
  }
  // 候选来自按前缀枚举，可能混入其他类别（如 cli/plugins 下的 cache）；只保留分类一致且未受保护的。
  const owned = candidates.filter(
    (candidate) =>
      classifyStoragePath(candidate.relativePath, context).categoryId === categoryId &&
      !isProtectedStoragePath(candidate.relativePath),
  );
  let targets = owned;
  if (categoryId === "logs") {
    targets = owned.filter(
      (candidate) =>
        Number.isFinite(candidate.mtimeMs) &&
        candidate.mtimeMs > 0 &&
        candidate.mtimeMs <= now &&
        !isSameLocalDay(candidate.mtimeMs, now),
    );
  } else if (categoryId === "subagentTranscripts") {
    // 活动判定如果只看 owned（已按类别过滤，只剩 transcript.jsonl），会漏掉同目录下
    // 刚写入的 metadata/output 文件，把进行中 subagent 的 transcript 判成不活跃。这里用全部候选算活动时间。
    targets = filterInactiveSessionDirs(owned, candidates, now, isSessionActive);
  }
  return { targets, skippedCount: candidates.length - targets.length };
}

function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** 会话目录 = 前三段（cli/agents/sess_x）；任一文件在活动窗口内则整组跳过。 */
function filterInactiveSessionDirs(
  targets: StorageCleanCandidate[],
  allCandidates: StorageCleanCandidate[],
  now: number,
  isSessionActive?: (sessionId: string) => boolean | undefined,
): StorageCleanCandidate[] {
  const latestBySession = new Map<string, number>();
  const sessionKey = (path: string) =>
    normalizeStorageRelativePath(path).split("/").slice(0, 3).join("/");
  for (const candidate of allCandidates) {
    const key = sessionKey(candidate.relativePath);
    latestBySession.set(key, Math.max(latestBySession.get(key) ?? 0, candidate.mtimeMs));
  }
  return targets.filter((candidate) => {
    const normalized = normalizeStorageRelativePath(candidate.relativePath);
    const sessionId = storageSessionIdOf(normalized);
    // 时间戳只能增加保护，不能证明已结束；未提供、未知或失败的运行时判定一律保留。
    let active: boolean | undefined;
    try {
      active = sessionId ? isSessionActive?.(sessionId) : undefined;
    } catch {
      return false;
    }
    if (active !== false) {
      return false;
    }
    const key = sessionKey(candidate.relativePath);
    const latest = latestBySession.get(key) ?? 0;
    // When activity cannot be determined, or timestamp is invalid or in the future: preserve the data.
    if (!Number.isFinite(latest) || latest <= 0 || latest > now) {
      return false;
    }
    return now - latest > SUBAGENT_ACTIVE_WINDOW_MS;
  });
}

export function storageSessionIdOf(relativePath: string): string | undefined {
  const segments = normalizeStorageRelativePath(relativePath).split("/");
  return segments[0] === "cli" && segments[1] === "agents" ? segments[2] : undefined;
}
