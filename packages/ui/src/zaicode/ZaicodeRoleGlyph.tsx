import { ZAICODE_ROLE_META, type ZaicodeSessionRole } from "./zaicodeSessionRoles.js";

/**
 * 10x10 pixel glyphs for session roles, drawn as whole-pixel rects with crisp
 * edges: they stay sharp at 100% and never pick up an emoji font's color or
 * smoothing. One shape per role, so MAIN, side sessions and every subSaipen
 * worker read apart at a glance.
 */
const BITMAPS: Record<ZaicodeSessionRole | "MAIN" | "SIDE", readonly string[]> = {
  MAIN: [
    "....##....",
    "...####...",
    "..######..",
    ".########.",
    "##########",
    "##########",
    ".########.",
    "..######..",
    "...####...",
    "....##....",
  ],
  SIDE: [
    "....##....",
    "...#..#...",
    "..#....#..",
    ".#......#.",
    "#........#",
    "#........#",
    ".#......#.",
    "..#....#..",
    "...#..#...",
    "....##....",
  ],
  WIKI: [
    "..........",
    ".###..###.",
    "#...##...#",
    "#.#.##.#.#",
    "#...##...#",
    "#.#.##.#.#",
    "#...##...#",
    ".###..###.",
    "....##....",
    "..........",
  ],
  TRANSL: [
    "...####...",
    "..#.##.#..",
    ".#..##..#.",
    "##########",
    "#...##...#",
    "#...##...#",
    "##########",
    ".#..##..#.",
    "..#.##.#..",
    "...####...",
  ],
  TEST: [
    "...####...",
    "....##....",
    "....##....",
    "....##....",
    "...#..#...",
    "..#....#..",
    ".#.####.#.",
    "#.######.#",
    "#.######.#",
    ".########.",
  ],
  AUDIT: [
    "..####....",
    ".#....#...",
    "#......#..",
    "#......#..",
    "#......#..",
    ".#....#...",
    "..####.#..",
    ".......##.",
    "........##",
    ".........#",
  ],
  HUNT: [
    "....##....",
    "..######..",
    ".#..##..#.",
    ".#......#.",
    "####..####",
    "####..####",
    ".#......#.",
    ".#..##..#.",
    "..######..",
    "....##....",
  ],
  CLEAN: [
    ".......##.",
    "......##..",
    ".....##...",
    "....##....",
    "...##.....",
    "..####....",
    ".######...",
    "#######...",
    "#.#.#.#...",
    "#.#.#.#...",
  ],
  CREW: [
    ".##....##.",
    "####..####",
    ".##....##.",
    "..........",
    ".##....##.",
    "####..####",
    "####..####",
    "####..####",
    "..........",
    "..........",
  ],
};

function rectsOf(bitmap: readonly string[]): { x: number; y: number; w: number }[] {
  const rects: { x: number; y: number; w: number }[] = [];
  bitmap.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x += 1) {
      const on = row[x] === "#";
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        rects.push({ x: start, y, w: x - start });
        start = -1;
      }
    }
  });
  return rects;
}

const RECTS = Object.fromEntries(Object.entries(BITMAPS).map(([key, bitmap]) => [key, rectsOf(bitmap)])) as Record<
  keyof typeof BITMAPS,
  { x: number; y: number; w: number }[]
>;

export function ZaicodeRoleGlyph({
  role,
  color,
  title,
}: {
  role: ZaicodeSessionRole | "MAIN" | "SIDE";
  color?: string;
  title?: string;
}) {
  const fill =
    color ??
    (role === "MAIN"
      ? "var(--zaicode-highlight, var(--color-warning))"
      : role === "SIDE"
        ? "var(--color-foreground-subtle, #8d8672)"
        : ZAICODE_ROLE_META[role].color);
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      shapeRendering="crispEdges"
      className="shrink-0"
      role="img"
      aria-label={title ?? role}
      data-zaicode-pixel-filter=""
      data-zaicode-role-glyph={role}
    >
      {title ? <title>{title}</title> : null}
      {RECTS[role].map((rect) => (
        <rect key={`${rect.x}-${rect.y}`} x={rect.x} y={rect.y} width={rect.w} height={1} fill={fill} />
      ))}
    </svg>
  );
}
