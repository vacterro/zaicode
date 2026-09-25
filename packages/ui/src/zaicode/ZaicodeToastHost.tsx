import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  useZaicodeNotifySettings,
  useZaicodeToasts,
  type ZaicodeNotifyPosition,
  type ZaicodeToast,
} from "./zaicodeNotifications.js";

const POSITION_CLASS: Record<ZaicodeNotifyPosition, string> = {
  "bottom-right": "bottom-3 right-3 flex-col-reverse items-end",
  "top-right": "top-14 right-3 flex-col items-end",
  "bottom-left": "bottom-3 left-3 flex-col-reverse items-start",
  "top-center": "top-14 left-1/2 -translate-x-1/2 flex-col items-center",
};

/** Seconds -> "12s", "3m". */
function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

function ToastCard({ toast, now }: { toast: ZaicodeToast; now: number }) {
  const dismiss = useZaicodeToasts((state) => state.dismiss);
  const left = toast.expiresAt === null ? null : toast.expiresAt - now;
  return (
    <div
      role="status"
      data-zaicode-toast={toast.scenario}
      className="pointer-events-auto flex w-[300px] flex-col border border-[var(--zaicode-highlight,var(--color-border-hover))] bg-card text-ui-xs text-foreground"
    >
      <div className="flex items-center gap-1.5 border-b border-border bg-selected px-1.5 py-0.5">
        <span className="size-2 shrink-0" style={{ background: toast.accent }} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-foreground-subtle">{toast.header}</span>
        <span className="shrink-0 tabular-nums text-foreground-subtlest">
          {left === null ? "stays" : age(left)}
        </span>
        <button
          type="button"
          title="Dismiss"
          aria-label="Dismiss"
          className="flex size-4 items-center justify-center text-foreground-subtle hover:bg-hover hover:text-foreground"
          onClick={() => dismiss(toast.id)}
        >
          <X className="size-3" />
        </button>
      </div>
      <div className="flex flex-col gap-0.5 px-2 py-1.5">
        <span className="font-semibold text-foreground">{toast.title}</span>
        {toast.body ? <span className="whitespace-pre-line text-foreground-subtle">{toast.body}</span> : null}
        {toast.status ? <span style={{ color: toast.accent }}>{toast.status}</span> : null}
      </div>
      {toast.actions.length > 0 ? (
        <div className="flex flex-wrap justify-end gap-1 px-2 pb-1.5">
          {toast.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="border border-border bg-background px-1.5 text-foreground hover:bg-hover"
              onClick={() => {
                action.run();
                if (!action.keepOpen) dismiss(toast.id);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Renders ZAICODE notification cards. Mount once. */
export function ZaicodeToastHost() {
  const toasts = useZaicodeToasts((state) => state.toasts);
  const dismissAll = useZaicodeToasts((state) => state.dismissAll);
  const settings = useZaicodeNotifySettings();
  const [now, setNow] = useState(() => Date.now());
  const hoveredRef = useRef(false);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      // Reading a card pauses it: nothing expires under the pointer.
      if (hoveredRef.current) return;
      const expired = useZaicodeToasts
        .getState()
        .toasts.filter((toast) => toast.expiresAt !== null && toast.expiresAt <= current);
      if (expired.length > 0) {
        useZaicodeToasts.setState((state) => ({
          toasts: state.toasts.filter((toast) => !expired.some((gone) => gone.id === toast.id)),
        }));
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [toasts.length]);

  if (toasts.length === 0 || typeof document === "undefined") return null;
  const shown = toasts.slice(-settings.maxVisible);
  const hidden = toasts.length - shown.length;
  return createPortal(
    <div
      className={cn("pointer-events-none fixed z-[9998] flex gap-1.5", POSITION_CLASS[settings.position])}
      onMouseEnter={() => {
        hoveredRef.current = true;
      }}
      onMouseLeave={() => {
        hoveredRef.current = false;
      }}
      data-zaicode-toast-host
    >
      {shown.map((toast) => (
        <ToastCard key={toast.id} toast={toast} now={now} />
      ))}
      {hidden > 0 || toasts.length > 1 ? (
        <div className="pointer-events-auto flex gap-1 text-ui-xs">
          {hidden > 0 ? <span className="bg-card px-1 text-foreground-subtlest">+{hidden} more</span> : null}
          <button
            type="button"
            className="border border-border bg-card px-1 text-foreground-subtle hover:bg-hover hover:text-foreground"
            onClick={dismissAll}
          >
            Dismiss all
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
