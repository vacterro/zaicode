/**
 * ZAICODE shows the machine's local time. A `TZ` variable inherited from
 * whatever started ZAICODE (a shell, an agent harness: `TZ=UTC` was seen
 * on 2026-09-25) moves every clock, timer and quota reset by the zone
 * offset, in main, in every renderer and in the agent processes, because
 * they all inherit this process's environment. Remove it before anything
 * is spawned; keep the original value for diagnostics.
 */
export function applyZaicodeLocalTimeZone(env: NodeJS.ProcessEnv = process.env): string | null {
  const inherited = env.TZ;
  if (!inherited) return null;
  env.ZAICODE_INHERITED_TZ = inherited;
  // 修复：继承的 TZ（如 UTC）让时钟与额度重置时间整体偏移时区差；删除后 Node 会重置时区缓存。
  delete env.TZ;
  return inherited;
}

/**
 * Removing TZ from this process is not enough: Chromium and the renderers
 * fixed their zone while TZ was still set (seen 2026-09-25: the title bar
 * clock showed UTC although the machine runs FLE time). A packaged app that
 * inherited TZ therefore starts itself once more, without it. The marker
 * variable stops a loop when TZ comes back from the system environment.
 */
export function shouldRelaunchForLocalTimeZone(
  inherited: string | null,
  options: { packaged: boolean; env?: NodeJS.ProcessEnv },
): boolean {
  const env = options.env ?? process.env;
  if (!inherited || !options.packaged) return false;
  if (env.ZAICODE_TZ_RELAUNCHED === "1") return false;
  env.ZAICODE_TZ_RELAUNCHED = "1";
  return true;
}
