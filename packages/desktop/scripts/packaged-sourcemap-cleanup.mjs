import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, relative, resolve } from "node:path";

const SOURCEMAP_REFERENCE_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".css"]);
// 只清理位于行首的 sourceMappingURL 注释。压缩后的 bundle 可能在模板字符串里内嵌
// 这段文本（例如内嵌 TypeScript 编译器的 emitter 源码），行中匹配会把该行剩余内容整段
// 吞掉，直接产出语法损坏的产物；真实的 sourcemap 注释总是由构建工具单独成行输出。
const SOURCE_MAPPING_URL_LINE_RE = /(?:^|\r?\n)[ \t]*\/\/[#@][ \t]*sourceMappingURL=[^\r\n]*/g;
const SOURCE_MAPPING_URL_BLOCK_RE =
  /(?:^|\r?\n)[ \t]*\/\*[#@][ \t]*sourceMappingURL=[\s\S]*?\*\/[ \t]*/g;

export function stripSourceMappingUrlComments(source) {
  return source.replace(SOURCE_MAPPING_URL_LINE_RE, "").replace(SOURCE_MAPPING_URL_BLOCK_RE, "");
}

function walkFiles(rootDir, visitor) {
  if (!existsSync(rootDir)) {
    return;
  }

  for (const entry of readdirSync(rootDir)) {
    const entryPath = resolve(rootDir, entry);
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      walkFiles(entryPath, visitor);
      continue;
    }
    if (stat.isFile()) {
      visitor(entryPath);
    }
  }
}

export function stripSourceMappingUrlCommentsInDirectory(rootDir) {
  const summary = { filesChanged: 0, referencesRemoved: 0 };
  walkFiles(rootDir, (filePath) => {
    if (!SOURCEMAP_REFERENCE_EXTENSIONS.has(extname(filePath))) {
      return;
    }
    const source = readFileSync(filePath, "utf8");
    const lineReferenceCount = source.match(SOURCE_MAPPING_URL_LINE_RE)?.length ?? 0;
    const blockReferenceCount = source.match(SOURCE_MAPPING_URL_BLOCK_RE)?.length ?? 0;
    const referencesRemoved = lineReferenceCount + blockReferenceCount;
    if (referencesRemoved === 0) {
      return;
    }

    writeFileSync(filePath, stripSourceMappingUrlComments(source));
    summary.filesChanged += 1;
    summary.referencesRemoved += referencesRemoved;
  });
  return summary;
}

export function archiveAndRemoveSourceMapFilesInDirectory(rootDir, archiveDir) {
  const summary = { filesRemoved: 0, filesArchived: 0 };
  walkFiles(rootDir, (filePath) => {
    if (extname(filePath) !== ".map") {
      return;
    }

    if (archiveDir) {
      try {
        const relativePath = relative(rootDir, filePath);
        const destinationPath = resolve(archiveDir, relativePath);
        mkdirSync(dirname(destinationPath), { recursive: true });
        copyFileSync(filePath, destinationPath);
        summary.filesArchived += 1;
      } catch {
        // 归档复制异常不打断清理流程
      }
    }

    unlinkSync(filePath);
    summary.filesRemoved += 1;
  });
  return summary;
}

export function removeSourceMapFilesInDirectory(rootDir) {
  return archiveAndRemoveSourceMapFilesInDirectory(rootDir);
}

export async function cleanupPackagedSourcemaps({
  appAsarPath,
  resourcesDir,
  archiveDir,
  runAsarCommand,
  runTimedSync,
  runTimedAsync,
  replaceAppAsarFromStaging,
  logger = console,
}) {
  const resolvedArchiveDir =
    archiveDir ||
    (process.env.ZCODE_SOURCEMAP_ARCHIVE_DIR
      ? resolve(process.env.ZCODE_SOURCEMAP_ARCHIVE_DIR)
      : resolve(resourcesDir, "..", "dist", "private-sourcemaps"));

  if (existsSync(appAsarPath)) {
    mkdirSync(tmpdir(), { recursive: true });
    const stagingDir = mkdtempSync(resolve(tmpdir(), "zcode-app-asar-sourcemap-"));
    try {
      runTimedSync("afterPack:sourcemap-cleanup:asar-extract", () =>
        runAsarCommand(["extract", appAsarPath, stagingDir]),
      );
      const stripSummary = stripSourceMappingUrlCommentsInDirectory(stagingDir);
      const mapSummary = archiveAndRemoveSourceMapFilesInDirectory(stagingDir, resolvedArchiveDir);
      if (stripSummary.referencesRemoved > 0 || mapSummary.filesRemoved > 0) {
        logger.log(
          `[afterPack] stripped sourceMappingURL references=${stripSummary.referencesRemoved} files=${stripSummary.filesChanged} maps=${mapSummary.filesRemoved} archived=${mapSummary.filesArchived}`,
        );
        await runTimedAsync("afterPack:sourcemap-cleanup:asar-pack", () =>
          replaceAppAsarFromStaging({ sourceDir: stagingDir, appAsarPath }),
        );
      } else {
        logger.log("[afterPack] app.asar sourcemap cleanup found no references");
      }
    } finally {
      rmSync(stagingDir, { force: true, recursive: true });
    }
  }

  const stripSummary = stripSourceMappingUrlCommentsInDirectory(resourcesDir);
  const mapSummary = archiveAndRemoveSourceMapFilesInDirectory(resourcesDir, resolvedArchiveDir);
  logger.log(
    `[afterPack] resources sourcemap cleanup references=${stripSummary.referencesRemoved} files=${stripSummary.filesChanged} maps=${mapSummary.filesRemoved} archived=${mapSummary.filesArchived}`,
  );
}
