import { useEffect, useState } from "react";
import {
  DEFAULT_ZAICODE_SPLASH_OPTIONS,
  ZAICODE_SPLASH_MAX_WAIT_SECONDS,
  zaicodeSplashSize,
  type ZaicodeSplashFit,
  type ZaicodeSplashOptions,
  type ZaicodeSplashPrefsInput,
  type ZaicodeSplashPrefsState,
  type ZaicodeSplashScale,
} from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { ZaicodePrefCheck, ZaicodePrefSegment } from "@/zaicode/ZaicodePrefControls.js";
import { mirrorZaicodeSplashBoot } from "@/zaicode/zaicodeSplashMirror.js";

/**
 * Settings -> ZAICODE -> Start-up splash (SRC-049, SRC-060). The picture that
 * appears the moment ZAICODE starts (launcher and app) is the operator's:
 * switch it off, pick any picture, choose how it fills the box and how big the
 * box is, and whether it stays until the interface is fully loaded.
 *
 * SRC-060: this card was locked for every operator. The desktop platform
 * adapter never passed the two splash calls through, so `prefs` stayed null
 * and every control stayed disabled.
 */

const FIT_OPTIONS: readonly { value: ZaicodeSplashFit; label: string; hint: string }[] = [
  { value: "contain", label: "Whole picture", hint: "The whole picture is visible; free space gets the dark background." },
  { value: "cover", label: "Fill, crop edges", hint: "The picture fills the box; what sticks out is cut evenly." },
  { value: "stretch", label: "Stretch", hint: "The picture fills the box exactly and may look squashed." },
];

const SCALE_OPTIONS: readonly { value: `${ZaicodeSplashScale}`; label: string; hint: string }[] = [
  { value: "1", label: "560×300", hint: "Normal size" },
  { value: "1.5", label: "840×450", hint: "One and a half times" },
  { value: "2", label: "1120×600", hint: "Twice the size (pixel-sharp for the bundled picture)" },
];

const WAIT_OPTIONS = ZAICODE_SPLASH_MAX_WAIT_SECONDS.map((seconds) => ({
  value: `${seconds}` as const,
  label: `${seconds} s`,
  hint: `Show the app after ${seconds} seconds even if it is still loading`,
}));

const OBJECT_FIT: Record<ZaicodeSplashFit, "contain" | "cover" | "fill"> = {
  contain: "contain",
  cover: "cover",
  stretch: "fill",
};

export function ZaicodeSplashSettings() {
  const platform = usePlatform();
  const [prefs, setPrefs] = useState<ZaicodeSplashPrefsState | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [bundledBroken, setBundledBroken] = useState(false);

  useEffect(() => {
    const load = platform.getZaicodeSplashPrefs;
    if (!load) {
      setUnavailable(true);
      return;
    }
    void load()
      .then((loaded) => {
        setPrefs(loaded);
        mirrorZaicodeSplashBoot(loaded);
      })
      .catch((caught: unknown) => {
        setUnavailable(true);
        setMessage(caught instanceof Error ? caught.message : String(caught));
      });
  }, [platform]);

  const canEdit = Boolean(prefs && platform.setZaicodeSplashPrefs) && !busy;

  const apply = (input: ZaicodeSplashPrefsInput, done: string) => {
    if (!platform.setZaicodeSplashPrefs) return;
    setBusy(true);
    setMessage(null);
    void platform
      .setZaicodeSplashPrefs(input)
      .then((next) => {
        setPrefs(next);
        mirrorZaicodeSplashBoot(next);
        setMessage(done);
      })
      .catch((caught: unknown) => setMessage(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setBusy(false));
  };

  const setOption = <K extends keyof ZaicodeSplashOptions>(key: K, value: ZaicodeSplashOptions[K]) => {
    if (!prefs) return;
    apply({ enabled: prefs.enabled, options: { [key]: value } }, "Saved. Applies on the next start.");
  };

  const options: ZaicodeSplashOptions = prefs ?? DEFAULT_ZAICODE_SPLASH_OPTIONS;
  const size = zaicodeSplashSize(options.scale);
  const pictureSrc = prefs?.customDataUrl ?? (bundledBroken ? null : "./zaicode-splash.png");

  return (
    <section className="rounded-xl border border-border bg-card p-4" data-zaicode-splash-settings data-zaicode-help="splash">
      <label className="flex items-center justify-between gap-3">
        <span className="flex flex-col gap-1">
          <span className="text-ui-base text-foreground">Start-up splash</span>
          <span className="text-ui-xs text-foreground-subtle">
            The picture that appears the moment ZAICODE starts (launcher and app), while the
            interface loads. Off = nothing shows until the app is ready.
          </span>
        </span>
        <Switch
          checked={prefs?.enabled ?? true}
          disabled={!canEdit}
          onCheckedChange={(enabled) =>
            apply(
              { enabled },
              enabled ? "Splash on. Applies on the next start." : "Splash off: the app appears only when it is loaded.",
            )
          }
        />
      </label>

      {unavailable ? (
        <p className="mt-2 text-ui-xs text-foreground-subtle" role="status">
          Only the desktop app can change the start-up splash.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-start gap-3">
        <div
          className="relative shrink-0 overflow-hidden border border-border bg-[#1a1810]"
          style={{ width: 224, height: 120 }}
          title={`Preview of the ${size.width}×${size.height} splash`}
          data-zaicode-splash-preview
        >
          {pictureSrc ? (
            <img
              src={pictureSrc}
              alt="Start-up picture"
              className="block size-full"
              style={{ objectFit: OBJECT_FIT[options.fit] }}
              onError={() => {
                if (!prefs?.customDataUrl) setBundledBroken(true);
              }}
            />
          ) : (
            <span className="flex size-full items-center justify-center text-ui-xs text-foreground-subtlest">
              {prefs?.hasCustom ? "custom" : "default"}
            </span>
          )}
          {options.status ? (
            <span className="absolute inset-x-1.5 bottom-1 flex justify-between text-[9px] leading-3 text-[#d4c89a]">
              <span>Loading…</span>
              <span className="text-[#9c9371]">ZAICODE</span>
            </span>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2 text-ui-xs">
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit || !platform.selectFile}
              onClick={() => {
                void platform
                  .selectFile()
                  .then((path) => {
                    if (path) apply({ enabled: prefs?.enabled ?? true, imagePath: path }, "Custom picture installed.");
                  })
                  .catch((caught: unknown) =>
                    setMessage(caught instanceof Error ? caught.message : String(caught)),
                  );
              }}
            >
              Pick picture…
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit || !prefs?.hasCustom}
              onClick={() => apply({ enabled: prefs?.enabled ?? true, imagePath: null }, "Back to the bundled picture.")}
            >
              Use default picture
            </Button>
          </div>
          <span className="text-foreground-subtlest">
            PNG / JPEG / GIF / WebP / BMP, any size: it is scaled into the box, never cut off by
            accident. Used by the launcher splash, the app splash and the in-window loading picture.
          </span>

          <ZaicodePrefSegment
            label="How the picture fills the box"
            value={options.fit}
            options={FIT_OPTIONS}
            disabled={!canEdit}
            onChange={(fit) => setOption("fit", fit)}
          />
          <ZaicodePrefSegment
            label="Splash size"
            value={`${options.scale}` as `${ZaicodeSplashScale}`}
            options={SCALE_OPTIONS}
            disabled={!canEdit}
            onChange={(scale) => setOption("scale", Number(scale) as ZaicodeSplashScale)}
          />
          <ZaicodePrefCheck
            checked={options.status}
            disabled={!canEdit}
            onChange={(status) => setOption("status", status)}
            label="Show the loading line"
            hint="What ZAICODE is doing right now and its version, at the bottom of the picture."
          />
          <ZaicodePrefCheck
            checked={options.holdUntilReady}
            disabled={!canEdit}
            onChange={(holdUntilReady) => setOption("holdUntilReady", holdUntilReady)}
            label="Keep the splash until ZAICODE is fully loaded"
            hint="The ready app replaces the picture in one step: no grey loading screen in between. Off = the app window appears early and shows its own loading screen."
          />
          <ZaicodePrefSegment
            label="Longest wait before the app shows anyway"
            value={`${options.maxWaitSec}` as (typeof WAIT_OPTIONS)[number]["value"]}
            options={WAIT_OPTIONS}
            disabled={!canEdit || !options.holdUntilReady}
            onChange={(seconds) => setOption("maxWaitSec", Number(seconds))}
          />
          <span className="text-foreground-subtlest">Every change applies on the next start.</span>
        </div>
      </div>

      {message ? (
        <p className="mt-2 text-ui-xs text-foreground-subtle" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
