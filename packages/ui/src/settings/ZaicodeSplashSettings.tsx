import { useEffect, useState } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";

/**
 * Settings -> ZAICODE -> Start-up splash (SRC-049). The splash picture that
 * appears the moment ZAICODE starts (launcher and app) is the operator's:
 * switch it off entirely (the app then appears only when loaded, never grey),
 * or pick any picture. The in-window loading shell uses the same picture.
 */

const SPLASH_IMAGE_KEY = "zaicode-splash-image";

interface SplashPrefs {
  enabled: boolean;
  hasCustom: boolean;
  customDataUrl: string | null;
}

/** The in-window loading shell reads this synchronously at boot (renderer/index.html). */
function syncLoadingShellImage(dataUrl: string | null): void {
  try {
    if (dataUrl) localStorage.setItem(SPLASH_IMAGE_KEY, dataUrl);
    else localStorage.removeItem(SPLASH_IMAGE_KEY);
  } catch {
    // The main-process copy still applies; only the pre-boot mirror fails.
  }
}

export function ZaicodeSplashSettings() {
  const platform = usePlatform();
  const [prefs, setPrefs] = useState<SplashPrefs | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void platform
      .getZaicodeSplashPrefs?.()
      .then((loaded) => {
        setPrefs(loaded);
        syncLoadingShellImage(loaded.customDataUrl);
      })
      .catch(() => setPrefs({ enabled: true, hasCustom: false, customDataUrl: null }));
  }, [platform]);

  const apply = (input: { enabled: boolean; imagePath?: string | null }) => {
    if (!platform.setZaicodeSplashPrefs) return;
    setBusy(true);
    setMessage(null);
    void platform
      .setZaicodeSplashPrefs(input)
      .then((next) => {
        setPrefs(next);
        syncLoadingShellImage(next.customDataUrl);
        setMessage(
          input.imagePath === null
            ? "Back to the bundled picture."
            : input.imagePath
              ? "Custom picture installed."
              : next.enabled
                ? "Splash will show on the next start."
                : "Splash off: the app appears only when loaded.",
        );
      })
      .catch((caught: unknown) => setMessage(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4" data-zaicode-splash-settings>
      <label className="flex items-center justify-between gap-3">
        <span className="flex flex-col gap-1">
          <span className="text-ui-base text-foreground">Start-up splash</span>
          <span className="text-ui-xs text-foreground-subtle">
            The picture that appears while ZAICODE loads (launcher and app). Off = nothing until the
            interface is ready — no grey window, ever.
          </span>
        </span>
        <Switch
          checked={prefs?.enabled ?? true}
          disabled={busy || !prefs || !platform.setZaicodeSplashPrefs}
          onCheckedChange={(enabled) => apply({ enabled })}
        />
      </label>
      <div className="mt-3 flex items-center gap-2">
        {prefs?.customDataUrl ? (
          <img
            src={prefs.customDataUrl}
            alt="Custom splash picture"
            className="h-[75px] w-[140px] shrink-0 border border-border object-cover"
          />
        ) : (
          <span className="flex h-[75px] w-[140px] shrink-0 items-center justify-center border border-border text-ui-xs text-foreground-subtlest">
            {prefs?.hasCustom ? "custom" : "default"}
          </span>
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !prefs || !platform.setZaicodeSplashPrefs || !platform.selectFile}
              onClick={() => {
                void platform
                  .selectFile()
                  .then((path) => {
                    if (path) apply({ enabled: prefs?.enabled ?? true, imagePath: path });
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
              disabled={busy || !prefs?.hasCustom || !platform.setZaicodeSplashPrefs}
              onClick={() => apply({ enabled: prefs?.enabled ?? true, imagePath: null })}
            >
              Use default picture
            </Button>
          </div>
          <span className="text-ui-xs text-foreground-subtlest">
            PNG / JPEG / GIF / WebP / BMP. Used by the launcher splash, the app splash and the
            in-window loading picture. Applies on the next start.
          </span>
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
