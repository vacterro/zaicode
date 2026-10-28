import { useEffect, useRef } from "react";
import { isZaicodeProductMode } from "@zcode/shared";
import {
  useZaicodeChangeFloaters,
  zaicodeFloatersFor,
  zaicodeSpawnedFiles,
  type ZaicodeChangedFile,
} from "./zaicodeChangeFloaters.js";
import { launchZaicodeFloaters, zaicodeCounterLook } from "./zaicodeFloaterLayer.js";

/**
 * RPG `spawned` (Wave 3, part D).
 *
 * A new file is announced once, from the authoritative changes stream, and the
 * announcement is a difference between two readings rather than a count: a
 * file already in the previous reading is not new, so a refresh, a re-render
 * or the 60 s git poll cannot spawn it twice. Only a backend that reports the
 * file as `added` spawns it, so a rename or a move stays a rename.
 *
 * The number is anchored to the Changes counter already on screen, which is
 * where a heal or a damage number would come from, so all three read as one
 * system. A batch coalesces into a single number with an exact count.
 */
export function ZaicodeGitSpawnWatcher({ files, scopeKey }: { files: readonly ZaicodeChangedFile[]; scopeKey: string }) {
  const prefs = useZaicodeChangeFloaters();
  const previous = useRef<{ key: string; files: readonly ZaicodeChangedFile[] } | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    const sameScope = previous.current?.key === scopeKey;
    const before = sameScope ? previous.current!.files : null;
    previous.current = { key: scopeKey, files };
    if (!isZaicodeProductMode()) return;
    const spawned = zaicodeSpawnedFiles(before, files);
    if (spawned.length === 0) return;
    const current = prefsRef.current;
    const made = zaicodeFloatersFor({ heal: 0, damage: 0, spawned }, current);
    if (made.length === 0) return;
    launchZaicodeFloaters(
      () => document.querySelector("[data-zaicode-change-counter]")?.getBoundingClientRect() ?? null,
      made,
      current,
      zaicodeCounterLook(current),
      { sound: current.sound, soundEcho: true },
    );
  }, [files, scopeKey]);

  return null;
}
