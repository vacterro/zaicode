import { useEffect, useState } from "react";
import type { IPlatformService } from "@zcode/shared";
import { usePlatform } from "../hooks/usePlatform.js";

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

// T-278：字体由注入的平台提供；同一平台共享请求，换平台不能复用旧窗口的结果。
const pending = new WeakMap<IPlatformService, Promise<string[]>>();

export function loadZaicodeSystemFonts(platform: IPlatformService): Promise<string[]> {
  const list = platform.listZaicodeSystemFonts;
  if (!list) return Promise.resolve([]);
  const cached = pending.get(platform);
  if (cached) return cached;
  const request = Promise.resolve()
    .then(() => list.call(platform))
    .then((fonts) => {
      const names = Array.isArray(fonts) ? fonts.filter((name): name is string => typeof name === "string" && name.length > 0) : [];
      if (names.length === 0) pending.delete(platform);
      return names;
    })
    .catch(() => {
      pending.delete(platform);
      return [];
    });
  pending.set(platform, request);
  return request;
}

export function useZaicodeSystemFonts(): string[] {
  const platform = usePlatform();
  const [state, setState] = useState<{ platform: IPlatformService; fonts: string[] }>(() => ({ platform, fonts: [] }));
  useEffect(() => {
    let live = true;
    void loadZaicodeSystemFonts(platform).then((fonts) => {
      if (live) setState({ platform, fonts });
    });
    return () => {
      live = false;
    };
  }, [platform]);
  // 旧平台异步返回或 effect 尚未清理时，也不能让其字体在新 provider 下闪现。
  return state.platform === platform ? state.fonts : [];
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
