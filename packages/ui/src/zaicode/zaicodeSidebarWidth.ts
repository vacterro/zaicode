export const ZAICODE_SIDEBAR_RAIL_WIDTH = 52;
export const ZAICODE_SIDEBAR_RAIL_THRESHOLD = 160;
export const ZAICODE_SIDEBAR_DEFAULT_WIDTH = 264;
export const ZAICODE_SIDEBAR_SNAP_DISTANCE = 12;

/** A short drag snaps to the rail; normal project rows keep room for their controls. */
export function resolveZaicodeSidebarWidth(width: number, maximum = Infinity): number {
  if (width < ZAICODE_SIDEBAR_RAIL_THRESHOLD) return ZAICODE_SIDEBAR_RAIL_WIDTH;
  return Math.round(Math.max(200, Math.min(width, maximum)));
}

/** 交换侧栏后分隔线从右侧往左拖动才是加宽。 */
export function zaicodeSidebarDragWidth(startWidth: number, deltaX: number, swapped: boolean, snap = true): number {
  const width = startWidth + deltaX * (swapped ? -1 : 1);
  // 默认宽度附近磁吸；仅拖动采用，读取用户保存的自定义宽度时不改写。
  return snap && Math.abs(width - ZAICODE_SIDEBAR_DEFAULT_WIDTH) <= ZAICODE_SIDEBAR_SNAP_DISTANCE
    ? ZAICODE_SIDEBAR_DEFAULT_WIDTH : width;
}

export function zaicodeSidebarKeyboardWidth(width: number, direction: -1 | 1, swapped: boolean, step: number): number {
  const expand = direction * (swapped ? -1 : 1) > 0;
  if (expand && width <= ZAICODE_SIDEBAR_RAIL_WIDTH) return 200;
  if (!expand && width <= 200) return ZAICODE_SIDEBAR_RAIL_WIDTH;
  return width + (expand ? step : -step);
}
