/**
 * CSS for ZAICODE light and motion (zaicodeHighlights.ts): highlight shapes,
 * their effects, the Working icon's motions, title alignment, and the one
 * exception to the calm interface -- anything marked "keep moving" still
 * animates while `html.zaicode-no-motion` (or the OS reduced-motion setting)
 * stops everything else.
 *
 * Every effect animates its own registered strength (0..1) and `--zh-k` is
 * their product; every shape reads its strength from `--zh-k`, so any effect
 * works with any shape, and several effects and shapes combine (SRC-043):
 * `data-zh-shape` is a space-separated list matched with `~=`.
 */

/** Each shape reads its own colour / strength first (SRC-048), then the highlight's. */
const COLOR = (shape: string) => `var(--zh-c-${shape}, var(--zh-color, #f0c040))`;
const STRENGTH = (shape: string) => `var(--zh-s-${shape}, var(--zh-s, 0.7))`;
const MIX = (shape: string, scale = 100) => `calc(var(--zh-k) * ${STRENGTH(shape)} * ${scale}%)`;
const LIT = (shape: string) => `color-mix(in srgb, ${COLOR(shape)} ${MIX(shape)}, transparent)`;
/** A dimmed keyframe value: `share` of the effect's depth (Settings: Depth; fallback = its own shape). */
const DIP = (effect: string, share: number, natural: number) =>
  share === 1 ? `calc(1 - var(--zh-d-${effect}, ${natural}))` : `calc(1 - ${share} * var(--zh-d-${effect}, ${natural}))`;
const ZH_EFFECTS = ["pulse", "breathe", "heartbeat", "blink", "strobe", "flicker"] as const;

/** One animatable strength per effect, so combined effects multiply instead of overwriting. */
const ZH_CHANNELS = ZH_EFFECTS.map(
  (effect) => `@property --zh-e-${effect} { syntax: "<number>"; inherits: false; initial-value: 1; }`,
).join("\n");

/** Channels of a combined Working icon: each motion owns one, the transform reads all. */
const ZW_CHANNELS = [
  `@property --zw-r1 { syntax: "<angle>"; inherits: false; initial-value: 0deg; }`,
  `@property --zw-r2 { syntax: "<angle>"; inherits: false; initial-value: 0deg; }`,
  `@property --zw-r3 { syntax: "<angle>"; inherits: false; initial-value: 0deg; }`,
  `@property --zw-ry { syntax: "<angle>"; inherits: false; initial-value: 0deg; }`,
  `@property --zw-s { syntax: "<number>"; inherits: false; initial-value: 1; }`,
  `@property --zw-ty { syntax: "<length>"; inherits: false; initial-value: 0px; }`,
  `@property --zw-o1 { syntax: "<number>"; inherits: false; initial-value: 1; }`,
  `@property --zw-o2 { syntax: "<number>"; inherits: false; initial-value: 1; }`,
].join("\n");

export const ZAICODE_MOTION_CSS = `
@property --zh-k { syntax: "<number>"; inherits: true; initial-value: 1; }
@property --zh-hue { syntax: "<angle>"; inherits: true; initial-value: 0deg; }
${ZH_CHANNELS}
${ZW_CHANNELS}

@keyframes zh-pulse { 0%, 100% { --zh-e-pulse: 1; } 50% { --zh-e-pulse: ${DIP("pulse", 1, 0.75)}; } }
@keyframes zh-breathe { 0%, 100% { --zh-e-breathe: ${DIP("breathe", 1, 0.88)}; } 50% { --zh-e-breathe: 1; } }
@keyframes zh-heartbeat { 0% { --zh-e-heartbeat: ${DIP("heartbeat", 1, 0.8)}; } 10% { --zh-e-heartbeat: 1; } 20% { --zh-e-heartbeat: ${DIP("heartbeat", 0.8125, 0.8)}; } 30% { --zh-e-heartbeat: 1; } 45%, 100% { --zh-e-heartbeat: ${DIP("heartbeat", 1, 0.8)}; } }
@keyframes zh-blink { 0%, 49.9% { --zh-e-blink: 1; } 50%, 100% { --zh-e-blink: ${DIP("blink", 1, 1)}; } }
@keyframes zh-strobe { 0%, 8% { --zh-e-strobe: 1; } 8.1%, 100% { --zh-e-strobe: ${DIP("strobe", 1, 1)}; } }
@keyframes zh-flicker { 0% { --zh-e-flicker: 1; } 6% { --zh-e-flicker: ${DIP("flicker", 0.765, 0.85)}; } 9% { --zh-e-flicker: 1; } 36% { --zh-e-flicker: ${DIP("flicker", 0.176, 0.85)}; } 39% { --zh-e-flicker: ${DIP("flicker", 1, 0.85)}; } 42% { --zh-e-flicker: 1; } 77% { --zh-e-flicker: ${DIP("flicker", 0.118, 0.85)}; } 79% { --zh-e-flicker: ${DIP("flicker", 0.824, 0.85)}; } 82%, 100% { --zh-e-flicker: 1; } }
@keyframes zh-hue { from { --zh-hue: 0deg; } to { --zh-hue: 360deg; } }

html [data-zh] {
  --zh-k: calc(${ZH_EFFECTS.map((effect) => `var(--zh-e-${effect})`).join(" * ")});
}
html [data-zh][data-zh-shape~="text"] {
  color: color-mix(in srgb, ${COLOR("text")} ${MIX("text")}, var(--color-foreground)) !important;
}
html [data-zh][data-zh-shape~="glow"] {
  text-shadow: 0 0 calc(1px + 5px * var(--zh-k)) ${LIT("glow")}, 0 0 1px ${LIT("glow")} !important;
}
html [data-zh][data-zh-shape~="underline"] {
  --zh-underline: inset 0 -2px 0 ${LIT("underline")};
}
html [data-zh][data-zh-shape~="bar"] {
  --zh-bar: inset 3px 0 0 ${LIT("bar")};
}
/* Underline and side bar both draw with box-shadow: one declaration carries both. */
html [data-zh][data-zh-shape~="underline"],
html [data-zh][data-zh-shape~="bar"] {
  box-shadow: var(--zh-underline, 0 0 transparent), var(--zh-bar, 0 0 transparent) !important;
}
html [data-zh][data-zh-shape~="box"] {
  outline: 1px solid ${LIT("box")} !important;
  outline-offset: -1px;
}
html [data-zh][data-zh-shape~="fill"] {
  background-color: color-mix(in srgb, ${COLOR("fill")} ${MIX("fill", 35)}, transparent) !important;
}
html [data-zh][data-zh-shape~="dot"]::before {
  content: "";
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-right: 4px;
  vertical-align: middle;
  background: ${LIT("dot")};
}

/* Every motion is symmetric about the icon's centre (SRC-048): it turns and scales round the
   middle, swings and shakes as far left as right, bounces as far up as down, and flips as a
   flat squash (no perspective: under perspective(40px) one half of a 16 px icon drew twice
   the size of the other, a slanted sliver). */
[data-zaicode-working-icon], [data-zaicode-working-layer] {
  transform-origin: 50% 50%;
  transform-box: border-box;
}
@keyframes zw-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes zw-swing { 0%, 100% { transform: rotate(calc(var(--zw-deg) * -0.5)); } 50% { transform: rotate(calc(var(--zw-deg) * 0.5)); } }
@keyframes zw-wobble { 0%, 60%, 100% { transform: rotate(0deg); } 7.5% { transform: rotate(calc(var(--zw-wdeg, var(--zw-deg)) * 0.25)); } 22.5% { transform: rotate(calc(var(--zw-wdeg, var(--zw-deg)) * -0.25)); } 37.5% { transform: rotate(calc(var(--zw-wdeg, var(--zw-deg)) * 0.25)); } 52.5% { transform: rotate(calc(var(--zw-wdeg, var(--zw-deg)) * -0.25)); } }
@keyframes zw-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(var(--zw-scale)); } }
@keyframes zw-breathe { 0%, 100% { opacity: 1; } 50% { opacity: var(--zw-fade); } }
@keyframes zw-bounce { 0%, 100% { transform: translateY(calc(var(--zw-px) * 0.5)); } 50% { transform: translateY(calc(var(--zw-px) * -0.5)); } }
@keyframes zw-flip { from { transform: rotateY(0deg); } to { transform: rotateY(360deg); } }
@keyframes zw-blink { 0%, 49.9% { opacity: 1; } 50%, 100% { opacity: var(--zw-blink-low, 0.15); } }

/* The easing preview in Settings: a square that travels the track with the chosen timing. */
@keyframes zaicode-ease-demo { from { left: 0; } to { left: calc(100% - 10px); } }

/* Combined motions: the same movements on their own channels (see ZW_CHANNELS). */
@keyframes zwc-spin { from { --zw-r1: 0deg; } to { --zw-r1: 360deg; } }
@keyframes zwc-swing { 0%, 100% { --zw-r2: calc(var(--zw-deg) * -0.5); } 50% { --zw-r2: calc(var(--zw-deg) * 0.5); } }
@keyframes zwc-wobble { 0%, 60%, 100% { --zw-r3: 0deg; } 7.5% { --zw-r3: calc(var(--zw-wdeg, var(--zw-deg)) * 0.25); } 22.5% { --zw-r3: calc(var(--zw-wdeg, var(--zw-deg)) * -0.25); } 37.5% { --zw-r3: calc(var(--zw-wdeg, var(--zw-deg)) * 0.25); } 52.5% { --zw-r3: calc(var(--zw-wdeg, var(--zw-deg)) * -0.25); } }
@keyframes zwc-pulse { 0%, 100% { --zw-s: 1; } 50% { --zw-s: var(--zw-scale); } }
@keyframes zwc-breathe { 0%, 100% { --zw-o1: 1; } 50% { --zw-o1: var(--zw-fade); } }
@keyframes zwc-bounce { 0%, 100% { --zw-ty: calc(var(--zw-px) * 0.5); } 50% { --zw-ty: calc(var(--zw-px) * -0.5); } }
@keyframes zwc-flip { from { --zw-ry: 0deg; } to { --zw-ry: 360deg; } }
@keyframes zwc-blink { 0%, 49.9% { --zw-o2: 1; } 50%, 100% { --zw-o2: var(--zw-blink-low, 0.15); } }

/* The calm interface stops every animation with !important; "keep moving" is the one opt-out. */
html.zaicode-no-motion [data-zh-keep][data-zh] {
  animation: var(--zh-anim) !important;
}
html.zaicode-no-motion [data-zaicode-working-icon][data-zw-keep] {
  animation: var(--zw-anim) !important;
}
html.zaicode-no-motion [data-zaicode-working-icon][data-zw-keep] [data-zaicode-working-layer] {
  animation: var(--zw-layer-anim, none) !important;
}
@media (prefers-reduced-motion: reduce) {
  [data-zaicode-working-icon]:not([data-zw-keep]), [data-zaicode-working-icon]:not([data-zw-keep]) [data-zaicode-working-layer], [data-zh]:not([data-zh-keep]) {
    animation: none !important;
  }
}

/* Pop-ups never run off the window (SRC-038 "sometimes it does not fit"): at most the room
   Radix measured on the side they open to, and they scroll inside. */
html.zaicode-fonts [data-slot="popover-content"] {
  max-height: var(--radix-popover-content-available-height, 100vh);
  overflow-y: auto;
}
html.zaicode-fonts [data-slot="context-menu-content"] {
  max-height: var(--radix-context-menu-content-available-height, 100vh);
  overflow-y: auto;
}

/* The sidebar answers instantly (SRC-043, saipen UI "visible states must be instant"):
   hover, selection and focus never fade in, so a row lights the moment the pointer is on it. */
[data-zaicode-instant], [data-zaicode-instant] *, [data-zaicode-instant] *::before, [data-zaicode-instant] *::after {
  transition: none !important;
}

/* Title alignment (Settings -> Layout & home -> Project list). */
html .zaicode-project-label { text-align: var(--zaicode-project-title-align, left); }
html .zaicode-session-label { text-align: var(--zaicode-session-title-align, left); }
`;

let injected = false;

/** Adds the stylesheet once (renderer only). */
export function ensureZaicodeMotionStyles(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const style = document.createElement("style");
  style.id = "zaicode-motion";
  style.textContent = ZAICODE_MOTION_CSS;
  document.head.appendChild(style);
}
