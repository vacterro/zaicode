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
