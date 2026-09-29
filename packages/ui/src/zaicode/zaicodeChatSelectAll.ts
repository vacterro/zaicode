/**
 * Ctrl+A in the chat selects the chat (T-131, SRC-094).
 *
 * In a desktop window with no text field focused, the browser's select-all takes the whole page: the sidebar, the title bar, the
 * composer, half the program. Inside a session that is never what anybody wants. The rule: when the keyboard is in the chat
 * (focus inside it, or the selection, or the last click was on it) and not in a text field, select the chat's text and nothing else.
 * In a text field (the composer, a rename box) select-all keeps its meaning: that field's text. Elsewhere it is left alone.
 *
 * The chat is the timeline's scroll area (`data-v4-timeline-scroll`). It is virtualised, so what select-all takes is the rows it has
 * drawn (the visible window and a margin), not the whole history.
 */

/** The session transcript (the timeline's scroll area); `role="log"` is the same thing in the conversation building block. */
const CHAT = '[data-v4-timeline-scroll="true"], [role="log"]';

interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  parentElement?: ElementLike | null;
  closest?(selector: string): ElementLike | null;
}

function elementOf(node: unknown): ElementLike | null {
  if (!node || typeof node !== "object") return null;
  const candidate = node as ElementLike;
  return typeof candidate.closest === "function" ? candidate : (candidate.parentElement ?? null);
}

/** A control where select-all means "the text in this control". */
export function isZaicodeTextEntry(node: unknown): boolean {
  const element = elementOf(node);
  if (!element) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(element.closest?.('[contenteditable="true"], [contenteditable=""]'));
}

function chatOf(node: unknown): ElementLike | null {
  return elementOf(node)?.closest?.(CHAT) ?? null;
}

/** The chat a Ctrl+A should select, or null (not in a chat, or in a text field: the browser does its own thing). */
export function zaicodeChatForSelectAll(where: { active: unknown; anchor: unknown; pointer: unknown }): ElementLike | null {
  if (isZaicodeTextEntry(where.active)) return null;
  return chatOf(where.active) ?? chatOf(where.anchor) ?? chatOf(where.pointer);
}

export interface ZaicodeSelectAllKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/** Plain Ctrl+A / Cmd+A: not Shift, not Alt, not already handled by somebody else. */
export function isZaicodeSelectAllKey(event: ZaicodeSelectAllKey): boolean {
  return !event.defaultPrevented && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "a";
}

let installed = false;

export function installZaicodeChatSelectAll(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  // Clicking blank space in the chat leaves the focus on the page and no selection in the chat: remember where the pointer went.
  let pointer: EventTarget | null = null;
  document.addEventListener("pointerdown", (event) => void (pointer = event.target), true);
  document.addEventListener(
    "keydown",
    (event) => {
      if (!isZaicodeSelectAllKey(event)) return;
      const selection = window.getSelection();
      const chat = zaicodeChatForSelectAll({ active: document.activeElement, anchor: selection?.anchorNode ?? null, pointer });
      if (!chat || !selection) return;
      event.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(chat as unknown as Node);
      selection.removeAllRanges();
      selection.addRange(range);
    },
    true,
  );
}
