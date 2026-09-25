import { create } from "zustand";
import { cn } from "@/components/lib/utils.js";
import { ZAICODE_CODE_FONT_OPTIONS, ZAICODE_UI_FONT_OPTIONS } from "./zaicodeAppearance.js";
import { zaicodeProjectColor } from "./ZaicodeGroupedRowDecor.js";
import { ZaicodePrefCheck, ZaicodePrefSegment, ZaicodePrefStepper, ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * The project's name in big letters in the title bar (SRC-044): the header
 * used to show only the session title ("PHASE BUILD T-124"), so with many
 * projects open you could not tell at a glance whose session it is. Where it
 * sits, font, size, weight, capitals, spacing and colour are the operator's
 * (right-click it, or Settings -> Layout & home -> Title bar).
 */

export type ZaicodeHeaderTitleAlign = "start" | "center";
export type ZaicodeHeaderTitleColor = "accent" | "text" | "project";

export interface ZaicodeHeaderTitlePrefs {
  showProject: boolean;
  align: ZaicodeHeaderTitleAlign;
  /** ZAICODE_UI_FONT_OPTIONS / ZAICODE_CODE_FONT_OPTIONS id, or "custom". */
  font: string;
  customFont: string;
  size: number;
  bold: boolean;
  uppercase: boolean;
  letterSpacing: number;
  color: ZaicodeHeaderTitleColor;
  showSession: boolean;
  sessionSize: number;
}

export const ZAICODE_HEADER_TITLE_DEFAULTS: ZaicodeHeaderTitlePrefs = {
  showProject: true,
  align: "start",
  font: "verdana",
  customFont: "",
  size: 20,
  bold: true,
  uppercase: true,
  letterSpacing: 1,
  color: "accent",
  showSession: true,
  sessionSize: 13,
};

const STORAGE_KEY = "zaicode-header-title-v1";
const FONT_OPTIONS = [...ZAICODE_UI_FONT_OPTIONS.filter((option) => option.id !== "custom"), ...ZAICODE_CODE_FONT_OPTIONS];

export function normalizeZaicodeHeaderTitlePrefs(raw: unknown): ZaicodeHeaderTitlePrefs {
  const d = ZAICODE_HEADER_TITLE_DEFAULTS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ZaicodeHeaderTitlePrefs, unknown>>;
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const int = (value: unknown, min: number, max: number, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
  return {
    showProject: flag(r.showProject, d.showProject),
    align: r.align === "center" ? "center" : "start",
    font: typeof r.font === "string" && (r.font === "custom" || FONT_OPTIONS.some((option) => option.id === r.font)) ? r.font : d.font,
    customFont: typeof r.customFont === "string" ? r.customFont.slice(0, 200) : d.customFont,
    size: int(r.size, 10, 40, d.size),
    bold: flag(r.bold, d.bold),
    uppercase: flag(r.uppercase, d.uppercase),
    letterSpacing: int(r.letterSpacing, 0, 8, d.letterSpacing),
    color: r.color === "text" || r.color === "project" ? r.color : "accent",
    showSession: flag(r.showSession, d.showSession),
    sessionSize: int(r.sessionSize, 10, 24, d.sessionSize),
  };
}

function load(): ZaicodeHeaderTitlePrefs {
  try {
    return normalizeZaicodeHeaderTitlePrefs(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    return normalizeZaicodeHeaderTitlePrefs(null);
  }
}

export const useZaicodeHeaderTitle = create<ZaicodeHeaderTitlePrefs & { update: (patch: Partial<ZaicodeHeaderTitlePrefs>) => void }>(
  (set, get) => ({
    ...load(),
    update: (patch) => {
      const next = normalizeZaicodeHeaderTitlePrefs({ ...get(), ...patch });
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // preference only
      }
      set(next);
    },
  }),
);

/** CSS font-family for the chosen face; empty = the interface font. */
export function zaicodeHeaderTitleFamily(prefs: Pick<ZaicodeHeaderTitlePrefs, "font" | "customFont">): string {
  if (prefs.font === "custom") return prefs.customFont.trim() ? `${prefs.customFont.trim()}, sans-serif` : "";
  return FONT_OPTIONS.find((option) => option.id === prefs.font)?.family ?? "";
}

export function ZaicodeHeaderTitleSettingsPanel() {
  const prefs = useZaicodeHeaderTitle();
  return (
    <div className="flex max-w-[480px] flex-col gap-1.5 text-ui-xs" data-zaicode-header-title-settings>
      <ZaicodePrefCheck checked={prefs.showProject} onChange={(showProject) => prefs.update({ showProject })} label="Project name in the title bar" />
      <ZaicodePrefSegment
        label="Where"
        value={prefs.align}
        options={[
          { value: "start", label: "Before the session title" },
          { value: "center", label: "Centre of the title bar" },
        ]}
        onChange={(align) => prefs.update({ align })}
      />
      <label className="flex items-center justify-between gap-2">
        <span className="text-foreground-subtle">Font</span>
        <select
          className="min-w-0 border border-border bg-background px-1 py-0.5 text-foreground"
          value={prefs.font}
          onChange={(event) => prefs.update({ font: event.target.value })}
        >
          {FONT_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {prefs.font === "custom" ? (
        <input
          className="border border-border bg-background px-1 py-0.5 text-foreground"
          value={prefs.customFont}
          placeholder="Font name installed on this computer"
          onChange={(event) => prefs.update({ customFont: event.target.value })}
        />
      ) : null}
      <ZaicodePrefStepper label="Size" value={prefs.size} min={10} max={40} suffix=" px" onChange={(size) => prefs.update({ size })} />
      <ZaicodePrefStepper
        label="Letter spacing"
        value={prefs.letterSpacing}
        min={0}
        max={8}
        suffix=" px"
        onChange={(letterSpacing) => prefs.update({ letterSpacing })}
      />
      <ZaicodePrefCheck checked={prefs.bold} onChange={(bold) => prefs.update({ bold })} label="Bold" />
      <ZaicodePrefCheck checked={prefs.uppercase} onChange={(uppercase) => prefs.update({ uppercase })} label="CAPITALS" />
      <ZaicodePrefSegment
        label="Colour"
        value={prefs.color}
        options={[
          { value: "accent", label: "Highlight" },
          { value: "text", label: "Text" },
          { value: "project", label: "Project stripe", hint: "The project's own colour from the Group view" },
        ]}
        onChange={(color) => prefs.update({ color })}
      />
      <ZaicodePrefCheck checked={prefs.showSession} onChange={(showSession) => prefs.update({ showSession })} label="Session title next to it" />
      <ZaicodePrefStepper
        label="Session title size"
        value={prefs.sessionSize}
        min={10}
        max={24}
        suffix=" px"
        disabled={!prefs.showSession}
        onChange={(sessionSize) => prefs.update({ sessionSize })}
      />
    </div>
  );
}

/** The big project name itself. `placement` is where the header asks to draw it. */
export function ZaicodeHeaderProjectTitle({
  projectName,
  workspacePath,
  placement,
}: {
  projectName: string;
  workspacePath: string;
  placement: ZaicodeHeaderTitleAlign;
}) {
  const prefs = useZaicodeHeaderTitle();
  if (!prefs.showProject || !projectName || prefs.align !== placement) return null;
  const family = zaicodeHeaderTitleFamily(prefs);
  const color =
    prefs.color === "project"
      ? zaicodeProjectColor(workspacePath)
      : prefs.color === "text"
        ? "var(--color-foreground)"
        : "var(--zaicode-highlight, var(--color-foreground))";
  const title = (
    <ZaicodeRightClickSettings title="Title bar: project name" panel={<ZaicodeHeaderTitleSettingsPanel />}>
      <span
        className={cn(
          "min-w-0 max-w-[40vw] shrink truncate leading-none [app-region:no-drag]",
          placement === "center" && "pointer-events-auto",
        )}
        style={{
          fontSize: prefs.size,
          fontWeight: prefs.bold ? 700 : 400,
          letterSpacing: prefs.letterSpacing,
          textTransform: prefs.uppercase ? "uppercase" : "none",
          color,
          ...(family ? { fontFamily: family } : {}),
        }}
        title={`${projectName} — ${workspacePath}\nRight-click: font, size, place`}
        data-zaicode-header-project=""
        data-zaicode-pixel-snap
      >
        {projectName}
      </span>
    </ZaicodeRightClickSettings>
  );
  if (placement === "start") return title;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-[1] flex h-12 items-center justify-center" data-zaicode-header-project-center="">
      {title}
    </div>
  );
}
