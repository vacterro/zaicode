import { useEffect, useState } from "react";
import { RotateCw, X } from "lucide-react";
import type { ZaicodeAutoRetryState } from "./zaicodeAutoRetry.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";

/** One line under the error banner: when the next automatic retry happens, and how to stop it. */
export function ZaicodeAutoRetryNotice({ state }: { state: ZaicodeAutoRetryState }) {
  const autoRetry = useZaicodeUiPrefs((prefs) => prefs.autoRetry);
  const update = useZaicodeUiPrefs((prefs) => prefs.update);
  const [now, setNow] = useState(() => Date.now());
  // SRC-070 (D): the notice is closable in every state it can be in. Closing
  // it stops the retry behind it, so the source event is not silenced -- the
  // next new error arms it again -- and nothing fires where the operator
  // cannot reach it.
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    setClosed(false);
  }, [state.attempts, state.exhausted, state.armed]);
  useEffect(() => {
    if (!state.nextAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.nextAt]);
  if (closed) return null;
  if (!state.available && !state.exhausted) return null;
  const seconds = state.nextAt ? Math.max(0, Math.ceil((state.nextAt - now) / 1000)) : null;
  const close = () => {
    state.stop();
    setClosed(true);
  };
  return (
    <div
      role="status"
      className="mt-1 flex flex-wrap items-center gap-2 border border-border bg-card px-2 py-1 text-ui-xs text-foreground-subtle"
      data-zaicode-auto-retry={state.nextAt ? "armed" : state.exhausted ? "exhausted" : "idle"}
    >
      <RotateCw className={state.nextAt ? "size-3.5 animate-spin [animation-duration:3s]" : "size-3.5"} />
      {state.nextAt && seconds !== null ? (
        <span>
          Auto-retry in <strong className="font-normal text-foreground tabular-nums">{seconds} s</strong> · attempt{" "}
          <span className="tabular-nums">
            {state.attempts + 1}/{state.maxAttempts}
          </span>
        </span>
      ) : state.blockedBy === "quota" ? (
        <span data-zaicode-retry-blocked="quota">
          Usage limit: nothing retries by itself, asking again does not lift it. Retry now tries once.
        </span>
      ) : state.blockedBy === "auto-off" ? (
        <span data-zaicode-retry-blocked="auto-off">
          Auto is OFF: nothing retries by itself. Retry now, or turn Auto ON in the sidebar.
        </span>
      ) : state.exhausted ? (
        <span className="text-destructive">
          Auto-retry gave up after {state.maxAttempts} attempts.
        </span>
      ) : !autoRetry ? (
        <span>Auto-retry is off.</span>
      ) : (
        <span>Auto-retry stopped for this error.</span>
      )}
      <span className="ml-auto flex items-center gap-1">
        {state.available ? (
          <button
            type="button"
            className="border border-border px-1.5 text-foreground hover:bg-hover"
            onClick={state.retryNow}
          >
            Retry now
          </button>
        ) : null}
        {/* Reachable whenever a retry is live, not only while the countdown runs:
            an exhausted notice used to leave the operator with no stop at all. */}
        {state.available ? (
          <button
            type="button"
            className="border border-border px-1.5 hover:bg-hover hover:text-foreground"
            onClick={state.stop}
            title="Stop retrying this error (the next new error arms it again)"
          >
            Stop auto-retry
          </button>
        ) : null}
        <button
          type="button"
          className="border border-border px-1.5 hover:bg-hover hover:text-foreground"
          onClick={() => update({ autoRetry: !autoRetry })}
          title="Auto-retry after errors, for every session. It also needs the sidebar Auto ON (Settings -> Workers)"
        >
          {autoRetry ? "Auto: on" : "Auto: off"}
        </button>
        <button
          type="button"
          className="flex size-6 items-center justify-center border border-border hover:bg-hover hover:text-foreground"
          onClick={close}
          title="Close this notice and stop auto-retry for this error"
          aria-label="Close this notice and stop auto-retry for this error"
          data-zaicode-auto-retry-close
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}
