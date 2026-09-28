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
 * Single or Pool, per event (Wave 3, part B). The percentages shown are the
 * EFFECTIVE ones — the same numbers the pick walks — so they always add up to
 * 100% and always describe what will actually play.
 */
export function ZaicodePoolControls({ event, row }: { event: ZaicodeSoundEventDef; row: ZaicodeSoundEventSetting }) {
  const [open, setOpen] = useState(false);
  const plan = normalizeZaicodePool(row.pool);
  return (
    <div className="col-span-full flex flex-col gap-1 pl-6" data-zaicode-pool={event.id}>
      <div className="flex items-center gap-2">
        {(["single", "pool"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            title={mode === "single" ? "One sound for this event" : "Several sounds, chosen by weight"}
            className={cn(
              "border px-1.5 py-px text-[10px]",
              row.soundMode === mode
                ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                : "border-border text-foreground-subtlest hover:text-foreground",
            )}
            onClick={() => setZaicodeSoundEvent(event.id, { soundMode: mode })}
          >
            {mode === "single" ? "single" : "pool"}
          </button>
        ))}
        {row.soundMode === "pool" ? (
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
        ) : null}
      </div>
      {row.soundMode === "pool" && row.pool.length > 0 ? (
        <>
          <button
            type="button"
            className="self-start text-foreground-subtlest underline"
            onClick={() => setOpen((value) => !value)}
            title="Show every member, its weight and the share it will actually get"
          >
            {open ? "hide" : "show"} {row.pool.length} member(s) · {plan.selectable} usable
          </button>
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
