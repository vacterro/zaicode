import type { ZaicodeScreenMode } from "@zcode/shared";
import { DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu.js";
import { setZaicodeScreen, setZaicodeSize, useZaicodeAppearance, type ZaicodeSizeMode } from "./zaicodeAppearance.js";

/**
 * SRC-062: how ZAICODE draws for the screen it is on. Pixel mode is made for a
 * Full HD screen; a 2K-4K screen scaled 150 % and up does not need it (and
 * 1:1 pixels would halve the interface), a small laptop screen needs room.
 * Auto decides both by the screen the window is on, and re-decides when the
 * window moves to another monitor.
 */

const SCREEN_CHOICES: readonly { value: ZaicodeScreenMode; label: string; hint: string }[] = [
  { value: "auto", label: "Screen: auto", hint: "Pixels on a Full HD screen, smooth on a 2K-4K screen scaled 150 % and up" },
  { value: "pixel", label: "Screen: pixels", hint: "Always pixel mode: 1:1 device pixels, bitmap fonts, no antialiasing" },
  { value: "smooth", label: "Screen: smooth", hint: "Windows scaling, smooth icons and images" },
];
const SIZE_CHOICES: readonly { value: ZaicodeSizeMode; label: string; hint: string }[] = [
  { value: "auto", label: "Size: auto", hint: "Compact on a small screen (a 1366x768 laptop, Full HD at 150 %)" },
  { value: "normal", label: "Size: normal", hint: "The normal text sizes" },
  { value: "compact", label: "Size: compact", hint: "Every interface text one pixel smaller" },
];

/** Screen mode: the window's look at once; the 1:1 text scale of pixel mode on the next start. */
function chooseScreen(mode: ZaicodeScreenMode): void {
  setZaicodeScreen(mode);
  const bridge = (window as unknown as { zcode?: { setZaicodePixelExact?(mode: ZaicodeScreenMode): Promise<unknown> } }).zcode;
  void bridge?.setZaicodePixelExact?.(mode).catch(() => undefined);
}

export function ZaicodeScreenMenuItems() {
  const { screen, crisp, size, compact } = useZaicodeAppearance();
  return (
    <>
      <DropdownMenuLabel className="text-foreground-subtle" data-zaicode-screen-state={crisp ? "pixel" : "smooth"}>
        Now: {crisp ? "pixels" : "smooth"}, {compact ? "compact" : "normal"} size
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup value={screen} onValueChange={(value) => chooseScreen(value as ZaicodeScreenMode)}>
        {SCREEN_CHOICES.map((choice) => (
          <DropdownMenuRadioItem key={choice.value} value={choice.value} title={choice.hint} onSelect={(event) => event.preventDefault()}>
            {choice.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuRadioGroup value={size} onValueChange={(value) => setZaicodeSize(value as ZaicodeSizeMode)}>
        {SIZE_CHOICES.map((choice) => (
          <DropdownMenuRadioItem key={choice.value} value={choice.value} title={choice.hint} onSelect={(event) => event.preventDefault()}>
            {choice.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}
