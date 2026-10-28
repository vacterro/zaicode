import { ZaicodePrefCheck, ZaicodePrefStepper } from "@/zaicode/ZaicodePrefControls.js";
import { ZAICODE_AUTO_RETRY_HARD_CAP, useZaicodeUiPrefs } from "@/zaicode/zaicodeUiPrefs.js";

/** SRC-051: what ZAICODE does when a turn fails (limit, network, provider). */
export function ZaicodeRetrySettings() {
  const autoRetry = useZaicodeUiPrefs((state) => state.autoRetry);
  const intervalSec = useZaicodeUiPrefs((state) => state.autoRetryIntervalSec);
  const maxAttempts = useZaicodeUiPrefs((state) => state.autoRetryMaxAttempts);
  const update = useZaicodeUiPrefs((state) => state.update);
  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-4" data-zaicode-retry-settings>
      <h2 className="text-ui-lg text-foreground">Failed turns</h2>
      <p className="max-w-[580px] text-foreground-subtle">
        A turn that dies on a dropped connection or an empty provider answer retries on its own — in the chat you
        have open (countdown under the error banner) and in the background for every project the sidebar sees. It
        only happens while the sidebar's Auto is ON (a session set to Auto-continue: On excepted), each wait is
        twice the last, and a usage limit is never retried blindly: the reset lifts it, Retry now tries once. The
        sidebar shows every scheduled retry and stops them all with one click. The first clean finish resets the
        budget.
      </p>
      <ZaicodePrefCheck
        checked={autoRetry}
        onChange={(value) => update({ autoRetry: value })}
        label="Auto retry · global default"
        hint="Session and project overrides take precedence. The composer shows the effective state, including Auto and session auto-continue."
      />
      <ZaicodePrefStepper
        label="First retry after"
        value={intervalSec}
        min={10}
        max={3600}
        step={10}
        suffix=" s"
        disabled={!autoRetry}
        onChange={(value) => update({ autoRetryIntervalSec: value })}
      />
      <ZaicodePrefStepper
        label="Give up after"
        value={Math.min(maxAttempts, ZAICODE_AUTO_RETRY_HARD_CAP)}
        min={1}
        max={ZAICODE_AUTO_RETRY_HARD_CAP}
        suffix=" attempts"
        disabled={!autoRetry}
        onChange={(value) => update({ autoRetryMaxAttempts: value })}
      />
    </section>
  );
}
