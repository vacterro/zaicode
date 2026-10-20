/**
 * 清理执行器：枚举候选（递归 / 非递归两种范围）与有界并发删除。
 * 删除后自底向上移除变空的目录，但保留 keepDirectories（类别顶层目录），写入方不必重新 mkdir。
 */
import { lstat, readdir, realpath, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { FsCleanerPort, StorageDeleteResult } from "../app/ports.js";
import type { StorageCleanCandidate } from "../domain/cleanPlan.js";
import type { StorageCleanScope } from "../domain/storageCatalog.js";
import { normalizeStorageRelativePath } from "../domain/storageCatalog.js";
import { walkStorageRoot } from "./fsWalker.js";

const DELETE_CONCURRENCY = 8;

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}

async function listShallow(rootPath: string, prefix: string): Promise<StorageCleanCandidate[]> {
  const directoryPath = join(rootPath, prefix);
  let names: string[];
  try {
    names = await readdir(directoryPath);
  } catch {
    return [];
  }
  const candidates: StorageCleanCandidate[] = [];
  for (const name of names) {
    try {
      const stats = await lstat(join(directoryPath, name));
      if (!stats.isFile()) continue;
      candidates.push({
        relativePath: `${prefix}/${name}`,
        bytes: stats.size,
        mtimeMs: stats.mtimeMs,
        fileIdentity: `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`,
      });
    } catch {
      // 枚举期间被删除的文件跳过即可
    }
  }
  return candidates;
}

async function listRecursive(rootPath: string, prefix: string): Promise<StorageCleanCandidate[]> {
  const candidates: StorageCleanCandidate[] = [];
  await walkStorageRoot({
    rootPath: join(rootPath, prefix),
    onEntry: (entry) =>
      candidates.push({ ...entry, relativePath: `${prefix}/${entry.relativePath}` }),
  });
  return candidates;
}

async function pruneEmptyParents(
  rootPath: string,
  deletedRelativePaths: string[],
  keepDirectories: Set<string>,
): Promise<void> {
  // 先处理最深的目录，父目录才有机会变空。
  const directories = new Set<string>();
  for (const path of deletedRelativePaths) {
    let current = dirname(path);
    while (current && current !== "." && !keepDirectories.has(current)) {
      directories.add(current);
      current = dirname(current);
    }
  }
  const ordered = [...directories].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const directory of ordered) {
    await rmdir(join(rootPath, directory)).catch(() => {});
  }
}

type DeletableCheck =
  | { ok: true; size: number }
  | { ok: false; code: string };

/**
 * Time-of-use re-check: the file planned at enumeration must still be the same plain
 * file, reached through real directories only (no symlink or junction substituted on
 * the way), still inside the root, and unchanged since it was planned. Anything else
 * is reported, never deleted. Freed bytes come from this check, not from the plan.
 */
async function verifyDeletableTarget(
  root: string,
  resolvedRoot: string,
  relativePath: string,
  planned: StorageCleanCandidate,
): Promise<DeletableCheck> {
  if (!relativePath || isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath)) {
    return { ok: false, code: "EOUTSIDE" };
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    return { ok: false, code: "EOUTSIDE" };
  }
  const absolutePath = join(root, relativePath);
  const back = relative(root, absolutePath);
  if (back.startsWith("..") || back.split(sep).includes("..") || isAbsolute(back)) {
    return { ok: false, code: "EOUTSIDE" };
  }
  try {
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      const parent = await lstat(current);
      if (parent.isSymbolicLink() || !parent.isDirectory()) {
        return { ok: false, code: "EUNSAFE" };
      }
    }
    const parentReal = await realpath(dirname(absolutePath));
    const inside = relative(resolvedRoot, parentReal);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      return { ok: false, code: "EOUTSIDE" };
    }
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return { ok: false, code: "EUNSAFE" };
    }
    // 相同 mtime/长度不能证明还是原文件；同名替换也必须按枚举时的文件身份拒绝。
    if (!planned.fileIdentity) return { ok: false, code: "EIDENTITY_UNKNOWN" };
    if (
      stats.mtimeMs !== planned.mtimeMs || stats.size !== planned.bytes ||
      `${stats.dev}:${stats.ino}:${stats.birthtimeMs}` !== planned.fileIdentity
    ) {
      return { ok: false, code: "ECHANGED" };
    }
    return { ok: true, size: stats.size };
  } catch (error) {
    return { ok: false, code: errorCode(error) };
  }
}

export function createFsStorageCleaner(): FsCleanerPort {
  return {
    async listCandidates(rootPath: string, scopes: StorageCleanScope[]) {
      const lists = await Promise.all(
        scopes.map((scope) =>
          scope.recursive
            ? listRecursive(rootPath, scope.prefix)
            : listShallow(rootPath, scope.prefix),
        ),
      );
      // 递归范围与非递归范围可能重叠（cli/db/backup 与 cli/db），按路径去重。
      const byPath = new Map<string, StorageCleanCandidate>();
      for (const candidate of lists.flat()) {
        byPath.set(normalizeStorageRelativePath(candidate.relativePath), candidate);
      }
      return [...byPath.values()];
    },

    async deleteFiles(rootPath, targets, options): Promise<StorageDeleteResult> {
      const result: StorageDeleteResult = { deletedCount: 0, freedBytes: 0, failures: [] };
      const deleted: string[] = [];
      const queue = [...targets];
      let realRoot: string;
      try {
        realRoot = await realpath(rootPath);
      } catch (error) {
        // The root itself is gone or unreadable: nothing is deleted, every target is reported.
        for (const target of targets) {
          result.failures.push({
            path: normalizeStorageRelativePath(target.relativePath),
            code: errorCode(error),
          });
        }
        return result;
      }
      const worker = async () => {
        for (let target = queue.shift(); target; target = queue.shift()) {
          const relativePath = normalizeStorageRelativePath(target.relativePath);
          if (options.canDelete) {
            let allowed = false;
            try {
              allowed = await options.canDelete(target);
            } catch {
              // 活跃度不可确认时保护数据，不能把查询错误变成删除许可。
            }
            if (!allowed) {
              result.skippedCount = (result.skippedCount ?? 0) + 1;
              continue;
            }
          }
          const check = await verifyDeletableTarget(rootPath, realRoot, relativePath, target);
          if (!check.ok) {
            result.failures.push({ path: relativePath, code: check.code });
            continue;
          }
          try {
            await rm(join(rootPath, relativePath), { force: false });
            result.deletedCount += 1;
            result.freedBytes += check.size;
            deleted.push(relativePath);
          } catch (error) {
            result.failures.push({ path: relativePath, code: errorCode(error) });
          }
        }
      };
      await Promise.all(Array.from({ length: DELETE_CONCURRENCY }, worker));
      await pruneEmptyParents(rootPath, deleted, new Set(options.keepDirectories));
      return result;
    },
  };
}
