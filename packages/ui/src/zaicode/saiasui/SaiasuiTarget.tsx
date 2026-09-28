import type { AimTarget } from "./saiasuiEngine.js";
import type { SaiasuiConfig } from "./saiasuiConfig.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { targetPoint, type SaiasuiRun } from "./saiasuiEngine.js";

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
  const base = target.kind === "tiny" ? config.tinySize : config.targetSize;
  const radius = base * (1 + (target.id % 5) / 5 * config.sizeVariation);
  const x = 78 + p.x * Math.max(0, width - 156);
  const y = 128 + p.y * Math.max(0, height - 224);
  const life = Math.max(0, (target.expires - now) / (target.expires - target.born));
  const accent =
    config.colorMode === "mono"
      ? "var(--color-foreground)"
      : target.kind === "normal" || target.kind === "moving"
        ? "var(--zaicode-highlight,var(--color-warning))"
        : "var(--color-success)";
  const ringReach = radius + config.ringSize + life * config.ringDuration * config.animIntensity;
  return (
    <div
      className="pointer-events-none absolute"
      style={{ left: x, top: y, opacity: config.targetOpacity }}
    >
      {config.ringVisible ? (
        <svg
          aria-hidden="true"
          className="absolute"
          style={{ left: -72, top: -72, width: 144, height: 144, color: accent }}
          viewBox="0 0 144 144"
        >
          <circle
            cx="72"
            cy="72"
            r={ringReach}
            fill="none"
            stroke="currentColor"
            strokeWidth={config.ringThickness}
          />
        </svg>
      ) : null}
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
          borderColor: accent,
          borderWidth: config.targetOutline ? 2 : 0,
          borderStyle: "solid",
          background: config.bodyStyle === "filled" ? "var(--color-background)" : "transparent",
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
