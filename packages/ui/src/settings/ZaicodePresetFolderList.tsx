import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import type { PresetFolder } from "@/zaicode/zaicodeCustomPresets.js";

/**
 * The preset files sitting in the customization folder, under Import (T-126): an export lands there with one click,
 * and a file somebody sent is dropped there and shows up here without a restart. Only the files named for this page
 * are listed (`zaicode-preset-sounds-…`); anything else goes through "Import file…".
 */

const button = "flex items-center gap-1 border border-border px-1.5 py-px text-ui-xs text-foreground-subtle hover:bg-hover hover:text-foreground disabled:opacity-40";

export function ZaicodePresetFolderList({ folder, prefix, disabled, onPick }: { folder: PresetFolder; prefix: string; disabled: boolean; onPick: (name: string) => void }) {
  const [names, setNames] = useState<string[]>([]);
  const [location, setLocation] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => void folder.list().then((all) => alive && setNames(all.filter((name) => name.startsWith(prefix))));
    load();
    void folder.location().then((path) => alive && setLocation(path));
    const stop = folder.onChange(load);
    // The folder may have been changed while the window was in the background.
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      stop();
      window.removeEventListener("focus", load);
    };
  }, [folder, prefix]);

  return (
    <div className="flex flex-col gap-1" data-zaicode-presets-folder>
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-foreground-subtle" title={location ?? undefined}>
          In the presets folder{location ? `: ${location}` : ""}
        </span>
        <button type="button" className={button} title="Open the presets folder in the file manager" onClick={() => folder.open()}>
          <FolderOpen className="size-3" />
          Open folder
        </button>
      </div>
      {names.length === 0 ? (
        <div className="text-foreground-subtlest">Exports are saved here. Drop a preset file for this page in the folder and it is listed here.</div>
      ) : (
        <div role="list" className="flex max-h-28 flex-col overflow-y-auto border border-border/50">
          {names.map((name) => (
            <div key={name} role="listitem" className="flex items-center gap-1 border-b border-border/50 px-1 py-px last:border-b-0">
              <span className="min-w-0 flex-1 truncate text-foreground" title={name}>
                {name.slice(prefix.length).replace(/\.json$/i, "")}
              </span>
              <button type="button" className={button} disabled={disabled} title={`Read ${name} and show what it would change`} onClick={() => onPick(name)}>
                Import
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
