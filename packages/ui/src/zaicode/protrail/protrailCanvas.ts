import type { ProtrailClickSink, Rgb255 } from "./protrailClickMath.js";
import type { TrailFrame } from "./protrailTrailGeometry.js";

/**
 * Canvas 2D drawing of ProTrail's primitives: trail segments, the four
 * sparkle shapes, and the click family's rings, discs and particles.
 *
 * Two compositing details keep ProTrail's look on a canvas:
 * - the Soft Glow / Neon outer pass is stroked as runs of one path each
 *   (segments whose alpha, width and colour match to within a step). One path
 *   is one union, so wide translucent glow segments never double up at their
 *   joints (the "bricks" a per-segment glow shows on a curve);
 * - ProTrail's cap policy is FLAT-ROUND for the head segment (flat at the
 *   joint, round at the cursor). A canvas has one cap per stroke, so the
 *   round end is a half disc added past the head, never over the joint.
 */

const rgba = (r: number, g: number, b: number, a: number) =>
  `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

type Segment = TrailFrame["segments"][number];

/** The glow is a soft halo: steps this small do not show, a seam at every joint would. */
function glowKey(s: Segment): string {
  const [r, g, b] = s.color;
  const q = (v: number) => Math.round(v * 10);
  return `${Math.round(s.glow!.alpha * 24)}|${Math.round(s.glow!.width)}|${q(r)}|${q(g)}|${q(b)}`;
}

function strokeRun(ctx: CanvasRenderingContext2D, run: readonly Segment[], alone: boolean): void {
  const first = run[0]!;
  const [r, g, b] = first.color;
  // A frame of one segment has no joint: ROUND-ROUND, like its core.
  ctx.lineCap = alone ? "round" : "butt";
  ctx.strokeStyle = rgba(r * 255, g * 255, b * 255, first.glow!.alpha);
  ctx.lineWidth = first.glow!.width;
  ctx.beginPath();
  ctx.moveTo(first.x1, first.y1);
  for (const s of run) ctx.lineTo(s.x2, s.y2);
  ctx.stroke();
}

function drawGlowRuns(ctx: CanvasRenderingContext2D, segments: readonly Segment[]): void {
  const alone = segments.length === 1;
  let run: Segment[] = [];
  let key = "";
  for (const s of segments) {
    if (!s.glow || !(s.glow.alpha > 0)) {
      if (run.length > 0) strokeRun(ctx, run, alone);
      run = [];
      key = "";
      continue;
    }
    const next = glowKey(s);
    if (next !== key && run.length > 0) {
      strokeRun(ctx, run, alone);
      // The next run starts where this one ended: no gap, no overlap.
      run = [];
    }
    key = next;
    run.push(s);
  }
  if (run.length > 0) strokeRun(ctx, run, alone);
}

/** A round cap on the far end only: a half disc past (x2, y2), facing away from (x1, y1). */
function headCap(ctx: CanvasRenderingContext2D, s: Segment, width: number, style: string): void {
  const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  ctx.fillStyle = style;
  ctx.beginPath();
  ctx.arc(s.x2, s.y2, width / 2, angle - Math.PI / 2, angle + Math.PI / 2);
  ctx.closePath();
  ctx.fill();
}

export function drawTrailFrame(ctx: CanvasRenderingContext2D, frame: TrailFrame): void {
  ctx.lineJoin = "round";
  const segments = frame.segments;
  drawGlowRuns(ctx, segments);
  const last = segments.length - 1;
  segments.forEach((s, index) => {
    if (!(s.alpha > 0)) return;
    const [r, g, b] = s.color;
    const style = rgba(r * 255, g * 255, b * 255, s.alpha);
    // FLAT-ROUND: the head of a multi-segment continuous stroke.
    const flatRound = s.cap === "round" && index === last && last > 0 && segments[last - 1]!.cap === "butt";
    ctx.lineCap = flatRound ? "butt" : s.cap;
    ctx.strokeStyle = style;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
    ctx.stroke();
    if (flatRound) headCap(ctx, s, s.width, style);
  });
  if (last >= 0) {
    const head = segments[last]!;
    if (head.glow && head.glow.alpha > 0 && last > 0 && segments[last - 1]!.cap === "butt") {
      const [r, g, b] = head.color;
      headCap(ctx, head, head.glow.width, rgba(r * 255, g * 255, b * 255, head.glow.alpha));
    }
  }
  for (const k of frame.sparkles) {
    const color = rgba(k.color[0] * 255, k.color[1] * 255, k.color[2] * 255, k.alpha);
    const half = k.size / 2;
    ctx.save();
    ctx.translate(k.x, k.y);
    ctx.rotate(k.rotation);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.beginPath();
    if (k.shape === "cross") {
      ctx.lineWidth = Math.max(1, k.size / 4);
      ctx.lineCap = "round";
      ctx.moveTo(-half, 0);
      ctx.lineTo(half, 0);
      ctx.moveTo(0, -half);
      ctx.lineTo(0, half);
      ctx.stroke();
    } else if (k.shape === "diamond") {
      ctx.moveTo(0, -half);
      ctx.lineTo(half * 0.6, 0);
      ctx.lineTo(0, half);
      ctx.lineTo(-half * 0.6, 0);
      ctx.closePath();
      ctx.fill();
    } else if (k.shape === "triangle") {
      ctx.moveTo(0, -half);
      ctx.lineTo(half * 0.87, half * 0.5);
      ctx.lineTo(-half * 0.87, half * 0.5);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.arc(0, 0, half, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

export function canvasClickSink(ctx: CanvasRenderingContext2D): ProtrailClickSink {
  return {
    bubble(x: number, y: number, radius: number, thickness: number, rgb: Rgb255, ringAlpha: number, fillAlpha: number) {
      if (!(radius > 0)) return;
      if (fillAlpha > 0) {
        ctx.fillStyle = rgba(rgb[0], rgb[1], rgb[2], fillAlpha);
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      if (ringAlpha > 0 && thickness > 0) {
        ctx.strokeStyle = rgba(rgb[0], rgb[1], rgb[2], ringAlpha);
        ctx.lineWidth = thickness;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    },
    particle(x: number, y: number, radius: number, rgb: Rgb255, alpha: number) {
      if (!(radius > 0) || !(alpha > 0)) return;
      ctx.fillStyle = rgba(rgb[0], rgb[1], rgb[2], alpha);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    },
  };
}
