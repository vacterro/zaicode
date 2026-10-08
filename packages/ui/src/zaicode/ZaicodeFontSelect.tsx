import { useEffect, useState } from "react";

/**
 * Every font picker offers the curated faces first and then each font family installed on
 * this computer (the desktop host lists them; the browser build has no list and keeps the
 * curated faces and the typed name). An installed family is stored the way a typed one
 * always was: the "custom" choice plus its name, so saved settings read unchanged.
 */
const INSTALLED_PREFIX = "installed:";

interface ZaicodeFontPreset {
  readonly id: string;
  readonly label: string;
  readonly family: string;
}

export interface ZaicodeFontChoice {
  id: string;
  custom?: string;
}

let pending: Promise<string[]> | null = null;

export function loadZaicodeSystemFonts(): Promise<string[]> {
  const bridge =
    typeof window === "undefined"
      ? undefined
      : (window as unknown as { zcode?: { listZaicodeSystemFonts?: () => Promise<string[]> } }).zcode;
  if (!bridge?.listZaicodeSystemFonts) return Promise.resolve([]);
  pending ??= bridge
    .listZaicodeSystemFonts()
    .then((fonts) => {
      const names = Array.isArray(fonts) ? fonts.filter((name): name is string => typeof name === "string" && name.length > 0) : [];
      if (names.length === 0) pending = null;
      return names;
    })
    .catch(() => {
      pending = null;
      return [];
    });
  return pending;
}

export function useZaicodeSystemFonts(): string[] {
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void loadZaicodeSystemFonts().then((names) => {
      if (live) setFonts(names);
    });
    return () => {
      live = false;
    };
  }, []);
  return fonts;
}

/** The select's value for a stored choice: an installed family shows as itself. */
export function zaicodeFontSelectValue(id: string, custom: string, installed: readonly string[]): string {
  return id === "custom" && custom && installed.includes(custom) ? INSTALLED_PREFIX + custom : id;
}

/** What a picked option stores. */
export function zaicodeFontChoice(value: string): ZaicodeFontChoice {
  if (value.startsWith(INSTALLED_PREFIX)) return { id: "custom", custom: value.slice(INSTALLED_PREFIX.length) };
  // "Type a font name" starts from an empty field; keeping an installed name would keep it selected.
  return value === "custom" ? { id: "custom", custom: "" } : { id: value };
}

export function ZaicodeFontSelect({
  presets,
  id,
  custom,
  onChange,
  className,
}: {
  presets: readonly ZaicodeFontPreset[];
  id: string;
  custom: string;
  onChange: (choice: ZaicodeFontChoice) => void;
  className?: string;
}) {
  const installed = useZaicodeSystemFonts();
  return (
    <select
      className={className}
      value={zaicodeFontSelectValue(id, custom, installed)}
      data-zaicode-font-select={installed.length}
      onChange={(event) => onChange(zaicodeFontChoice(event.target.value))}
    >
      {presets.map((option) => (
        <option key={option.id} value={option.id} style={option.family ? { fontFamily: option.family } : undefined}>
          {option.id === "custom" ? "Type a font name..." : option.label}
        </option>
      ))}
      {installed.length > 0 ? (
        <optgroup label={`Installed on this computer (${installed.length})`}>
          {installed.map((family) => (
            <option key={family} value={INSTALLED_PREFIX + family} style={{ fontFamily: JSON.stringify(family) }}>
              {family}
            </option>
          ))}
        </optgroup>
      ) : null}
    </select>
  );
}

/** The typed-name field is only for a face the list does not hold. */
export function zaicodeFontNeedsTypedName(id: string, custom: string, installed: readonly string[]): boolean {
  return id === "custom" && !installed.includes(custom);
}
