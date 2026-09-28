import type { AimTarget } from "./saiasuiEngine.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { targetPoint } from "./saiasuiEngine.js";

const LABEL = { normal: "", god: "GOD", slow: "SLOW", full: "FULL", moving: "MOVE", tiny: "+HP" };

export function SaiasuiTarget({
  target,
  now,
  width,
  height,
  reducedMotion,
  onHit,
}: {
  target: AimTarget;
  now: number;
  width: number;
  height: number;
  reducedMotion: boolean;
  onHit: (id: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const p = targetPoint(target, now, reducedMotion);
  const radius = target.kind === "tiny" ? 12 : 34;
  const x = 78 + p.x * Math.max(0, width - 156);
  const y = 128 + p.y * Math.max(0, height - 224);
  const life = Math.max(0, (target.expires - now) / (target.expires - target.born));
  const accent =
    target.kind === "normal" || target.kind === "moving"
      ? "var(--zaicode-highlight,var(--color-warning))"
      : "var(--color-success)";
  return (
    <div className="pointer-events-none absolute" style={{ left: x, top: y }}>
      <svg
        aria-hidden="true"
        className="absolute"
        style={{ left: -72, top: -72, width: 144, height: 144, color: accent }}
        viewBox="0 0 144 144"
      >
        <circle
          cx="72"
          cy="72"
          r={radius + 4 + life * 28}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        />
      </svg>
      <button
        type="button"
        data-saiasui-target={target.id}
        aria-label={intl.formatMessage(
          { id: "saiasui.hit" },
          { target: LABEL[target.kind] || intl.formatMessage({ id: "saiasui.circle" }) },
        )}
        className="pointer-events-auto absolute flex items-center justify-center border-2 bg-background text-ui-sm text-foreground"
        style={{
          left: -radius,
          top: -radius,
          width: radius * 2,
          height: radius * 2,
          borderColor: accent,
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
        {target.kind === "tiny" ? "+" : LABEL[target.kind] || target.id % 9 || 9}
      </button>
    </div>
  );
}
