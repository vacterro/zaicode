import { BrowserWindow, Notification, type IpcMainInvokeEvent } from "electron";

/**
 * ZAICODE Windows notifications (SRC-035): native toasts from the main
 * process, shown whether or not ZAICODE is in front when the operator chose
 * them. A click brings the window that asked back to the front. The objects
 * are held until clicked or closed, or Windows drops the click handler.
 */

const MAX_HELD = 50;
const TITLE_MAX = 120;
const BODY_MAX = 400;
const held = new Set<Notification>();

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function focus(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

export function showZaicodeNotification(event: IpcMainInvokeEvent, input: unknown): { ok: boolean; message: string } {
  const payload = (input ?? {}) as { title?: unknown; body?: unknown };
  const title = text(payload.title, TITLE_MAX);
  if (!title) return { ok: false, message: "A notification needs a title." };
  if (!Notification.isSupported()) return { ok: false, message: "Windows notifications are not supported here." };
  const window = BrowserWindow.fromWebContents(event.sender);
  // silent: ZAICODE's Sounds table already plays the scenario's sound once.
  const notification = new Notification({ title, body: text(payload.body, BODY_MAX), silent: true });
  held.add(notification);
  if (held.size > MAX_HELD) {
    const oldest = held.values().next().value;
    if (oldest) held.delete(oldest);
  }
  notification.once("click", () => {
    held.delete(notification);
    focus(window);
  });
  notification.once("close", () => held.delete(notification));
  notification.show();
  return { ok: true, message: "" };
}
