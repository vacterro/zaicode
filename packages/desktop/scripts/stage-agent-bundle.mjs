// Agent bundle 的暂存动作：把 apps/zcode-cli/packages/cli/dist/zcode.cjs 放进
// bundled-agents/<平台>/glm，并写 meta。
//
// dev 与打包**必须**用同一份暂存实现。
// 只有打包链（prepare-agent-node-bundle.mjs）会暂存是不够的，dev 链
// （scripts/build-desktop-agent-cli.mjs）不会；而 dev 未打包时的 agent 二进制由
// desktopRuntimeEnv.ts 的 resolveBundledZCodeAgentBinaryPath() 解析，候选**只有**
// bundled-agents/，没有 cli/dist/。于是 dev 一直跑着上一次打包时留下的那份 ——
// 实测陈旧 3 天，任何 agent CLI 侧改动在 dev 里静默不生效，排查时会把「改动没生效」
// 误判成「代码没起作用」。两边共用这一份，dev 与打包不可能再各自漂移。
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const AGENT_BUNDLE_SOURCE_RELATIVE = "apps/zcode-cli/packages/cli/dist/zcode.cjs";

/** Windows: 杀毒/索引器或未退出的构建读者会短暂持有 zcode.cjs 句柄，
 * 就地写入立刻 EBUSY/EPERM。与 prebuilt-binary-extract.mjs 一致，带重试再抛。 */
const STAGE_WRITE_MAX_RETRIES = 10;
const STAGE_WRITE_RETRY_DELAY_MS = 500;

function isTransientLockError(error) {
  return error?.code === "EBUSY" || error?.code === "EPERM" || error?.code === "EACCES";
}

/** 同步重试：仅对短暂占用错误重试，其它错误立即抛出，避免掩盖真正的构建失败。 */
export function retryOnLock(
  operation,
  { maxRetries = STAGE_WRITE_MAX_RETRIES, delayMs = STAGE_WRITE_RETRY_DELAY_MS, sleep } = {},
) {
  const wait =
    sleep ??
    ((ms) => {
      // 同步阻塞等待：构建脚本单线程，无事件循环可让出。
      const until = Date.now() + ms;
      while (Date.now() < until) {
        /* spin */
      }
    });
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (attempt >= maxRetries || !isTransientLockError(error)) {
        throw error;
      }
      wait(delayMs);
    }
  }
}

export function resolveAgentBundlePaths({ repoRoot, platformKey }) {
  const glmDir = resolve(repoRoot, "packages", "desktop", "bundled-agents", platformKey, "glm");
  return {
    cliBundlePath: resolve(repoRoot, AGENT_BUNDLE_SOURCE_RELATIVE),
    glmDir,
    stagedBundlePath: resolve(glmDir, "zcode.cjs"),
    stagedMetaPath: resolve(glmDir, ".node-bundle-meta.json"),
  };
}

/**
 * 干净重建 glm 目录再拷贝。清空是刻意的：electron-builder 整目录拷贝
 * bundled-agents/<平台>/glm → resources/glm，本地工作树里上一次构建残留的原生二进制
 * （zcode-agent / zcode-acp 等）和旧 meta 会被一并打进安装包（CI 干净检出不会有，本地会）。
 */
export function stageAgentBundle({ repoRoot, platformKey, log = console.log }) {
  const { cliBundlePath, glmDir, stagedBundlePath, stagedMetaPath } = resolveAgentBundlePaths({
    repoRoot,
    platformKey,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(`[stage:agent-bundle] agent bundle 源产物不存在：${cliBundlePath}`);
  }
  // 写入 zcode.cjs 之后再落 meta：一个写好的 bundle 配一份陈旧 meta 也比半写的 bundle 配
  // 新 meta 安全（meta 只记来源/入口，运行时按 zcode.cjs 执行）。整段对短暂占用带重试。
  retryOnLock(() => rmSync(glmDir, { recursive: true, force: true }));
  mkdirSync(glmDir, { recursive: true });
  retryOnLock(() => copyFileSync(cliBundlePath, stagedBundlePath));
  const meta = {
    runtime: "electron-node",
    entry: "zcode.cjs",
    platform: platformKey,
    source: AGENT_BUNDLE_SOURCE_RELATIVE,
  };
  retryOnLock(() => writeFileSync(stagedMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8"));
  log(`[stage:agent-bundle] staged ${stagedBundlePath}`);
  return { stagedBundlePath, stagedMetaPath };
}
