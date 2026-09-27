import { ProtrailClickEngine } from "./protrailClickEngine.js";
import { drawProtrailClicks } from "./protrailClickDraw.js";
import { protrailDefaults, type ProtrailConfig } from "./protrailModel.js";
import { buildTrailFrame, type TrailSample } from "./protrailTrailGeometry.js";
import { canvasClickSink, drawTrailFrame } from "./protrailCanvas.js";

/**
 * One ProTrail drawing surface: a click-through canvas, the cursor history,
 * the click engine and the frame loop. It knows nothing about where input
 * comes from, so the same code runs in two places:
 *
 * - inside the ZAICODE window (DOM pointer events, ZaicodeProtrailOverlay);
 * - in the desktop app's per-monitor overlays over the whole Windows desktop
 *   (input from the main process, which reads the mouse like ProTrail does).
 *
 * Like ProTrail, nothing runs while idle: the loop starts on input and stops
 * as soon as no trail, bubble, hold or wake is alive. Timestamps are in the
 * performance.now() domain of the page that owns the canvas.
 */

const MAX_SAMPLES = 512;

export interface ProtrailViewport {
  width: number;
  height: number;
  dpr: number;
}

export class ProtrailRuntime {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly engine = new ProtrailClickEngine(protrailDefaults().click);
  private readonly samples: TrailSample[] = [];
  private head: { x: number; y: number } | null = null;
  private config: ProtrailConfig | null = null;
  private frame = 0;
  private running = false;
  private size = { w: 0, h: 0, scale: 0 };
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly viewport: () => ProtrailViewport,
    private readonly allowed: () => boolean = () => true,
  ) {
    this.ctx = canvas.getContext("2d");
  }

  /** null = ProTrail is off for this surface; everything alive is dropped. */
  setConfig(config: ProtrailConfig | null): void {
    this.config = config;
    this.engine.setConfig(config?.click ?? protrailDefaults().click);
    if (!this.active()) this.clear();
    else this.kick();
  }

  active(): boolean {
    return !this.disposed && !!this.ctx && !!this.config?.enabled && this.allowed();
  }

  move(x: number, y: number, ts: number): void {
    if (!this.active() || !finite(x, y, ts)) return;
    this.samples.push({ x, y, ts });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    this.engine.move(x, y, ts);
    this.head = { x, y };
    this.kick();
  }

  down(button: number, x: number, y: number, ts: number): void {
    if (!this.active() || !finite(x, y, ts)) return;
    this.head = { x, y };
    this.engine.down(button, x, y, ts);
    this.kick();
  }

  up(button: number, x: number, y: number, ts: number): void {
    if (!finite(x, y, ts)) return;
    this.engine.up(button, x, y, ts);
    this.kick();
  }

  /** `buttons` is the real button state (DOM bits: 1 left, 2 right, 4 middle); a lost button-up ends its hold. */
  reconcile(buttons: number, x: number, y: number, ts: number): void {
    this.engine.reconcile(buttons, x, y, ts);
  }

  /** The pointer left this surface (window blur, pointer cancel): no hold may keep charging. */
  leave(): void {
    this.engine.holds = [];
    this.head = null;
    this.kick();
  }

  clear(): void {
    this.samples.length = 0;
    this.head = null;
    this.engine.clear();
    if (this.ctx) {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.running = false;
    this.clear();
  }

  kick(): void {
    if (this.running || !this.active()) return;
    this.running = true;
    this.frame = requestAnimationFrame(this.draw);
  }

  private fit(): number {
    const pixel = this.config?.pixelSize ?? 1;
    const view = this.viewport();
    const scale = pixel > 1 ? 1 / pixel : view.dpr || 1;
    if (this.size.w === view.width && this.size.h === view.height && this.size.scale === scale) return scale;
    this.size = { w: view.width, h: view.height, scale };
    this.canvas.width = Math.max(1, Math.round(view.width * scale));
    this.canvas.height = Math.max(1, Math.round(view.height * scale));
    this.canvas.style.imageRendering = pixel > 1 ? "pixelated" : "auto";
    return scale;
  }

  private readonly draw = (): void => {
    this.frame = 0;
    try {
      this.drawFrame();
    } catch (error) {
      // One bad frame must not leave `running` stuck on: that would silence
      // ProTrail until the page reloads. Drop what is alive and start clean.
      console.error("[protrail] frame failed", error);
      this.running = false;
      this.clear();
    }
  };

  private drawFrame(): void {
    const ctx = this.ctx;
    const config = this.config;
    if (!ctx) return;
    const now = performance.now();
    const scale = this.fit();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!config || !this.active()) {
      this.running = false;
      return;
    }
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const trail = config.trail;
    // Old samples leave; a generous margin keeps the synthetic tail's anchor.
    while (this.samples.length > 0 && this.samples[0]!.ts < now - trail.lifetimeMs - 250) this.samples.shift();
    drawTrailFrame(ctx, buildTrailFrame(this.samples, now, trail, this.head));
    this.engine.prune(now);
    drawProtrailClicks(this.engine, now, canvasClickSink(ctx));
    const trailAlive = trail.enabled && this.samples.some((sample) => sample.ts >= now - trail.lifetimeMs);
    if (trailAlive || this.engine.hasLive(now)) this.frame = requestAnimationFrame(this.draw);
    else this.running = false;
  }
}

function finite(x: number, y: number, ts: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(ts);
}
