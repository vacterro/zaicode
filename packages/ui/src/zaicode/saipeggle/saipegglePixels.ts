/**
 * Whole-pixel drawing for SAIPEGGLE: discs, capsules and thick lines filled
 * with fillRect runs at integer coordinates. No arc(), no stroke(): nothing
 * the canvas would anti-alias ever reaches the screen.
 */

type Ctx = CanvasRenderingContext2D;

/** A filled disc of radius `r` centred on the pixel nearest (x, y). */
export function pxDisc(ctx: Ctx, x: number, y: number, r: number, color: string): void {
  const cx = Math.round(x);
  const cy = Math.round(y);
  ctx.fillStyle = color;
  for (let dy = -r; dy <= r; dy += 1) {
    // (r + 0.5)^2: round pixel discs without one-pixel spikes at the poles.
    const half = Math.floor(Math.sqrt((r + 0.5) * (r + 0.5) - dy * dy));
    ctx.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
  }
}

/** A round peg / ball: a shaded rim, the body, a two-pixel glint. */
export function pxBead(ctx: Ctx, x: number, y: number, r: number, body: string, rim: string, glint: string): void {
  pxDisc(ctx, x, y, r, rim);
  pxDisc(ctx, x - 0.4, y - 0.4, r - 1, body);
  const cx = Math.round(x);
  const cy = Math.round(y);
  ctx.fillStyle = glint;
  const g = Math.max(1, Math.floor(r / 2));
  ctx.fillRect(cx - g, cy - g, r > 3 ? 2 : 1, 1);
  if (r > 3) ctx.fillRect(cx - g, cy - g + 1, 1, 1);
}

/**
 * A brick: a capsule of half length `half` and radius `r` along `angle`.
 * Pixels on the lower side of its axis take the shade colour.
 */
export function pxCapsule(ctx: Ctx, x: number, y: number, angle: number, half: number, r: number, body: string, shade: string, glint: string): void {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  // The normal that points down the screen.
  let nx = -uy;
  let ny = ux;
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const reach = Math.ceil(half + r + 1);
  const cx = Math.round(x);
  const cy = Math.round(y);
  for (let py = -reach; py <= reach; py += 1) {
    for (let px = -reach; px <= reach; px += 1) {
      const dx = cx + px - x;
      const dy = cy + py - y;
      const t = Math.max(-half, Math.min(half, dx * ux + dy * uy));
      const ex = dx - ux * t;
      const ey = dy - uy * t;
      const d = Math.hypot(ex, ey);
      if (d > r + 0.25) continue;
      const side = ex * nx + ey * ny;
      ctx.fillStyle = side > r - 1.2 ? shade : side < -(r - 0.8) && Math.abs(t) < half - 1 ? glint : body;
      ctx.fillRect(cx + px, cy + py, 1, 1);
    }
  }
}

/** A line `width` pixels thick from (x0, y0) to (x1, y1). */
export function pxLine(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, width: number, color: string): void {
  ctx.fillStyle = color;
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  const half = Math.floor(width / 2);
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    ctx.fillRect(Math.round(x0 + (x1 - x0) * t) - half, Math.round(y0 + (y1 - y0) * t) - half, width, width);
  }
}

/** A rectangle outline one pixel wide. */
export function pxFrame(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, 1);
  ctx.fillRect(x, y + h - 1, w, 1);
  ctx.fillRect(x, y, 1, h);
  ctx.fillRect(x + w - 1, y, 1, h);
}

/** A raised panel: fill, a light top-left edge and a dark bottom-right edge (Win95 bevel, pixel exact). */
export function pxPanel(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string, light: string, dark: string): void {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = light;
  ctx.fillRect(x, y, w - 1, 1);
  ctx.fillRect(x, y, 1, h - 1);
  ctx.fillStyle = dark;
  ctx.fillRect(x, y + h - 1, w, 1);
  ctx.fillRect(x + w - 1, y, 1, h);
}
