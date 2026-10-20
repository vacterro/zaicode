import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OPERATOR_CARRIER_ENV = "SAIPEN_TASK_FILE";
const OPERATOR_CARRIER_ROOT = "zaicode-saipen-operator-carrier";
const OPERATOR_CARRIER_FILE = "operator-task.txt";
const REQUEST_DIRECTORY_PREFIX = "request-";
const PROJECT_SCOPE_HASH_LENGTH = 16;

/**
 * Request-local transport only; admission already classified operatorText.
 * Existing declared carriers win and automatic/model calls declare nothing.
 * Files survive replies because canonical resume commands can reference them.
 */
export async function buildSaipenContinueChildEnv(
  env: NodeJS.ProcessEnv,
  projectPath: string,
  operatorText: string | undefined,
): Promise<NodeJS.ProcessEnv> {
  // 先保留 process.env 在 Windows 上的大小写查询语义，再冻结本次 child 的环境。
  const declared = env.SAIPEN_TASK_SHA256?.trim() || env[OPERATOR_CARRIER_ENV]?.trim();
  const inherited = { ...env };
  if (declared) return inherited;
  const text = typeof operatorText === "string" ? operatorText.trim() : "";
  if (!text) return inherited;
  try {
    const scope = createHash("sha256")
      .update(String(projectPath ?? ""))
      .digest("hex")
      .slice(0, PROJECT_SCOPE_HASH_LENGTH);
    const directory = join(tmpdir(), OPERATOR_CARRIER_ROOT, scope);
    await mkdir(directory, { recursive: true });
    // 同项目多会话不能覆盖在途请求；每次声明独占目录，写完后才交给 launcher 读取。
    const requestDirectory = await mkdtemp(join(directory, REQUEST_DIRECTORY_PREFIX));
    const file = join(requestDirectory, OPERATOR_CARRIER_FILE);
    await writeFile(file, text, { encoding: "utf8", flag: "wx" });
    return { ...inherited, [OPERATOR_CARRIER_ENV]: file };
  } catch {
    // 创建失败不伪造 witness，保持原有的低权限环境，由 canonical 边界给出实际拒绝。
    return inherited;
  }
}
