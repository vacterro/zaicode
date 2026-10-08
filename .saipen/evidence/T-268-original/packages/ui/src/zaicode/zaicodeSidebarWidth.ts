export const ZAICODE_SIDEBAR_RAIL_WIDTH = 52;
export const ZAICODE_SIDEBAR_RAIL_THRESHOLD = 160;

/** A short drag snaps to the rail; normal project rows keep room for their controls. */
export function resolveZaicodeSidebarWidth(width: number, maximum = Infinity): number {
  if (width < ZAICODE_SIDEBAR_RAIL_THRESHOLD) return ZAICODE_SIDEBAR_RAIL_WIDTH;
  return Math.round(Math.max(200, Math.min(width, maximum)));
}

/** 交换侧栏后分隔线从右侧往左拖动才是加宽。 */
export function zaicodeSidebarDragWidth(startWidth: number, deltaX: number, swapped: boolean): number {
  return startWidth + deltaX * (swapped ? -1 : 1);
}

export function zaicodeSidebarKeyboardWidth(width: number, direction: -1 | 1, swapped: boolean, step: number): number {
  const expand = direction * (swapped ? -1 : 1) > 0;
  if (expand && width <= ZAICODE_SIDEBAR_RAIL_WIDTH) return 200;
  if (!expand && width <= 200) return ZAICODE_SIDEBAR_RAIL_WIDTH;
  return width + (expand ? step : -step);
}
