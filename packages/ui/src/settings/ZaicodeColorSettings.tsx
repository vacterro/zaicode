import { useMemo, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { setZaicodePalette, useZaicodeAppearance } from "@/zaicode/zaicodeAppearance.js";
import { generateZaicodePalette, type ZaicodeColorAdjust } from "@/zaicode/zaicodeColorMath.js";
import {
  ZAICODE_COLOR_VARIABLES,
  ZAICODE_TOKEN_GROUPS,
  canUndoZaicodeColors,
  createZaicodeCustomPalette,
  deleteZaicodeCustomPalette,
  exportZaicodePalette,
  findAnyZaicodePalette,
  importZaicodePalette,
  isZaicodeCustomPalette,
  renameZaicodeCustomPalette,
  resetZaicodeColorStudioLayer,
  resetZaicodeCustomToken,
  setZaicodeColorAdjust,
  setZaicodeColorOverride,
  setZaicodeCustomToken,
  undoZaicodeColors,
  useZaicodeColorStudio,
  zaicodeAdjustedPalette,
  type ZaicodeCustomPalette,
} from "@/zaicode/zaicodeColorStudio.js";
import { ZAICODE_PALETTES, ZAICODE_PALETTE_NONE, findZaicodePalette, type ZaicodePaletteTokens } from "@/zaicode/zaicodePalettes.js";
import { ColorField, ContrastReport, StudioPreview, StudioSection, studioButton } from "./ZaicodeColorParts.js";

/**
 * Settings -> ZAICODE -> Colors: the Color Studio (SRC-035). Pick a theme,
 * make it your own, tune every colour, shift the whole palette at once, or
 * override single app colours. Everything applies live; Undo steps back.
 */

const ADJUSTERS: readonly { key: keyof ZaicodeColorAdjust; label: string; min: number; max: number; unit: string }[] = [
  { key: "hue", label: "Hue", min: -180, max: 180, unit: "°" },
  { key: "saturation", label: "Saturation", min: -100, max: 100, unit: "" },
  { key: "lightness", label: "Lightness", min: -50, max: 50, unit: "" },
  { key: "contrast", label: "Contrast", min: -50, max: 50, unit: "" },
];

function readLiveVariable(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function ZaicodeColorSettings() {
  const { palette: activeSlug } = useZaicodeAppearance();
  const studio = useZaicodeColorStudio();
  const active = findAnyZaicodePalette(activeSlug);
  const own = active && isZaicodeCustomPalette(active.slug) ? (active as ZaicodeCustomPalette) : null;
  const [seed, setSeed] = useState("#D3B57A");
  const [seedDark, setSeedDark] = useState(true);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importText, setImportText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // Live values come from CSS; the appearance listener re-applies before this renders.
  const live = useMemo(
    () => (studio && activeSlug ? Object.fromEntries(ZAICODE_COLOR_VARIABLES.map((name) => [name, readLiveVariable(name)])) : {}),
    [studio, activeSlug],
  ) as Record<string, string>;

  const themes = [...studio.customs, ...ZAICODE_PALETTES];
  const shownTokens: ZaicodePaletteTokens | null = active ? zaicodeAdjustedPalette(active, studio).tokens : null;

  /** Editing a built-in theme first makes the operator's own copy, so built-ins never change. */
  const editToken = (key: keyof ZaicodePaletteTokens, hex: string) => {
    if (!active) return;
    let slug = active.slug;
    if (!own) {
      const copy = createZaicodeCustomPalette(active.slug);
      if (!copy) return setMessage("Too many own themes: delete one first.");
      slug = copy;
      setZaicodePalette(copy);
      setMessage(`"${active.label}" is built in: your changes went into your own copy.`);
    }
    setZaicodeCustomToken(slug, key, hex);
  };

  const flash = (text: string) => setMessage(text);

  return (
    <div className="flex flex-col gap-3 text-ui-xs" data-zaicode-color-studio>
      <StudioSection
        title="Color Studio"
        hint="Theme, then your own colours, then whole-palette shifts, then single-colour overrides — the later step wins. Changes apply live."
        right={
          <button type="button" className={studioButton} disabled={!canUndoZaicodeColors()} onClick={undoZaicodeColors} title="Step back one colour change">
            Undo
          </button>
        }
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1" role="radiogroup" aria-label="Theme">
          {themes.map((theme) => (
            <button
              key={theme.slug}
              type="button"
              role="radio"
              aria-checked={activeSlug === theme.slug}
              className={cn(
                "flex min-w-0 items-center gap-1 border px-1 py-0.5 text-left",
                activeSlug === theme.slug ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected" : "border-border hover:bg-hover",
              )}
              onClick={() => setZaicodePalette(theme.slug)}
              title={isZaicodeCustomPalette(theme.slug) ? "Your own theme" : "Built-in theme"}
            >
              {(["background", "surface", "textPrimary", "borderHighlight"] as const).map((key) => (
                <span key={key} aria-hidden className="size-3 shrink-0 border border-black/60" style={{ background: theme.tokens[key] }} />
              ))}
              <span className="min-w-0 flex-1 truncate text-foreground">
                {isZaicodeCustomPalette(theme.slug) ? "★ " : ""}
                {theme.label}
              </span>
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={activeSlug === ZAICODE_PALETTE_NONE}
            className={cn("border px-1 py-0.5 text-left", activeSlug === ZAICODE_PALETTE_NONE ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected" : "border-border hover:bg-hover")}
            onClick={() => setZaicodePalette(ZAICODE_PALETTE_NONE)}
          >
            Upstream colours
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <button
            type="button"
            className={studioButton}
            disabled={!active}
            onClick={() => {
              const slug = active ? createZaicodeCustomPalette(active.slug) : null;
              if (slug) {
                setZaicodePalette(slug);
                flash("Own copy made: edit any colour below.");
              }
            }}
          >
            Make my own copy
          </button>
          {own ? (
            renaming === own.slug ? (
              <input
                autoFocus
                className="w-40 border border-border bg-background px-1 text-foreground"
                defaultValue={own.label}
                onBlur={(event) => {
                  renameZaicodeCustomPalette(own.slug, event.target.value);
                  setRenaming(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                  if (event.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <button type="button" className={studioButton} onClick={() => setRenaming(own.slug)}>
                Rename
              </button>
            )
          ) : null}
          {own ? (
            confirmDelete ? (
              <span className="flex items-center gap-1">
                <span className="text-foreground-subtle">Delete “{own.label}”?</span>
                <button
                  type="button"
                  className="border border-destructive px-1.5 text-destructive hover:bg-hover"
                  onClick={() => {
                    setZaicodePalette(own.base);
                    deleteZaicodeCustomPalette(own.slug);
                    setConfirmDelete(false);
                  }}
                >
                  Delete
                </button>
                <button type="button" className={studioButton} onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
              </span>
            ) : (
              <button type="button" className={studioButton} onClick={() => setConfirmDelete(true)}>
                Delete…
              </button>
            )
          ) : null}
          <button
            type="button"
            className={studioButton}
            disabled={!active}
            onClick={() => {
              const json = active ? exportZaicodePalette(active.slug) : null;
              if (!json) return;
              void navigator.clipboard?.writeText(json).then(
                () => flash("Theme copied as JSON: paste it anywhere, or into Import on another machine."),
                () => setImportText(json),
              );
            }}
          >
            Export (copy JSON)
          </button>
          <span className="mx-1 h-4 border-l border-border" />
          <span className="text-foreground-subtle">From one colour</span>
          <input type="color" aria-label="Seed colour" className="h-5 w-7 border border-border p-0" value={seed.toLowerCase()} onChange={(event) => setSeed(event.target.value)} />
          <label className="flex items-center gap-1 text-foreground">
            <input type="checkbox" checked={seedDark} onChange={(event) => setSeedDark(event.target.checked)} />
            dark
          </label>
          <button
            type="button"
            className={studioButton}
            onClick={() => {
              const slug = createZaicodeCustomPalette(ZAICODE_PALETTES[0]!.slug, `From ${seed.toUpperCase()}`, generateZaicodePalette(seed, seedDark));
              if (slug) {
                setZaicodePalette(slug);
                flash("A whole theme from one colour: tune any colour below.");
              }
            }}
          >
            Create
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-start gap-1">
          <textarea
            className="h-12 min-w-[240px] flex-1 border border-border bg-background px-1 font-mono text-foreground"
            placeholder='Import: paste a theme JSON ({"label": "...", "tokens": {"background": "#101010", ...}})'
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
          />
          <button
            type="button"
            className={studioButton}
            disabled={!importText.trim()}
            onClick={() => {
              const result = importZaicodePalette(importText);
              if ("error" in result) return flash(result.error);
              setZaicodePalette(result.slug);
              setImportText("");
              flash("Theme imported and switched on.");
            }}
          >
            Import
          </button>
        </div>
        {message ? (
          <p role="status" className="mt-1 text-foreground">
            {message}
          </p>
        ) : null}
      </StudioSection>

      {active && shownTokens ? (
        <StudioSection
          title={`Colours of “${active.label}”`}
          hint={own ? "Your own theme: every colour is yours. ↺ returns one colour to the theme it was made from." : "Built-in theme: the first change makes your own copy (the built-in stays as it is)."}
        >
          <ContrastReport tokens={shownTokens} />
          <div className="mt-2 grid gap-3 lg:grid-cols-2">
            {ZAICODE_TOKEN_GROUPS.map((group) => (
              <div key={group.title} className="flex flex-col gap-1">
                <span className="border-b border-border/60 text-foreground-subtle">{group.title}</span>
                {group.tokens.map((token) => {
                  const baseColor = own ? findZaicodePalette(own.base)?.tokens[token.key] : null;
                  return (
                    <div key={token.key} className="grid grid-cols-[110px_auto_1fr] items-center gap-2" title={token.hint}>
                      <span className="truncate text-foreground">{token.label}</span>
                      <ColorField value={active.tokens[token.key]} title={token.label} onChange={(hex) => editToken(token.key, hex)} />
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="truncate text-foreground-subtlest">{token.hint}</span>
                        {own && baseColor && baseColor !== own.tokens[token.key] ? (
                          <button type="button" className={studioButton} title={`Back to ${baseColor}`} onClick={() => resetZaicodeCustomToken(own.slug, token.key)}>
                            ↺
                          </button>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </StudioSection>
      ) : null}

      <StudioSection
        title="Shift everything"
        hint="Moves every colour of the theme together, so it stays in harmony: warmer, colder, softer, brighter."
        right={
          <button type="button" className={studioButton} onClick={() => resetZaicodeColorStudioLayer("adjust")}>
            Reset shifts
          </button>
        }
      >
        <div className="grid grid-cols-[90px_1fr_48px] items-center gap-x-2 gap-y-1">
          {ADJUSTERS.map((adjuster) => (
            <div key={adjuster.key} className="contents">
              <span className="text-foreground-subtle">{adjuster.label}</span>
              <input
                type="range"
                min={adjuster.min}
                max={adjuster.max}
                value={studio.adjust[adjuster.key]}
                aria-label={adjuster.label}
                onChange={(event) => setZaicodeColorAdjust({ [adjuster.key]: Number(event.target.value) })}
                onDoubleClick={() => setZaicodeColorAdjust({ [adjuster.key]: 0 })}
              />
              <span className="text-right tabular-nums text-foreground">
                {studio.adjust[adjuster.key] > 0 ? "+" : ""}
                {studio.adjust[adjuster.key]}
                {adjuster.unit}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-1 text-foreground-subtlest">Double-click a slider to put it back to 0. Shifts apply to built-in and own themes alike.</p>
      </StudioSection>

      <StudioSection
        title="Single colours"
        hint="Any one app colour, whatever the theme says: e.g. only the sidebar, only borders, only the terminal. An override wins over everything above."
        right={
          <>
            <span className="text-foreground-subtle">{Object.keys(studio.overrides).length} overridden</span>
            <button type="button" className={studioButton} disabled={Object.keys(studio.overrides).length === 0} onClick={() => resetZaicodeColorStudioLayer("overrides")}>
              Clear all
            </button>
          </>
        }
      >
        <input
          className="mb-1 w-full border border-border bg-background px-1 text-foreground"
          placeholder="Filter: sidebar, border, text, terminal…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <div className="grid max-h-[320px] grid-cols-1 gap-x-4 gap-y-0.5 overflow-y-auto lg:grid-cols-2">
          {ZAICODE_COLOR_VARIABLES.filter((name) => name.toLowerCase().includes(filter.trim().toLowerCase())).map((name) => {
            const overridden = studio.overrides[name];
            return (
              <div key={name} className="grid grid-cols-[1fr_auto_auto] items-center gap-1">
                <span className={cn("truncate font-mono", overridden ? "text-foreground" : "text-foreground-subtle")} title={name}>
                  {name.replace(/^--(color-)?/, "")}
                </span>
                <ColorField value={overridden ?? live[name] ?? ""} title={name} onChange={(hex) => setZaicodeColorOverride(name, hex)} />
                <button type="button" className={cn(studioButton, !overridden && "invisible")} title="Remove this override" onClick={() => setZaicodeColorOverride(name, null)}>
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      </StudioSection>

      <StudioSection title="Preview" hint="Drawn with the live colours; the whole app changes the same way.">
        <StudioPreview />
      </StudioSection>
    </div>
  );
}
