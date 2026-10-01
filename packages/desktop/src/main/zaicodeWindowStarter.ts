/**
 * T-136 / SRC-100: "if ZAICODE sees '5h limit starts at first use', start that window at once
 * so the 5 hours keep rolling instead of waiting for me -- and spend next to nothing."
 *
 * A vendor window that has not started resets a full window after the first request. ZAICODE
 * sends that first request itself, the smallest one the account's own CLI can make: no tools,
 * a one-line system prompt, a one-word answer, the cheapest model, nothing saved as a session.
 * Pure argument builders and result readers; the main process runs them (zaicodeEngines.ts).
 */

export const ZAICODE_WINDOW_START_PROMPT = "Reply with the single word: ok";

/**
 * `claude -p` with no tools, no MCP, no user hooks (only project settings, and the probe folder has
 * none). Measured 2026-09-30 on a Max account: 701 input and 48 output tokens, answer "ok".
 */
export function claudeWindowStartArgs(): string[] {
  return [
    "-p",
    ZAICODE_WINDOW_START_PROMPT,
    "--model",
    "haiku",
    "--tools",
    "",
    "--system-prompt",
    "Answer with one word.",
    "--strict-mcp-config",
    "--setting-sources",
    "project",
    "--no-session-persistence",
    "--output-format",
    "json",
  ];
}

/**
 * `codex exec`, read-only sandbox, low reasoning, no session file, outside any repository, without
 * the user's config.toml (its hooks and MCP servers) and rules. Measured 2026-09-30: 18.4k input
 * tokens (Codex's own instructions and tool list, mostly cached) and 5 output tokens; the CLI has no
 * smaller request.
 */
export function codexWindowStartArgs(): string[] {
  return [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "-c",
    "model_reasoning_effort=low",
    ZAICODE_WINDOW_START_PROMPT,
  ];
}

/** Headless Flash request: the vendor still charges its actual input/output tokens. */
export function antigravityWindowStartArgs(): string[] {
  return [
    "-p",
    ZAICODE_WINDOW_START_PROMPT,
    "--model",
    "gemini-3.5-flash-medium",
    "--effort",
    "low",
    "--sandbox",
    "--output-format",
    "json",
  ];
}

const ZCODE_CODING_ORIGINS = new Set(["https://api.z.ai", "https://open.bigmodel.cn"]);
const ZCODE_CODING_PATH = "/api/coding/paas/v4";

/** Resolve only a plan API endpoint; a general/prepaid endpoint is never a start target. */
export function zcodeWindowStartRequest(baseUrl: string, providerId = "builtin:zai-coding-plan") {
  const fallback = providerId.includes("bigmodel")
    ? `https://open.bigmodel.cn${ZCODE_CODING_PATH}`
    : `https://api.z.ai${ZCODE_CODING_PATH}`;
  let configured: URL;
  try {
    configured = new URL(baseUrl.trim() || fallback);
  } catch {
    return null;
  }
  if (
    !ZCODE_CODING_ORIGINS.has(configured.origin) ||
    configured.username ||
    configured.password ||
    configured.search ||
    configured.hash ||
    ![ZCODE_CODING_PATH, "/api/anthropic", "/api/anthropic/v1"].includes(configured.pathname.replace(/\/+$/, ""))
  ) return null;
  return {
    url: `${configured.origin}${ZCODE_CODING_PATH}/chat/completions`,
    body: {
      model: "GLM-5.3-Flash",
      messages: [{ role: "user", content: ZAICODE_WINDOW_START_PROMPT }],
      max_tokens: 1,
      stream: false,
    },
  } as const;
}

export interface ZaicodeWindowStartOutcome {
  ok: boolean;
  detail: string;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 160) ?? "";
}

/** Reads `claude -p --output-format json`: an answer that is not an error started the window. */
export function readClaudeWindowStart(ok: boolean, stdout: string, error: string): ZaicodeWindowStartOutcome {
  type ClaudePrint = {
    is_error?: unknown;
    result?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  let payload: ClaudePrint | null = null;
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      payload = JSON.parse(stdout.slice(start, end + 1)) as ClaudePrint;
    } catch {
      payload = null;
    }
  }
  if (!payload) return { ok: false, detail: error || firstLine(stdout) || "claude gave no answer" };
  if (payload.is_error === true) {
    const said = typeof payload.result === "string" ? firstLine(payload.result) : "";
    return { ok: false, detail: said || error || "claude reported an error" };
  }
  const input = Number(payload.usage?.input_tokens);
  const output = Number(payload.usage?.output_tokens);
  const tokens =
    Number.isFinite(input) && Number.isFinite(output) ? ` (${input} in / ${output} out tokens)` : "";
  return { ok: ok || payload.is_error === false, detail: `started with one haiku request${tokens}` };
}

/** Reads `codex exec`: exit 0 means the request went through. */
export function readCodexWindowStart(ok: boolean, stdout: string, error: string): ZaicodeWindowStartOutcome {
  if (ok) return { ok: true, detail: "started with one low-effort codex exec" };
  return { ok: false, detail: error || firstLine(stdout) || "codex exec failed" };
}

/** Antigravity's JSON status is authoritative even when its process exits successfully. */
export function readAntigravityWindowStart(ok: boolean, stdout: string, error: string): ZaicodeWindowStartOutcome {
  let payload: { status?: unknown; usage?: { total_tokens?: unknown }; error?: unknown };
  try {
    payload = JSON.parse(stdout) as typeof payload;
  } catch {
    return { ok: false, detail: error || firstLine(stdout) || "Antigravity gave no JSON answer" };
  }
  if (!ok || payload.status !== "SUCCESS") {
    return { ok: false, detail: typeof payload.error === "string" ? firstLine(payload.error) : error || "Antigravity did not complete" };
  }
  const tokens = payload.usage?.total_tokens;
  return { ok: true, detail: `started with one Flash request${typeof tokens === "number" ? ` (${tokens} tokens)` : ""}` };
}

/** The response body is never included on failure: it may contain provider diagnostics. */
export function readZcodeWindowStart(status: number, body: string): ZaicodeWindowStartOutcome {
  if (status < 200 || status >= 300) return { ok: false, detail: `HTTP ${status}` };
  let payload: { choices?: unknown; usage?: { total_tokens?: unknown } };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return { ok: false, detail: "ZCode returned invalid JSON" };
  }
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
    return { ok: false, detail: "ZCode returned no completion" };
  }
  const tokens = payload.usage?.total_tokens;
  return { ok: true, detail: `started with one Coding Plan request${typeof tokens === "number" ? ` (${tokens} tokens)` : ""}` };
}
