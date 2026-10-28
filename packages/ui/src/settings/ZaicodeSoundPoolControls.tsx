import { cn } from "@/components/lib/utils.js";
import { ZaicodeSoundPicker } from "@/zaicode/ZaicodeSoundPicker.js";
import { playZaicodeSoundFile } from "@/zaicode/zaicodeSoundEvents.js";
import { setZaicodeSoundSelectionMode, toggleZaicodePoolMember } from "@/zaicode/zaicodeSoundPoolActions.js";
import type { ZaicodeSoundEventDef, ZaicodeSoundEventSetting } from "@/zaicode/zaicodeSoundSettingsModel.js";
import { ZaicodePoolMembers } from "./ZaicodePoolMembers.js";

export { ZaicodePoolSummary } from "./ZaicodePoolMembers.js";

/**
 * Single or Pool, per event, in the row itself: one small cell that says "1" (one sound) or "N" (a weighted
 * pool) and flips on click. It used to be a whole extra line under EVERY event holding two buttons; with a
 * hundred events that was a hundred empty-looking lines (SRC-087).
 *
 * Switching keeps what the person had (T-127): into a pool, the sound the event plays becomes its first member;
 * back to single, the heaviest member becomes the sound, and the pool is kept for the next switch.
 */
export function ZaicodePoolModeButton({ event, row }: { event: ZaicodeSoundEventDef; row: ZaicodeSoundEventSetting }) {
  const pool = row.soundMode === "pool";
  return (
    <button
      type="button"
      data-zaicode-pool-mode={pool ? "pool" : "single"}
      aria-pressed={pool}
      aria-label={pool ? "Sound mode: pool (click for a single sound)" : "Sound mode: single (click for a pool)"}
      title={pool ? "Pool: several sounds chosen by weight. Click: one sound for this event (the heaviest member)." : "Single: one sound for this event. Click: a pool of sounds chosen by weight, starting with this one."}
      className={cn(
        "flex size-5 items-center justify-center border text-[10px] leading-none",
        pool
          ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
          : "border-border text-foreground-subtlest hover:bg-hover hover:text-foreground",
      )}
      onClick={() => setZaicodeSoundSelectionMode(event.id, pool ? "single" : "pool")}
    >
      {pool ? "N" : "1"}
    </button>
  );
}

const PREVIEW_CHANNEL = "pool-member";

/**
 * The pool's own line, drawn only while the event IS a pool: the picker in its several-choice mode is the one way to add
 * sounds (T-127), the members are listed under it (ZaicodePoolMembers).
 */
export function ZaicodePoolControls({ event, row }: { event: ZaicodeSoundEventDef; row: ZaicodeSoundEventSetting }) {
  if (row.soundMode !== "pool") return null;
  return (
    <ZaicodePoolMembers
      event={event}
      row={row}
      onListen={(sound) => void playZaicodeSoundFile(sound, { preview: true, channel: PREVIEW_CHANNEL, gainDb: row.gainDb })}
      add={
        <ZaicodeSoundPicker
          className="w-64"
          value=""
          onChange={() => undefined}
          previewGainDb={row.gainDb}
          multi={{ members: row.pool.map((entry) => entry.id), label: "Add sounds to the pool…", onToggle: (sound) => toggleZaicodePoolMember(event.id, sound) }}
        />
      }
    />
  );
}
