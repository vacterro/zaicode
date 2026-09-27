/**
 * The ProTrail engine without ZAICODE's React UI or settings store: what the
 * desktop app's per-monitor overlay pages load (@zcode/ui/zaicode-protrail).
 */
export { ProtrailRuntime, type ProtrailViewport } from "./protrailRuntime.js";
export { normalizeProtrailConfig } from "./protrailNormalize.js";
export type { ProtrailConfig } from "./protrailModel.js";
