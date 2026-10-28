import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const moduleDir = import.meta.dirname;

function findPackageDir(packageName, startDirs) {
  for (const startDir of startDirs) {
    let currentDir = resolve(startDir);

    while (true) {
      const packageJsonPath = resolve(currentDir, "package.json");
      if (existsSync(packageJsonPath)) {
        try {
          const packageJson = readJson(packageJsonPath);
          if (packageJson.name === packageName) {
            return currentDir;
          }
        } catch {
          // ignore invalid package.json and continue walking up
        }
      }

      const parentDir = resolve(currentDir, "..");
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }
  }

  throw new Error(`Unable to find package directory for ${packageName}`);
}

const desktopDir = findPackageDir("@zcode/desktop", [
  moduleDir,
  resolve(moduleDir, ".."),
  process.cwd(),
]);
const workspaceDir = resolve(desktopDir, "../..");
const metadataDir = resolve(desktopDir, "out/metadata");
const metadataPath = resolve(metadataDir, "build-meta.json");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function normalizeVersion(version) {
  if (typeof version !== "string" || version.length === 0) {
    return "unknown";
  }

  const normalized = version.replace(/^[^\d]*/, "");
  return normalized || version;
}

function resolveInstalledPackageVersion(packageName, fallbackVersion) {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [desktopDir] });
    return normalizeVersion(readJson(packageJsonPath).version);
  } catch {
    return normalizeVersion(fallbackVersion);
  }
}

const SOURCE_ROOTS = [
  "packages",
  "apps",
  "scripts",
  "spec",
  "specs",
  "config",
  "patches",
  "package.json",
  "pnpm-lock.yaml",
  "architecture-policy.yaml",
];

export function collectSourceIdentity(root = workspaceDir) {
  try {
    const git = (args) =>
      execFileSync("git", args, {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 32 * 1024 * 1024,
      });
    const sourceRevision = git(["rev-parse", "HEAD"]).toString().trim();
    // 按内容判断：构建以另一种换行符重写已跟踪文件（MinGit 默认 CRLF 检出）不是源码改动，
    // 否则安装版启动器每次启动都会弹出源码/运行时不一致警告。
    const status =
      git(["diff", "--ignore-cr-at-eol", "--name-only", "HEAD", "--", ...SOURCE_ROOTS]).toString() +
      git(["ls-files", "--others", "--exclude-standard", "--", ...SOURCE_ROOTS]).toString();
    const files = git([
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...SOURCE_ROOTS,
    ])
      .toString()
      .split("\0")
      .filter(Boolean);
    const hash = createHash("sha256");
    hash.update(sourceRevision);
    for (const name of [...new Set(files)].sort()) {
      hash.update(`\0${name}\0`);
      const filePath = resolve(root, name);
      hash.update(
        existsSync(filePath)
          ? createHash("sha256").update(readFileSync(filePath)).digest("hex")
          : "ABSENT",
      );
    }
    return {
      sourceRevision,
      sourceFingerprint: hash.digest("hex"),
      workingTreeDirty: Boolean(status.trim()),
    };
  } catch {
    // Git 不可用不代表干净构建；未知出处必须随包保留，不能伪造 HEAD。
    return { sourceRevision: "unknown", sourceFingerprint: "unknown", workingTreeDirty: null };
  }
}

export function collectBuildMetadata() {
  const rootPackageJson = readJson(resolve(workspaceDir, "package.json"));
  const desktopPackageJson = readJson(resolve(desktopDir, "package.json"));

  const source = collectSourceIdentity();
  // ZAICODE 与上游 ZCode 版本分离；安装包和 About 复用同一个发行版本来源。
  const zaicodeVersionFile = resolve(workspaceDir, "ZAICODE_VERSION");
  const appVersion = process.env.ZCODE_ZAICODE_IDENTITY === "1" && existsSync(zaicodeVersionFile)
    ? normalizeVersion(readFileSync(zaicodeVersionFile, "utf8").trim())
    : normalizeVersion(rootPackageJson.version);
  const buildTime = new Date().toISOString();
  const requestedChannel = process.env.ZAICODE_BUILD_CHANNEL || "local";
  const updateChannel = ["local", "stable", "test", "development"].includes(requestedChannel)
    ? requestedChannel
    : "unknown";
  return {
    appVersion,
    buildCommitId:
      source.sourceRevision === "unknown" ? "unknown" : source.sourceRevision.slice(0, 8),
    ...source,
    buildTime,
    updateChannel,
    runtimePackageIdentity: `zaicode-${createHash("sha256")
      .update(
        JSON.stringify({ ...source, buildTime, updateChannel, version: appVersion }),
      )
      .digest("hex")}`,
    electronBuilderVersion: resolveInstalledPackageVersion(
      "electron-builder",
      desktopPackageJson.devDependencies?.["electron-builder"],
    ),
  };
}

export function readBuildMetadata() {
  if (!existsSync(metadataPath)) {
    return null;
  }

  try {
    return readJson(metadataPath);
  } catch {
    return null;
  }
}

export function getBuildMetadata() {
  return readBuildMetadata() ?? collectBuildMetadata();
}

export function writeBuildMetadata() {
  // About 之前分别在 tsup、vite 里各算一份 commit 和时间。
  // 问题原因：两次构建是独立进程，时间点天然不一致；后面再打包时，最终安装包里展示的信息也不一定对应同一次产物。
  // 这里先统一落盘成 build-meta.json，再让构建和运行时都复用同一份数据，保证 about 可追溯。
  const metadata = collectBuildMetadata();
  mkdirSync(metadataDir, { recursive: true });
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
  return metadata;
}

export function getBuildMetadataPath() {
  return metadataPath;
}

const entryFilePath = process.argv[1] ? resolve(process.argv[1]) : null;
const currentFilePath = fileURLToPath(import.meta.url);

if (entryFilePath === currentFilePath) {
  const metadata = writeBuildMetadata();
  process.stdout.write(`[build-meta] wrote ${metadataPath}\n`);
  process.stdout.write(
    `[build-meta] commit=${metadata.buildCommitId} time=${metadata.buildTime}\n`,
  );
}
