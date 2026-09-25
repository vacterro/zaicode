import {
  Asterisk,
  Atom,
  Cog,
  Fan,
  Hourglass,
  LoaderCircle,
  Orbit,
  Sparkle,
  Square,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import zaicodeWorkingUrl from "@/assets/zaicode-working.png";
import {
  useZaicodeLights,
  zaicodeWorkingIconStyle,
  type ZaicodeWorkingIconPrefs,
  type ZaicodeWorkingImage,
} from "./zaicodeHighlights.js";

const GLYPHS: Partial<Record<ZaicodeWorkingImage, LucideIcon>> = {
  loader: LoaderCircle,
  cog: Cog,
  orbit: Orbit,
  atom: Atom,
  sparkle: Sparkle,
  asterisk: Asterisk,
  fan: Fan,
  hourglass: Hourglass,
  square: Square,
};

/**
 * ZAICODE "working" indicator. One component for every place that says "an
 * agent is working right now" (chat loading row, sidebar session rows,
 * project rows), so they all read the same at a glance. What it shows and how
 * it moves is the operator's (Settings -> Highlights & motion, SRC-038): the
 * SAIPEN mark, a drawn glyph or an own picture; spin, swing, pulse, …; speed,
 * direction, ticks, reach, size, colour, glow, and whether it keeps moving
 * while the calm interface is on.
 */
export function ZaicodeWorkingIcon({
  className,
  title,
  prefs: override,
}: {
  className?: string;
  title?: string;
  /** Preview with unsaved settings (Settings page). */
  prefs?: ZaicodeWorkingIconPrefs;
}) {
  const stored = useZaicodeLights((state) => state.working);
  const prefs = override ?? stored;
  const style = zaicodeWorkingIconStyle(prefs);
  const common = {
    "aria-hidden": title ? undefined : true,
    title,
    "data-zaicode-working-icon": "",
    "data-zw-keep": prefs.keepMoving && prefs.motions.some((motion) => motion !== "none") ? "" : undefined,
    style,
  } as const;
  const [single] = prefs.images;
  if (prefs.images.length === 1 && single) {
    return <WorkingPicture image={single} customImage={prefs.customImage} {...common} className={cn("size-4 shrink-0", className)} />;
  }
  // Stacked pictures (Shift+Click in Settings) move as one: the wrapper carries the motion.
  return (
    <span {...common} className={cn("relative inline-flex size-4 shrink-0", className)} data-zaicode-working-stack={prefs.images.length}>
      {prefs.images.map((image) => (
        <WorkingPicture key={image} image={image} customImage={prefs.customImage} className="absolute inset-0 size-full" />
      ))}
    </span>
  );
}

function WorkingPicture({
  image,
  customImage,
  className,
  ...rest
}: {
  image: ZaicodeWorkingImage;
  customImage: string | null;
  className: string;
} & Record<string, unknown>) {
  const Glyph = GLYPHS[image];
  if (Glyph) return <Glyph {...rest} className={className} />;
  const src = image === "custom" && customImage ? customImage : zaicodeWorkingUrl;
  return <img {...rest} src={src} alt="" className={cn("object-contain [image-rendering:auto]", className)} />;
}
