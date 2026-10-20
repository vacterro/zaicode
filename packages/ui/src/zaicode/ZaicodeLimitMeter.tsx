import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";
import {
  refreshZaicodeEngineLimits,
  useZaicodeEngines,
  visibleZaicodeAccounts,
} from "./zaicodeEngines.js";
import { ZaicodeLimitsPanel, useZaicodeClock, zaicodeReadingTitle } from "./ZaicodeLimitViews.js";
import {
  ZAICODE_LIMIT_METER_STYLES,
  isZaicodeEngineShown,
  zaicodeEngineUsableNow,
  setZaicodeLimitMeterStyle,
  useZaicodeLimitMeterStyle,
  useZaicodeMeterPrefs,
  orderZaicodeAccounts,
  type ZaicodeLimitMeterStyle,
} from "./zaicodeMeterPrefs.js";
import { MeterCell, type CellLook } from "./zaicodeLimitMeterCell.js";
import { ZaicodeMeterSettingsPanel } from "./ZaicodeMeterSettings.js";
import { ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import { ZaicodeAnchoredCard } from "./ZaicodeAnchoredCard.js";

// T-278: the refill/low watcher moved to its own module; the public import path
// for App.tsx stays this module.
export { useZaicodeLimitAlerts } from "./zaicodeLimitAlerts.js";

/**
 * AI Limit meter in the title bar (FastPrompter's header meter): one reading
 * per engine, hover for the full breakdown, click for Engines settings,
 * Ctrl+Click cycles Bars / Dots / Stacked, Shift+Click re-reads every quota,
 * right-click: which engines show and how (hide spent, only engines that
 * can work now, fill direction, vendor tint, names).
 */

export { setZaicodeLimitMeterStyle, useZaicodeLimitMeterStyle, type ZaicodeLimitMeterStyle };

const MAX_SHOWN = 9;

/** Natural width of the meter card. The anchored card clamps it to the viewport. */
const METER_CARD_WIDTH = 436;

export function ZaicodeLimitMeter({
  useWindowsCaptionSpacing = false,
}: {
  useWindowsCaptionSpacing?: boolean;
}) {
  const engines = useZaicodeEngines();
  const style = useZaicodeLimitMeterStyle();
  const prefs = useZaicodeMeterPrefs();
  const now = useZaicodeClock(30_000);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // SRC-161:REQ-003: the trigger, not a snapshot of it. The card re-reads this
  // on every move/resize and closes when the button is gone.
  const [hoverEl, setHoverEl] = useState<HTMLElement | null>(null);
  // REQ-004: the hover panel obeys the same meter filter as the bars; hidden
  // accounts stay one explicit temporary click away ("Show all"), never a
  // silent second list. Resets whenever the panel closes.
  const [hoverShowAll, setHoverShowAll] = useState(false);
  const [hoverShiftAll, setHoverShiftAll] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverFocused = useRef(false);
  const hoverPointer = useRef(false);
  const keepHover = () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const closeHover = () => {
    keepHover();
    hoverFocused.current = false;
    hoverPointer.current = false;
    setHoverEl(null);
    setHoverShowAll(false);
  };
  // Leave enough time to cross the gap into the portalled interactive card.
  const leaveHover = () => {
    keepHover();
    hoverTimer.current = setTimeout(() => {
      if (!hoverFocused.current && !hoverPointer.current) closeHover();
    }, 180);
  };
  const openHover = () => {
    keepHover();
    setHoverEl(buttonRef.current);
  };
  useEffect(
    () => () => {
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    },
    [],
  );
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Shift") setHoverShiftAll(event.type === "keydown");
    };
    const blur = () => setHoverShiftAll(false);
    document.addEventListener("keydown", key);
    document.addEventListener("keyup", key);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("keyup", key);
      window.removeEventListener("blur", blur);
    };
  }, []);
  const all = visibleZaicodeAccounts(engines);
  if (engines.accounts.length === 0) return null;
  const hiddenInEngines = engines.accounts.filter((account) =>
    engines.config.hiddenAccounts.includes(account.id),
  );
  const accounts = all.filter((account) =>
    isZaicodeEngineShown(account, engines.limits[account.id], prefs, "meter", now),
  );
  const shown = accounts.slice(0, MAX_SHOWN);
  const overflow = accounts.length - shown.length;
  const filtered = all.length - accounts.length;
  const hiddenAvailable = all.filter(
    (account) =>
      !accounts.includes(account) &&
      account.status === "ready" &&
      zaicodeEngineUsableNow(engines.limits[account.id], now),
  );
  const look: CellLook = {
    fill: prefs.fill,
    vendorTint: prefs.vendorTint,
    showLabels: prefs.showLabels,
  };

  return (
    <ZaicodeRightClickSettings
      title="AI limit meter"
      preferenceKey="meter"
      hint="Which engines the meter shows and how. Per-engine hide here affects the meter only."
      panel={<ZaicodeMeterSettingsPanel />}
      align="end"
    >
      <button
        ref={buttonRef}
        type="button"
        data-zaicode-limit-meter={style}
        data-zaicode-help="meter"
        className={cn(
          "flex h-8 shrink-0 items-center gap-1 px-1.5 text-foreground-subtle hover:bg-hover",
          useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
        )}
        aria-label={`AI limits: ${accounts
          .map(
            (account) =>
              zaicodeReadingTitle(account, engines.limits[account.id], now).split("\n")[1],
          )
          .join("; ")}`}
        aria-haspopup="dialog"
        aria-expanded={hoverEl !== null}
        onMouseEnter={(event) => {
          hoverPointer.current = true;
          setHoverShiftAll(event.shiftKey);
          openHover();
        }}
        onMouseLeave={() => {
          hoverPointer.current = false;
          leaveHover();
        }}
        onFocus={() => {
          hoverFocused.current = true;
          openHover();
        }}
        onBlur={() => {
          hoverFocused.current = false;
          leaveHover();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") closeHover();
        }}
        onContextMenu={closeHover}
        onClick={(event) => {
          if (event.ctrlKey || event.metaKey) {
            const next =
              ZAICODE_LIMIT_METER_STYLES[
                (ZAICODE_LIMIT_METER_STYLES.indexOf(style) + 1) % ZAICODE_LIMIT_METER_STYLES.length
              ]!;
            setZaicodeLimitMeterStyle(next);
            playZaicodeSound("ui.toggle");
            return;
          }
          if (event.shiftKey) {
            toast("Reading every quota…");
            void refreshZaicodeEngineLimits().then(() => playZaicodeSound("limits.refresh"));
            return;
          }
          setPendingSettingsSection("zaicodeEngines");
          openSettingsTab();
        }}
      >
        {shown.length === 0 ? (
          <span
            className="text-[9px] text-foreground-subtlest"
            title="Every engine is hidden by the meter rules"
          >
            AI —
          </span>
        ) : (
          <span
            className={cn(
              "flex items-end",
              style === "stacked" || look.showLabels ? "gap-1" : "gap-[3px]",
            )}
          >
            {shown.map((account) => (
              <MeterCell
                key={account.id}
                account={account}
                snapshot={engines.limits[account.id]}
                style={style}
                now={now}
                look={look}
              />
            ))}
          </span>
        )}
        {overflow > 0 ? (
          <span className="text-[9px] text-foreground-subtlest">+{overflow}</span>
        ) : null}
        {engines.sweeping ? (
          <span className="size-1 animate-pulse bg-[#c9a227]" aria-hidden="true" />
        ) : null}
      </button>
      {hoverEl ? (
        <ZaicodeAnchoredCard
          anchor={hoverEl.getBoundingClientRect()}
          anchorEl={hoverEl}
          width={METER_CARD_WIDTH}
          side="bottom"
          ariaLabel="AI limits"
          interactive
          interaction={{
            onMouseEnter: () => {
              hoverPointer.current = true;
              keepHover();
            },
            onMouseLeave: () => {
              hoverPointer.current = false;
              leaveHover();
            },
            onFocusCapture: () => {
              hoverFocused.current = true;
              keepHover();
            },
            onBlurCapture: () => {
              hoverFocused.current = false;
              leaveHover();
            },
            onKeyDown: (event) => {
              if (event.key === "Escape") closeHover();
            },
          }}
          className="p-2"
        >
          <ZaicodeLimitsPanel
            accounts={
              hoverShiftAll
                ? orderZaicodeAccounts(engines.accounts, prefs.accountOrder)
                : hoverShowAll
                  ? all
                  : accounts
            }
            limits={engines.limits}
            probing={engines.probing}
            now={now}
            footer={
              <>
                Click: Engines settings · Ctrl+Click: Bars / Dots / Stacked · Shift+Click: read all
                now · Right-click: what the meter shows · Hold Shift: all accounts · Ctrl+Click an
                account: may the Scheduler route work there
                {filtered > 0 && !hoverShowAll && !hoverShiftAll ? (
                  <button
                    type="button"
                    className="ml-1 border border-border px-1 text-foreground hover:bg-hover"
                    onClick={(event) => {
                      event.stopPropagation();
                      setHoverShowAll(true);
                    }}
                  >
                    Show all {filtered} hidden
                  </button>
                ) : null}
                {hoverShowAll ? (
                  <button
                    type="button"
                    className="ml-1 border border-border px-1 text-foreground hover:bg-hover"
                    onClick={(event) => {
                      event.stopPropagation();
                      setHoverShowAll(false);
                    }}
                  >
                    Back to meter filter
                  </button>
                ) : null}
                {hiddenAvailable.length > 0 ? (
                  <span className="block text-foreground-subtle">
                    {hiddenAvailable.map((account) => account.short).join(", ")} can work now;
                    display filters hide {hiddenAvailable.length === 1 ? "it" : "them"}. Right-click
                    the meter to change the filters.
                  </span>
                ) : null}
                {hiddenInEngines.length > 0 ? (
                  <span className="block text-foreground-subtle">
                    {hiddenInEngines.map((account) => account.short).join(", ")} hidden in Engines
                    settings.
                  </span>
                ) : null}
                {overflow > 0 ? ` · +${overflow} more than fit in the header` : ""}
              </>
            }
          />
        </ZaicodeAnchoredCard>
      ) : null}
    </ZaicodeRightClickSettings>
  );
}
