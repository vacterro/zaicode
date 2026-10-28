import {
  ZAICODE_PROTRAIL_EVENT_STRIDE,
  ZAICODE_PROTRAIL_INPUT_DOWN,
  ZAICODE_PROTRAIL_INPUT_MOVE,
  ZaicodeProtrailClock,
  type ZaicodeProtrailOverlayFeed,
} from "@zcode/shared";
import { ProtrailRuntime, normalizeProtrailConfig } from "@zcode/ui/zaicode-protrail";

/**
 * One monitor's ProTrail overlay (SRC-062). The main process feeds it the
 * config, this monitor's origin on the desktop and every mouse event in
 * desktop coordinates; the page moves them into its own coordinates and
 * clock and runs the same engine the ZAICODE window runs.
 */

declare global {
  interface Window {
    zaicodeProtrailOverlay?: {
      onFeed(callback: (feed: ZaicodeProtrailOverlayFeed) => void): () => void;
    };
    /** Answers the main process's health check (T-129): what this page holds and whether it draws frames. */
    __zaicodeProtrailProbe?: () => Promise<{ configured: boolean; enabled: boolean; width: number; height: number; frames: boolean }>;
  }
}

const canvas = document.getElementById("protrail") as HTMLCanvasElement | null;
const bridge = window.zaicodeProtrailOverlay;

if (canvas && bridge) {
  const runtime = new ProtrailRuntime(canvas, () => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  }));
  const clock = new ZaicodeProtrailClock();
  let origin = { x: 0, y: 0 };

  bridge.onFeed((feed) => {
    if (feed.origin) origin = { x: feed.origin.x, y: feed.origin.y };
    if ("config" in feed) runtime.setConfig(feed.config == null ? null : normalizeProtrailConfig(feed.config));
    const events = feed.events;
    if (!events || events.length < ZAICODE_PROTRAIL_EVENT_STRIDE) return;
    const now = performance.now();
    clock.observe(events[events.length - 1]!, now);
    for (let i = 0; i + ZAICODE_PROTRAIL_EVENT_STRIDE <= events.length; i += ZAICODE_PROTRAIL_EVENT_STRIDE) {
      const kind = events[i]!;
      const button = events[i + 1]!;
      const x = events[i + 2]! - origin.x;
      const y = events[i + 3]! - origin.y;
      const ts = clock.map(events[i + 4]!, now);
      if (kind === ZAICODE_PROTRAIL_INPUT_MOVE) runtime.move(x, y, ts);
      else if (kind === ZAICODE_PROTRAIL_INPUT_DOWN) runtime.down(button, x, y, ts);
      else runtime.up(button, x, y, ts);
    }
  });
  window.addEventListener("resize", () => runtime.kick());
  window.__zaicodeProtrailProbe = () =>
    new Promise((resolve) => {
      let answered = false;
      const answer = (frames: boolean) => {
        if (answered) return;
        answered = true;
        resolve({
          configured: runtime.configured(),
          enabled: runtime.active(),
          width: window.innerWidth,
          height: window.innerHeight,
          frames,
        });
      };
      // A window whose compositor makes no frames never runs the callback: that is the answer.
      const silence = window.setTimeout(() => answer(false), 900);
      window.requestAnimationFrame(() => {
        window.clearTimeout(silence);
        answer(true);
      });
    });
}
