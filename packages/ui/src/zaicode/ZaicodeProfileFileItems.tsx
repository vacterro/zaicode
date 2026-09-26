import { Download, Upload } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu.js";
import { downloadZaicodeTextFile, pickZaicodeJsonFile, zaicodeFileStem } from "./zaicodeFiles.js";
import { exportZaicodeProfile, importZaicodeProfile } from "./zaicodeProfiles.js";

/**
 * Profiles menu: the profile in use to a file, and a file to a new profile
 * (SRC-048). Importing switches to the new profile (the window reloads).
 */
export function ZaicodeProfileFileItems({ onError }: { onError: (message: string) => void }) {
  return (
    <>
      <DropdownMenuItem
        onSelect={() => {
          const { fileStem, json } = exportZaicodeProfile();
          downloadZaicodeTextFile(`zaicode-profile-${zaicodeFileStem(fileStem, "profile")}.json`, json);
        }}
      >
        <Download className="size-4" />
        Export this profile…
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() =>
          pickZaicodeJsonFile((text) => {
            const result = importZaicodeProfile(text);
            if (!result.ok) onError(result.message);
          })
        }
      >
        <Upload className="size-4" />
        Import profile…
      </DropdownMenuItem>
    </>
  );
}
