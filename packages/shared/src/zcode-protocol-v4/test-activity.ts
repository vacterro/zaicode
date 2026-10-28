import type { ConversationSnapshot } from "./snapshot.js";
import type { SessionSummary } from "./sessions-index.js";

/** Recognize executed test commands, never prose such as `echo "npm test"`. */
export function isTestExecutionCommand(value: unknown): value is string {
  if (typeof value !== "string") return false;
  // 分隔符只在引号外切分，避免把输出文本里的命令当成执行。
  const segments: string[] = [];
  let start = 0;
  let quote = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "\\" || char === "`") { i++; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/[;&|\n]/.test(char)) { segments.push(value.slice(start, i)); start = i + 1; }
  }
  segments.push(value.slice(start));
  return segments.some((segment) => {
    const command = segment.trim().replace(/^(?:[\w]+=[^\s]+\s+)+/, "");
    const words = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)?.map((word) => word.replace(/^['"]|['"]$/g, "")) ?? [];
    if (words[0] === "&") words.shift();
    let name = (words.shift() ?? "").split(/[\\/]/).pop()!.replace(/\.(?:exe|cmd|ps1)$/i, "").toLowerCase();
    if (name === "npx" || name === "uv") { if (words[0] === "run") words.shift(); name = (words.shift() ?? "").toLowerCase(); }
    if (["pytest", "jest", "vitest", "ctest", "invoke-pester"].includes(name)) return words[0] !== "--help" && words[0] !== "--version";
    if (["python", "python3", "py"].includes(name)) return words[0] === "-m" && /^(pytest|unittest)$/.test(words[1] ?? "");
    if (name === "node") return words.includes("--test");
    if (["cargo", "go", "dotnet", "mvn", "gradle", "gradlew", "playwright"].includes(name)) return words[0] === "test";
    if (["npm", "pnpm", "yarn", "bun"].includes(name)) {
      if (words[0] === "--dir" || words[0] === "--prefix" || words[0] === "--filter" || words[0] === "-C") words.splice(0, 2);
      if (["run", "exec"].includes(words[0] ?? "")) words.shift();
      return /^(?:test(?::[^\s]+)?|vitest|jest)$/.test(words[0] ?? "") || (words[0] === "playwright" && words[1] === "test") || (words[0] === "node" && words.includes("--test"));
    }
    return false;
  });
}

/** The same running tool/work identities are counted once through a background handoff. */
export function deriveSessionTestActivity(snapshot: ConversationSnapshot): SessionSummary["testActivity"] {
  const commands = new Map<string, string>();
  for (const work of snapshot.backgroundWorks) {
    if (work.kind === "bash" && work.status === "running" && isTestExecutionCommand(work.command)) commands.set(work.workId, work.command);
  }
  if (!snapshot.control.sessionEnded) {
    for (const row of snapshot.rows.window) {
      if (row.kind !== "toolCall" || row.status !== "running" || row.backgrounded || !/^(?:Bash|Execute|execute)$/i.test(row.toolName)) continue;
      const input = row.input as { command?: unknown } | undefined;
      if (isTestExecutionCommand(input?.command)) commands.set(row.workId ?? row.toolCallId, input.command);
    }
  }
  return commands.size ? { count: commands.size, commands: [...commands.values()].slice(0, 3).map((command) => command.slice(0, 160)) } : undefined;
}
