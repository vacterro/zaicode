import type { ZaicodeNavItemId } from "./zaicodeLayoutPrefs.js";

// SRC-060: "Shift + F1 на элемент сразу переводил в HELP секцию и объяснял это
// всё досконально, каждый элемент, каждый пункт".
//
// The jump itself already worked: openZaicodeHelp(topic) stores the id, the
// settings section consumes it on mount and scrolls to the card. The missing
// half was the element -> topic lookup, so there was nothing to jump from.
//
// Resolution walks UP from the element under the pointer (or the focused one)
// to the nearest ancestor carrying ZAICODE_HELP_ATTRIBUTE. Tagging a surface's
// container once therefore covers every control inside it, which is what makes
// this maintainable: a new control inside a tagged surface needs no tag of its
// own, and a tagged surface cannot disagree with its own children.

export const ZAICODE_HELP_ATTRIBUTE = "data-zaicode-help";

/** Every topic id the help section defines. Kept in one place so the registry
 *  and the topic list can be asserted against each other. */
export const ZAICODE_HELP_TOPIC_IDS = [
  "start",
  "pebble",
  "engines",
  "meter",
  // SRC-061: subscription accounts as models in the model menu.
  "accounts",
  "workers",
  "saihome",
  "header",
  "continue",
  "zaicode",
  "timers",
  "notifications",
  "sounds",
  "hotkeys",
  "memory",
  "home",
  "saimail",
  "autostart",
  "zones",
  "dispatch",
  "scheduler",
  "search",
  "plugins",
  "settings",
  "composer",
  "audit",
  // SRC-060: the encyclopedia's own entries and surfaces that had no card.
  "glossary",
  "sidebar",
  "changes",
  "splash",
  "todo",
  // SRC-062: Settings -> Session text.
  "sessiontext",
  // SRC-062: Settings -> ProTrail (cursor trail and click effects, the whole desktop).
  "protrail",
] as const;

export type ZaicodeHelpTopicId = (typeof ZAICODE_HELP_TOPIC_IDS)[number];

const KNOWN = new Set<string>(ZAICODE_HELP_TOPIC_IDS);

export function isZaicodeHelpTopicId(value: string | null | undefined): value is ZaicodeHelpTopicId {
  return typeof value === "string" && KNOWN.has(value);
}

/**
 * The topic for whatever the operator is pointing at or has focused, or null
 * when the element carries no help of its own and no ancestor does either.
 *
 * The first recognised ancestor wins, so a control that lives inside a tagged
 * panel but has a more specific tag still answers for itself.
 */
export function zaicodeHelpTopicFor(element: Element | null | undefined): ZaicodeHelpTopicId | null {
  let node: Element | null = element ?? null;
  // Bounded so a detached or cyclic tree cannot spin here.
  for (let depth = 0; node && depth < 64; depth += 1) {
    const value = node.getAttribute?.(ZAICODE_HELP_ATTRIBUTE);
    if (isZaicodeHelpTopicId(value)) return value;
    node = node.parentElement;
  }
  return null;
}

/**
 * What Shift+F1 should open: the pointer wins over the focus, because the
 * operator presses the key while looking at a control rather than after
 * tabbing to it. Falls back to the focused element, then to null so the
 * caller can open Help at the top instead of jumping somewhere arbitrary.
 */
export function zaicodeHelpTopicUnderPointer(
  doc: Document | null | undefined = typeof document === "undefined" ? null : document,
): ZaicodeHelpTopicId | null {
  if (!doc) return null;
  const pointed = doc.elementFromPoint?.(lastPointerX, lastPointerY) ?? null;
  const fromPointer = zaicodeHelpTopicFor(pointed);
  if (fromPointer) return fromPointer;
  return zaicodeHelpTopicFor(doc.activeElement);
}

// The pointer position is tracked here rather than read from an event, because
// a keydown carries no coordinates and elementFromPoint needs some.
let lastPointerX = 0;
let lastPointerY = 0;

export function rememberZaicodeHelpPointer(event: { clientX: number; clientY: number }): void {
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
}

/** Which help topic each sidebar menu line explains. `help` and `timers` map
 *  to their own cards; the rest name the surface they open. */
// Typed against the nav id union on purpose: adding a menu line without a
// help topic is then a compile error rather than a silent gap.
export const ZAICODE_NAV_HELP_TOPICS: Record<ZaicodeNavItemId, ZaicodeHelpTopicId> = {
  saihome: "saihome",
  newTask: "composer",
  zaicode: "zaicode",
  scheduler: "scheduler",
  search: "search",
  plugins: "plugins",
  timers: "timers",
  help: "start",
  workers: "workers",
  settings: "settings",
};
