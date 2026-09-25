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

const MIX = "calc(var(--zh-k) * var(--zh-s, 0.7) * 100%)";
const MIX_SOFT = "calc(var(--zh-k) * var(--zh-s, 0.7) * 35%)";
const LIT = `color-mix(in srgb, var(--zh-color, #f0c040) ${MIX}, transparent)`;
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

@keyframes zh-pulse { 0%, 100% { --zh-e-pulse: 1; } 50% { --zh-e-pulse: 0.25; } }
@keyframes zh-breathe { 0%, 100% { --zh-e-breathe: 0.12; } 50% { --zh-e-breathe: 1; } }
@keyframes zh-heartbeat { 0% { --zh-e-heartbeat: 0.2; } 10% { --zh-e-heartbeat: 1; } 20% { --zh-e-heartbeat: 0.35; } 30% { --zh-e-heartbeat: 1; } 45%, 100% { --zh-e-heartbeat: 0.2; } }
@keyframes zh-blink { 0%, 49.9% { --zh-e-blink: 1; } 50%, 100% { --zh-e-blink: 0; } }
@keyframes zh-strobe { 0%, 8% { --zh-e-strobe: 1; } 8.1%, 100% { --zh-e-strobe: 0; } }
@keyframes zh-flicker { 0% { --zh-e-flicker: 1; } 6% { --zh-e-flicker: 0.35; } 9% { --zh-e-flicker: 1; } 36% { --zh-e-flicker: 0.85; } 39% { --zh-e-flicker: 0.15; } 42% { --zh-e-flicker: 1; } 77% { --zh-e-flicker: 0.9; } 79% { --zh-e-flicker: 0.3; } 82%, 100% { --zh-e-flicker: 1; } }
@keyframes zh-hue { from { --zh-hue: 0deg; } to { --zh-hue: 360deg; } }

html [data-zh] {
  --zh-k: calc(${ZH_EFFECTS.map((effect) => `var(--zh-e-${effect})`).join(" * ")});
}
html [data-zh][data-zh-shape~="text"] {
  color: color-mix(in srgb, var(--zh-color, #f0c040) ${MIX}, var(--color-foreground)) !important;
}
html [data-zh][data-zh-shape~="glow"] {
  text-shadow: 0 0 calc(1px + 5px * var(--zh-k)) ${LIT}, 0 0 1px ${LIT} !important;
}
html [data-zh][data-zh-shape~="underline"] {
  --zh-underline: inset 0 -2px 0 ${LIT};
}
html [data-zh][data-zh-shape~="bar"] {
  --zh-bar: inset 3px 0 0 ${LIT};
}
/* Underline and side bar both draw with box-shadow: one declaration carries both. */
html [data-zh][data-zh-shape~="underline"],
html [data-zh][data-zh-shape~="bar"] {
  box-shadow: var(--zh-underline, 0 0 transparent), var(--zh-bar, 0 0 transparent) !important;
}
html [data-zh][data-zh-shape~="box"] {
  outline: 1px solid ${LIT} !important;
  outline-offset: -1px;
}
html [data-zh][data-zh-shape~="fill"] {
  background-color: color-mix(in srgb, var(--zh-color, #f0c040) ${MIX_SOFT}, transparent) !important;
}
html [data-zh][data-zh-shape~="dot"]::before {
  content: "";
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-right: 4px;
  vertical-align: middle;
  background: ${LIT};
}

@keyframes zw-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes zw-swing { 0%, 100% { transform: rotate(calc(var(--zw-deg) * -0.5)); } 50% { transform: rotate(calc(var(--zw-deg) * 0.5)); } }
@keyframes zw-wobble { 0%, 60%, 100% { transform: rotate(0deg); } 12% { transform: rotate(calc(var(--zw-deg) * 0.3)); } 24% { transform: rotate(calc(var(--zw-deg) * -0.3)); } 36% { transform: rotate(calc(var(--zw-deg) * 0.15)); } 48% { transform: rotate(calc(var(--zw-deg) * -0.1)); } }
@keyframes zw-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(var(--zw-scale)); } }
@keyframes zw-breathe { 0%, 100% { opacity: 1; } 50% { opacity: var(--zw-fade); } }
@keyframes zw-bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(calc(var(--zw-px) * -1)); } }
@keyframes zw-flip { from { transform: perspective(40px) rotateY(0deg); } to { transform: perspective(40px) rotateY(360deg); } }
@keyframes zw-blink { 0%, 49.9% { opacity: 1; } 50%, 100% { opacity: var(--zw-blink-low, 0.15); } }

/* Combined motions: the same movements on their own channels (see ZW_CHANNELS). */
@keyframes zwc-spin { from { --zw-r1: 0deg; } to { --zw-r1: 360deg; } }
@keyframes zwc-swing { 0%, 100% { --zw-r2: calc(var(--zw-deg) * -0.5); } 50% { --zw-r2: calc(var(--zw-deg) * 0.5); } }
@keyframes zwc-wobble { 0%, 60%, 100% { --zw-r3: 0deg; } 12% { --zw-r3: calc(var(--zw-deg) * 0.3); } 24% { --zw-r3: calc(var(--zw-deg) * -0.3); } 36% { --zw-r3: calc(var(--zw-deg) * 0.15); } 48% { --zw-r3: calc(var(--zw-deg) * -0.1); } }
@keyframes zwc-pulse { 0%, 100% { --zw-s: 1; } 50% { --zw-s: var(--zw-scale); } }
@keyframes zwc-breathe { 0%, 100% { --zw-o1: 1; } 50% { --zw-o1: var(--zw-fade); } }
@keyframes zwc-bounce { 0%, 100% { --zw-ty: 0px; } 50% { --zw-ty: calc(var(--zw-px) * -1); } }
@keyframes zwc-flip { from { --zw-ry: 0deg; } to { --zw-ry: 360deg; } }
@keyframes zwc-blink { 0%, 49.9% { --zw-o2: 1; } 50%, 100% { --zw-o2: var(--zw-blink-low, 0.15); } }

/* The calm interface stops every animation with !important; "keep moving" is the one opt-out. */
html.zaicode-no-motion [data-zh-keep][data-zh] {
  animation: var(--zh-anim) !important;
}
html.zaicode-no-motion [data-zaicode-working-icon][data-zw-keep] {
  animation: var(--zw-anim) !important;
}
@media (prefers-reduced-motion: reduce) {
  [data-zaicode-working-icon]:not([data-zw-keep]), [data-zh]:not([data-zh-keep]) {
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
