import type { AimTarget } from "./saiasuiEngine.js";
import type { SaiasuiConfig } from "./saiasuiConfig.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { targetPoint, type SaiasuiRun } from "./saiasuiEngine.js";
import { SAIASUI_BODY_STROKE, saiasuiTargetShape } from "./saiasuiTargetShape.js";

const LABEL = { normal: "", god: "GOD", slow: "SLOW", full: "FULL", moving: "MOVE", tiny: "+HP" };

export function SaiasuiTarget({
  target,
  run,
  config,
  width,
  height,
  reducedMotion,
  onHit,
}: {
  target: AimTarget;
  run: SaiasuiRun;
  config: SaiasuiConfig;
  width: number;
  height: number;
  reducedMotion: boolean;
  onHit: (id: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const now = run.elapsed;
  const p = targetPoint(target, now, run, reducedMotion);
  const { radius, ringReach, extent } = saiasuiTargetShape(target, now, config);
  const x = 78 + p.x * Math.max(0, width - 156);
  const y = 128 + p.y * Math.max(0, height - 224);
  const accent =
    config.colorMode === "mono"
      ? "var(--color-foreground)"
      : target.kind === "normal" || target.kind === "moving"
        ? "var(--zaicode-highlight,var(--color-warning))"
        : "var(--color-success)";
  return (
    <div
      className="pointer-events-none absolute"
      style={{ left: x, top: y, opacity: config.targetOpacity }}
    >
      {/*
        The ball is drawn, not styled: ZAICODE forces `border-radius: 0 !important` on
        every element, so a bordered button was a square and its circular clip-path cut
        the border down to four slivers. An SVG circle stays round, and this SVG opts
        out of the pixel threshold filter (data-zaicode-pixel-filter) which eats thin
        strokes. It is sized from the widest ring, and its overflow is visible, so no
        ring is ever cut by the box.
      */}
      <svg
        aria-hidden="true"
        data-zaicode-pixel-filter=""
        data-saiasui-shape={target.id}
        className="absolute"
        style={{ left: -extent, top: -extent, width: extent * 2, height: extent * 2, color: accent, overflow: "visible" }}
        viewBox={`${-extent} ${-extent} ${extent * 2} ${extent * 2}`}
      >
        {config.ringVisible ? (
          <circle cx="0" cy="0" r={ringReach} fill="none" stroke="currentColor" strokeWidth={config.ringThickness} />
        ) : null}
        <circle
          cx="0"
          cy="0"
          r={config.targetOutline ? radius - SAIASUI_BODY_STROKE / 2 : radius}
          fill={config.bodyStyle === "filled" ? "var(--color-background)" : "none"}
          stroke={config.targetOutline ? "currentColor" : "none"}
          strokeWidth={SAIASUI_BODY_STROKE}
        />
      </svg>
      <button
        type="button"
        data-saiasui-target={target.id}
        aria-label={intl.formatMessage(
          { id: "saiasui.hit" },
          { target: LABEL[target.kind] || intl.formatMessage({ id: "saiasui.circle" }) },
        )}
        className="pointer-events-auto absolute flex items-center justify-center text-ui-sm text-foreground"
        style={{
          left: -radius,
          top: -radius,
          width: radius * 2,
          height: radius * 2,
          clipPath: "circle(50%)",
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          onHit(target.id);
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (event.detail === 0) onHit(target.id);
        }}
      >
        {target.kind === "tiny" ? "+" : LABEL[target.kind] || (target.id % 9 || 9)}
      </button>
    </div>
  );
}
