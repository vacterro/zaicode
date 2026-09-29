import { useState } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  setZaicodeSoundEvent,
  zaicodeSetPoolWeight,
  type ZaicodeSoundEventDef,
  type ZaicodeSoundEventSetting,
} from "@/zaicode/zaicodeSoundSettingsModel.js";
import { normalizeZaicodePool } from "@/zaicode/zaicodeSoundPools.js";

/**
 * Single or Pool, per event (Wave 3, part B), in the row itself: one small cell that says
 * "1" (one sound) or "N" (a weighted pool) and flips on click. It used to be a whole extra
 * line under EVERY event holding two buttons; with a hundred events that was a hundred
 * empty-looking lines (SRC-087).
 */
export function ZaicodePoolModeButton({ event, row }: { event: ZaicodeSoundEventDef; row: ZaicodeSoundEventSetting }) {
  const pool = row.soundMode === "pool";
  return (
    <button
      type="button"
      data-zaicode-pool-mode={pool ? "pool" : "single"}
      aria-pressed={pool}
      aria-label={pool ? "Sound mode: pool (click for a single sound)" : "Sound mode: single (click for a pool)"}
      title={pool ? "Pool: several sounds chosen by weight. Click: one sound for this event." : "Single: one sound for this event. Click: several sounds chosen by weight (a pool)."}
      className={cn(
        "flex size-5 items-center justify-center border text-[10px] leading-none",
        pool
          ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
          : "border-border text-foreground-subtlest hover:bg-hover hover:text-foreground",
      )}
      onClick={() => setZaicodeSoundEvent(event.id, { soundMode: pool ? "single" : "pool" })}
    >
      {pool ? "N" : "1"}
    </button>
  );
}

/**
 * The pool's own controls: add the chosen sound as a member, look at the members. Drawn only
 * while the event IS a pool; a single-sound event takes no line at all. The percentages shown
 * are the EFFECTIVE ones (the same numbers the pick walks), so they always add up to 100% and
 * always describe what will actually play.
 */
export function ZaicodePoolControls({ event, row }: { event: ZaicodeSoundEventDef; row: ZaicodeSoundEventSetting }) {
  const [open, setOpen] = useState(false);
  const plan = normalizeZaicodePool(row.pool);
  if (row.soundMode !== "pool") return null;
  return (
    <div className="col-span-full flex flex-col gap-1 pl-6" data-zaicode-pool={event.id}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover"
          title="Add the sound chosen above as a pool member"
          onClick={() =>
            setZaicodeSoundEvent(event.id, {
              pool: [...row.pool.filter((entry) => entry.id !== row.sound), { id: row.sound, weight: 1, locked: false, missing: false }],
            })
          }
        >
          add "{row.sound}"
        </button>
        {row.pool.length > 0 ? (
          <button
            type="button"
            className="text-foreground-subtlest underline"
            onClick={() => setOpen((value) => !value)}
            title="Show every member, its weight and the share it will actually get"
          >
            {open ? "hide" : "show"} {row.pool.length} member(s) · {plan.selectable} usable
          </button>
        ) : null}
      </div>
      {row.pool.length > 0 ? (
        <>
          {open ? (
            <div className="flex flex-col gap-1 border border-border/60 p-1">
              {plan.shares.map((share) => {
                const entry = row.pool.find((candidate) => candidate.id === share.id)!;
                return (
                  <div key={share.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate" title={share.id}>
                      {share.id}
                      {share.missing ? <span className="ml-1 text-foreground-subtlest">(file not found)</span> : null}
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      value={entry.weight}
                      aria-label={`Weight of ${share.id}`}
                      className="w-16 border border-border bg-background px-1 text-foreground"
                      onChange={(change) => zaicodeSetPoolWeight(event.id, share.id, Number(change.target.value))}
                    />
                    <span className="w-16 text-right tabular-nums text-foreground-subtle">{share.percent.toFixed(2)}%</span>
                    <button
                      type="button"
                      className="border border-border px-1 text-foreground-subtlest hover:bg-hover"
                      title="Keep this share fixed when another member's weight changes"
                      onClick={() =>
                        setZaicodeSoundEvent(event.id, {
                          pool: row.pool.map((candidate) => (candidate.id === share.id ? { ...candidate, locked: !candidate.locked } : candidate)),
                        })
                      }
                    >
                      {entry.locked ? "pinned" : "pin"}
                    </button>
                    <button
                      type="button"
                      className="border border-border px-1 text-foreground-subtlest hover:bg-hover"
                      title="Remove this member"
                      onClick={() => setZaicodeSoundEvent(event.id, { pool: row.pool.filter((candidate) => candidate.id !== share.id) })}
                    >
                      remove
                    </button>
                  </div>
                );
              })}
              <p className="text-foreground-subtlest">
                Weights are relative; the percentages are what plays, and they always add up to 100%.
              </p>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
