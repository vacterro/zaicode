/* T-241 / CORE-001 — 两个仓库共用持久化 JSON 边界：损坏的工具策略不能变成 {} 后沿用 yolo 默认，
   损坏的模型/委托字段也不能变成 undefined。仅 SQL NULL 和历史空串表示缺失；读取绝不改写原始字节。 */
export function readZaicodePersistedJson<T>(
  column: string,
  value: string | null,
  schema: {
    safeParse: (
      candidate: unknown,
    ) => { success: true; data: T } | { success: false; error: { issues: { message: string }[] } };
  },
): { malformed: string } | { value: T | undefined } {
  if (value === null || value === "") return { value: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { malformed: `${column} is not valid JSON` };
  }
  const result = schema.safeParse(parsed);
  return result.success
    ? { value: result.data }
    : {
        malformed: `${column} does not match the persisted contract: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
      };
}
