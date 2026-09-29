import { FolderOpen, RefreshCw } from "lucide-react";
import { openZaicodeCustomizationFolder, refreshZaicodeCustomSounds, useZaicodeCustomSounds } from "@/zaicode/zaicodeCustomSounds.js";

/**
 * "Your sounds folder" on the Sounds page (T-126, SRC-089): where the folder is, how many sounds are in it right
 * now, one button to open it. The list is live (the desktop watches the folder), so there is nothing to press
 * after dropping a file in; "Scan again" exists for the day a file system does not announce its changes.
 * Nothing is shown without the desktop app, which is the only one that has such a folder.
 */

const button = "flex items-center gap-1 border border-border px-1.5 py-px text-ui-xs text-foreground-subtle hover:bg-hover hover:text-foreground";

export function ZaicodeCustomSoundsStrip() {
  const { available, info, mine, truncated } = useZaicodeCustomSounds();
  if (!available || !info) return null;
  return (
    <div className="mt-2 flex flex-col gap-1 border border-border/60 bg-background px-2 py-1 text-ui-xs" data-zaicode-custom-sounds>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground-subtle">Your sounds folder</span>
        <span className="min-w-[12rem] flex-1 select-text break-all text-foreground" title={info.soundsDir}>
          {info.soundsDir}
        </span>
        <span className="tabular-nums text-foreground-subtle">{mine.length === 1 ? "1 sound" : `${mine.length} sounds`}</span>
        <button type="button" className={button} title="Open the folder in the file manager" onClick={() => void openZaicodeCustomizationFolder({ kind: "sounds" })}>
          <FolderOpen className="size-3" />
          Open folder
        </button>
        <button type="button" className={button} title="Look at the folder again" onClick={() => void refreshZaicodeCustomSounds()}>
          <RefreshCw className="size-3" />
          Scan again
        </button>
      </div>
      <div className="text-foreground-subtlest">
        Drop WAV, MP3 or OGG files there (sub-folders are fine). They appear in every sound picker under “Mine” at once, no restart.
        {truncated ? " The folder holds more files than are listed (5000 files, 5 folders deep)." : ""}
      </div>
    </div>
  );
}
