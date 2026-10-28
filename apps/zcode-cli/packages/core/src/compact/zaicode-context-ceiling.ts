/**
 * ZAICODE token economy (T-136 / SRC-100): "the best price/quality, set up under the hood".
 *
 * Auto-compact fires only near the model's own context window. On a 1M-token model a session
 * re-sends up to ~950k tokens on every model step before it compacts: the largest cost driver
 * in a long session (cache reads are cheap per token, not free, and subscription quotas count
 * them), and long-context recall gets worse as the window fills. ZAICODE compacts as if the
 * window were at most 200k tokens; microcompact (old tool results cleared) follows the same
 * ceiling. `ZAICODE_COMPACT_CONTEXT_TOKENS=<n>` moves it, `0` restores the model's window.
 */

export const ZAICODE_COMPACT_CONTEXT_TOKENS = 200_000;

/** Below this a ceiling would compact on every step; such a value is ignored. */
const MIN_CEILING_TOKENS = 32_000;

function zaicodeMode(env: NodeJS.ProcessEnv): boolean {
  return ["1", "true", "on", "yes"].includes((env.ZCODE_ZAICODE_MODE ?? "").trim().toLowerCase());
}

export function resolveZaicodeCompactCeiling(env: NodeJS.ProcessEnv = process.env): number | null {
  if (!zaicodeMode(env)) return null;
  const raw = env.ZAICODE_COMPACT_CONTEXT_TOKENS?.trim();
  if (!raw) return ZAICODE_COMPACT_CONTEXT_TOKENS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return ZAICODE_COMPACT_CONTEXT_TOKENS;
  if (parsed === 0) return null;
  return parsed >= MIN_CEILING_TOKENS ? parsed : ZAICODE_COMPACT_CONTEXT_TOKENS;
}

/** The context window compaction plans for: the model's own, capped by the ZAICODE ceiling. */
export function zaicodeCompactContextWindow(
  modelContextWindow: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const ceiling = resolveZaicodeCompactCeiling(env);
  if (ceiling === null || modelContextWindow === undefined) return modelContextWindow;
  return Math.min(modelContextWindow, ceiling);
}
