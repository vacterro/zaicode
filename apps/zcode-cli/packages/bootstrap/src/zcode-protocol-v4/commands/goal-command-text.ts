// Goal 命令的纯文本解析与队列显示格式；不读取 runtime，不改变目标状态。
export function parseGoalObjectiveFromCommandText(text: string): string {
  const trimmed = text.trim();
  const match = /^\/(?:goal|target)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return trimmed;
  const args = match[1]?.trim() ?? "";
  return args.replace(/^replace\s+/i, "").trim();
}

export function goalCommandQueueText(displayText: string | undefined, objective: string): string {
  const trimmed = displayText?.trim();
  return trimmed ? trimmed : `/goal ${objective}`;
}
