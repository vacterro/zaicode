/**
 * ZAICODE self-protection (SRC-044/SRC-046).
 *
 * 缘由：2026-09-25 一个在 ZAICODE 里运行的 agent 收到 `/goal cc all` 后执行了
 * `taskkill //F //IM ZAICODE.exe //T`——根目录 launcher 与桌面应用同名 ZAICODE.exe，
 * 于是 launcher、应用和同时运行的 8 个 agent 会话一起被杀，launcher 也来不及记录或重启。
 * yolo 模式放行一切 Bash，所以这里在权限判定最前面按命令文本拦截
 * "按映像名 / 进程名 / 管道筛选结束 ZAICODE 进程" 这一类命令；按 PID 结束自己启动的进程不受影响。
 */

export const ZAICODE_SELF_KILL_RULE_ID = "zaicode.selfProtect.kill";

export const ZAICODE_SELF_KILL_REASON =
  "ZAICODE: refused -- this command stops ZAICODE processes by name, image or path. ZAICODE runs you and every other session (its launcher has the same image name), so it would kill all of them at once. Stop only processes you started yourself, by PID (Stop-Process -Id <pid> / taskkill /PID <pid>), and never the app, its launcher or its agents. A locked build output is fine: the ZAICODE bundler stages into dist-next while the app runs.";

const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

/**
 * The ZAICODE image as a process / file name: `ZAICODE`, `ZAICODE.exe`, `…\ZAICODE.exe`.
 * Not a directory component (`_ZAICODE\`, `src/zaicode/`), not `.zaicode` data folders,
 * not other files (`ZAICODE.ps1`, `zaicodeWorkers.ts`).
 */
const ZAICODE_IMAGE = String.raw`(?<![\w.-])zaicode(?:\.exe)?(?![\w\\/.-])`;

/** `taskkill /IM ZAICODE.exe`, `taskkill /FI "IMAGENAME eq ZAICODE.exe"` (git-bash `//IM` is normalized first). */
const TASKKILL_BY_IMAGE = new RegExp(
  String.raw`\btaskkill\b[^|;&\n]*?(?:[/-]im\s+["']?[^\s"']*?${ZAICODE_IMAGE}|imagename\s+eq\s+${ZAICODE_IMAGE})`,
  "i",
);

/** `Stop-Process -Name ZAICODE`, `spps -ProcessName ZAICODE*`, `kill -Name ZAICODE`. */
const STOP_PROCESS_BY_NAME = new RegExp(
  String.raw`\b(?:stop-process|spps|kill)\b[^|;&\n]*?-(?:process)?name\s+["']?\*?${ZAICODE_IMAGE}`,
  "i",
);

/** `pkill ZAICODE`, `killall ZAICODE.exe`, `tskill ZAICODE`. */
const POSIX_KILL_BY_NAME = new RegExp(String.raw`\b(?:pkill|killall|tskill)\b[^|;&\n]*?${ZAICODE_IMAGE}`, "i");

/** A process list in the same statement (the thing a pipeline filters and then kills). */
const PROCESS_ENUMERATOR =
  /\b(?:get-process|gps|get-ciminstance\s+(?:-classname\s+)?win32_process|get-wmiobject\s+(?:-class\s+)?win32_process|gwmi\s+win32_process|wmic\s+process)\b/i;

/** Something in the same statement that ends a process. */
const PROCESS_TERMINATOR =
  /\b(?:stop-process|spps|kill|terminate|remove-ciminstance|remove-wmiobject|invoke-cimmethod)\b|\.kill\s*\(|\bdelete\b/i;

/** Statement boundaries: `;`, `&&`, `||`, newlines (a pipeline `|` stays inside one statement). */
function statementsOf(command: string): string[] {
  return command.split(/\r?\n|;|&&|\|\|/);
}

/** True when `command` would stop ZAICODE processes by name, image or path filter. */
export function isZaicodeSelfKillCommand(command: string): boolean {
  // Git Bash spells cmd switches with a doubled slash (`taskkill //F //IM`).
  const normalized = command.replace(/\/\/(?=[a-z])/gi, "/");
  if (TASKKILL_BY_IMAGE.test(normalized)) return true;
  if (STOP_PROCESS_BY_NAME.test(normalized)) return true;
  if (POSIX_KILL_BY_NAME.test(normalized)) return true;
  const image = new RegExp(ZAICODE_IMAGE, "i");
  return statementsOf(normalized).some(
    (statement) => PROCESS_ENUMERATOR.test(statement) && PROCESS_TERMINATOR.test(statement) && image.test(statement),
  );
}

function shellCommandOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}

/** Deny decision for a shell tool call that would kill ZAICODE; undefined otherwise. */
export function resolveZaicodeSelfProtection(context: {
  toolName: string;
  input: unknown;
}): { behavior: "deny"; reason: string; ruleId: string } | undefined {
  if (!SHELL_TOOL_NAMES.has(context.toolName)) return undefined;
  const command = shellCommandOf(context.input);
  if (!command || !isZaicodeSelfKillCommand(command)) return undefined;
  return { behavior: "deny", reason: ZAICODE_SELF_KILL_REASON, ruleId: ZAICODE_SELF_KILL_RULE_ID };
}
