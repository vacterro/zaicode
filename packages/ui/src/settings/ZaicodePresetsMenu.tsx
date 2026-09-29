import { Bookmark } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { zaicodePresetFolder } from "@/zaicode/zaicodeCustomPresets.js";
import { pruneZaicodePresetBlobs, zaicodePresetEnv } from "@/zaicode/zaicodePresetEnv.js";
import type { ZaicodePresetSectionId } from "@/zaicode/zaicodePresetSections.js";
import { useZaicodePresets } from "@/zaicode/zaicodePresetStore.js";
import { ZaicodePresetsPanel } from "./ZaicodePresetsPanel.js";

/**
 * The Presets button in the Settings title row (T-125): opens the presets of the page that is showing.
 * Every page in zaicodePresetSections.ts gets one; the panel does the work.
 */

const button = "flex items-center gap-1 border border-border px-1.5 py-px text-ui-xs text-foreground-subtle hover:bg-hover hover:text-foreground";

// One folder object for the life of the window: the panel's effects depend on its identity.
const folder = zaicodePresetFolder();

export function ZaicodePresetsMenu({ section }: { section: ZaicodePresetSectionId }) {
  const count = useZaicodePresets((state) => state.presets.filter((preset) => preset.section === section).length);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={button} data-zaicode-presets-menu={section} title="Save, apply, export and import presets for this page">
          <Bookmark className="size-3" />
          Presets
          {count > 0 ? <span className="text-foreground-subtlest">{count}</span> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[460px] max-w-[92vw] gap-2 rounded-none p-3">
        <ZaicodePresetsPanel section={section} env={zaicodePresetEnv} prune={pruneZaicodePresetBlobs} folder={folder} />
      </PopoverContent>
    </Popover>
  );
}
