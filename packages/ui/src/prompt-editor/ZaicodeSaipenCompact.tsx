import type { CSSProperties, ReactNode } from "react";
import { ChevronsDownUp, ChevronsUpDown, Eraser, Play, StepForward, TriangleAlert } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { ZaicodeComposerPartsPanel } from "@/zaicode/ZaicodeComposerPartsPanel.js";
import { ZaicodeRightClickSettings } from "@/zaicode/ZaicodePrefControls.js";
import { ZaicodeRoleGlyph } from "@/zaicode/ZaicodeRoleGlyph.js";
import { useZaicodeComposerPrefs } from "@/zaicode/zaicodeComposerPrefs.js";
import type { ZaicodeSessionRole } from "@/zaicode/zaicodeSessionRoles.js";

/**
 * The compact SAIPEN strip (SRC-038): START, STEP, CLEAR and the modes as
 * small square icon buttons in one row; the words live in their tooltips.
 */

/** Compact <-> full; right-click lists every part of the strip. */
export function ZaicodeComposerCompactToggle() {
  const compact = useZaicodeComposerPrefs((state) => state.compact);
  const update = useZaicodeComposerPrefs((state) => state.update);
  return (
    <ZaicodeRightClickSettings
      title="Message box"
      hint="What the SAIPEN strip shows. Left click on this button: compact ↔ full."
      side="top"
      align="end"
      panel={<ZaicodeComposerPartsPanel />}
      className="shrink-0"
    >
      <button
        type="button"
        className="flex size-6 shrink-0 items-center justify-center border border-border text-foreground-subtle hover:bg-hover hover:text-foreground"
        title={
          compact
            ? "Full strip: buttons with words, MODES row, NEXT / THEN / LAST (right-click: what shows)"
            : "Compact: one row of small square buttons (right-click: what shows)"
        }
        aria-pressed={compact}
        onClick={() => update({ compact: !compact })}
        data-zaicode-compact-toggle
      >
        {compact ? <ChevronsUpDown className="size-3.5" /> : <ChevronsDownUp className="size-3.5" />}
      </button>
    </ZaicodeRightClickSettings>
  );
}

export interface ZaicodeCompactMode {
  label: string;
  hint: string;
  command: string;
  role: ZaicodeSessionRole | null;
  highlighted: boolean;
  dimmed: boolean;
}

export interface ZaicodeSaipenCompactRowProps {
  /** null hides the slot square. */
  slot: "main" | "side" | "none" | null;
  start: { label: string; disabled: boolean; onClick: () => void };
  step: { disabled: boolean; onClick: () => void };
  clear: { label: string; disabled: boolean; onClick: () => void };
  /** null hides the mode squares. */
  modes: readonly ZaicodeCompactMode[] | null;
  onMode: (command: string) => void;
  blocker: string | null;
  /** null hides the phase chip. */
  chip: { text: string; title: string; style?: CSSProperties | undefined; state?: string | undefined; board: string | null } | null;
}

const SQUARE =
  "flex size-6 shrink-0 items-center justify-center border border-border bg-selected text-foreground hover:bg-hover disabled:opacity-40";

export function ZaicodeSaipenCompactRow(props: ZaicodeSaipenCompactRowProps) {
  const { slot, start, step, clear, modes, onMode, blocker, chip } = props;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {slot ? (
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center border",
            slot === "main"
              ? "border-[var(--zaicode-highlight,var(--color-warning))] text-[var(--zaicode-highlight,var(--color-warning))]"
              : "border-dashed border-border text-foreground-subtlest",
          )}
          title={slot === "main" ? "MAIN session of this project" : slot === "side" ? "Side slot" : "No MAIN yet: START makes this session MAIN"}
        >
          {slot === "main" ? "◆" : "◇"}
        </span>
      ) : null}
      <CompactButton className={SQUARE} label={start.label} disabled={start.disabled} onClick={start.onClick} sound="saipen.start">
        <Play className="size-3.5" />
      </CompactButton>
      <CompactButton className={SQUARE} label="STEP — cc, one SAIPEN step here" disabled={step.disabled} onClick={step.onClick} sound="saipen.step">
        <StepForward className="size-3.5" />
      </CompactButton>
      <CompactButton className={SQUARE} label={clear.label} disabled={clear.disabled} onClick={clear.onClick} sound="saipen.clear">
        <Eraser className="size-3.5" />
      </CompactButton>
      {modes ? (
        <>
          <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />
          {modes.map((mode) => (
            <CompactButton
              key={mode.label}
              className={cn(
                "flex size-6 shrink-0 items-center justify-center border text-[9px] leading-none hover:bg-hover",
                mode.highlighted ? "border-[var(--zaicode-highlight,var(--color-warning))]" : "border-border",
                mode.dimmed && "opacity-50",
              )}
              label={`${mode.label} — ${mode.hint}`}
              onClick={() => onMode(mode.command)}
              sound="saipen.mode"
            >
              {mode.role ? <ZaicodeRoleGlyph role={mode.role} /> : mode.label.slice(0, 2)}
            </CompactButton>
          ))}
        </>
      ) : null}
      <span className="ml-auto" />
      {blocker ? (
        <span className="flex size-6 shrink-0 items-center justify-center text-destructive" title={`BLOCKER: ${blocker}`}>
          <TriangleAlert className="size-3.5" />
        </span>
      ) : null}
      {chip ? (
        <span
          className="shrink-0 border border-border px-1 leading-5 tabular-nums text-foreground"
          style={chip.style}
          data-zaicode-readiness={chip.state}
          title={chip.title}
        >
          {chip.text}
          {chip.board ? <span className="ml-1 text-foreground-subtlest">{chip.board}</span> : null}
        </span>
      ) : null}
      <ZaicodeComposerCompactToggle />
    </div>
  );
}

/** A square icon button of the compact strip: the words live in its tooltip. */
function CompactButton({
  className,
  label,
  disabled,
  onClick,
  sound,
  children,
}: {
  className: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
  sound: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      data-zaicode-sound={sound}
    >
      {children}
    </button>
  );
}

/** One status line under the strip: NEXT / THEN / LAST. */
export function ZaicodeSaipenLine({ label, tag, text, strong }: { label: string; tag?: string; text: string; strong?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 truncate text-foreground-subtlest" title={tag ? `${tag} ${text}` : text}>
      <span className="shrink-0 font-medium text-foreground-subtle">{label}:</span>
      {tag ? <span className="shrink-0 text-foreground-subtle">{tag}</span> : null}
      <span className={cn("min-w-0 flex-1 truncate", strong ? "text-foreground" : "text-foreground-subtle")}>{text}</span>
    </div>
  );
}

export interface ZaicodeStripMode {
  label: string;
  hint: string;
  command: string;
  parallel: boolean;
}

/** MODES row of the full strip: subSaipen helpers; the parallel-safe ones light up while MAIN works. */
export function ZaicodeSaipenModesRow({
  modes,
  parallelHint,
  mainWorking,
  runsHere,
  onMode,
}: {
  modes: readonly ZaicodeStripMode[];
  parallelHint: boolean;
  mainWorking: boolean;
  runsHere: boolean;
  onMode: (command: string) => void;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1 text-foreground-subtlest"
      data-zaicode-saipen-modes
      data-zaicode-parallel={parallelHint ? "on" : undefined}
    >
      <span
        className={cn("mr-1", parallelHint && "text-[var(--zaicode-highlight,var(--color-warning))]")}
        title={
          parallelHint
            ? "MAIN is working: the highlighted helpers can run here in parallel without touching its work."
            : "SubSaipen helpers. Highlighted ones are safe to run next to a working MAIN session."
        }
      >
        {parallelHint ? "PARALLEL:" : "MODES:"}
      </span>
      {modes.map((mode) => {
        const highlighted = mode.parallel && (parallelHint || mainWorking);
        return (
          <button
            key={mode.label}
            type="button"
            className={cn(
              "border px-1.5 leading-4 hover:bg-hover hover:text-foreground",
              highlighted
                ? "border-[var(--zaicode-highlight,var(--color-warning))] text-foreground"
                : "border-border text-foreground-subtle",
              parallelHint && !mode.parallel && "opacity-50",
            )}
            title={`${mode.hint}${
              mode.parallel ? " — safe to run in parallel with MAIN" : " — changes the tree/board: better when MAIN is idle"
            } (${runsHere ? "runs here" : "opens a fresh session"})`}
            aria-label={mode.hint}
            onClick={() => onMode(mode.command)}
            data-zaicode-sound="saipen.mode"
          >
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}
