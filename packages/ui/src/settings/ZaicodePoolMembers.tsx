import { Play } from "lucide-react";
import type { ReactNode } from "react";
import { formatZaicodeSoundLength, isZaicodeCustomizationSoundId, zaicodeSoundDisplayName, zaicodeSoundEntry } from "@/zaicode/zaicodeSoundCatalog.js";
import { useZaicodeCustomSounds } from "@/zaicode/zaicodeCustomSounds.js";
import { removeZaicodePoolMember, toggleZaicodePoolPin } from "@/zaicode/zaicodeSoundPoolActions.js";
import { zaicodeSetPoolWeight, type ZaicodeSoundEventDef, type ZaicodeSoundEventSetting } from "@/zaicode/zaicodeSoundSettingsModel.js";
import { normalizeZaicodePool } from "@/zaicode/zaicodeSoundPools.js";

/**
 * The pool's line, without any audio in it (T-127): the members, their weights and shares, and the way to add. It takes the
 * adding control and the "listen" action from ZaicodeSoundPoolControls, so this part renders (and is tested) on its own.
 */

/** In a pool the row's own sound cell is not "the sound": it says how many there are, and the line below is where they are chosen. */
export function ZaicodePoolSummary({ row }: { row: ZaicodeSoundEventSetting }) {
  const count = row.pool.length;
  return (
    <div
      data-zaicode-pool-summary
      className="flex min-w-0 items-center gap-1 border border-dashed border-border px-1 py-0.5 text-ui-xs text-foreground-subtle"
      title="This event plays one sound out of a pool. Add and remove them in the line below."
    >
      <span className="min-w-0 flex-1 truncate">{count === 0 ? "Pool: empty" : count === 1 ? "Pool: 1 sound" : `Pool: ${count} sounds`}</span>
    </div>
  );
}

/**
 * One control adds sounds (`add`, the picker in its several-choice mode: each pick is a member, the list stays open), and the
 * members are always listed under it -- name, length, a way to hear it, weight, the share it really gets, remove. The
 * percentages are the EFFECTIVE ones (the same numbers the pick walks), so they always add up to 100% and describe what will
 * play. Pinning a share only means something with two or more members, so the button appears then (or while a member is
 * pinned, so it can be let go).
 */
export function ZaicodePoolMembers({
  event,
  row,
  add,
  onListen,
}: {
  event: ZaicodeSoundEventDef;
  row: ZaicodeSoundEventSetting;
  add: ReactNode;
  onListen: (soundId: string) => void;
}) {
  const folder = useZaicodeCustomSounds();
  const plan = normalizeZaicodePool(row.pool);
  const many = row.pool.length > 1;
  const gone = (id: string, flagged: boolean) => flagged || (folder.available && folder.loaded && isZaicodeCustomizationSoundId(id) && !zaicodeSoundEntry(id));
  return (
    <div className="col-span-full flex flex-col gap-1 pl-6" data-zaicode-pool={event.id}>
      <div className="flex flex-wrap items-center gap-2">
        {add}
        <span className="text-foreground-subtle" data-zaicode-pool-count>
          {row.pool.length === 0
            ? "Empty: this event plays its own sound until you add some."
            : row.pool.length === 1
              ? "1 sound. Add another: one of them plays each time, by weight."
              : `${row.pool.length} sounds${plan.selectable < row.pool.length ? ` · ${plan.selectable} can play` : ""}. One plays each time, by weight.`}
        </span>
      </div>
      {row.pool.length > 0 ? (
        <div className="flex flex-col gap-1 border border-border/60 p-1" data-zaicode-pool-members>
          {plan.shares.map((share) => {
            const entry = row.pool.find((candidate) => candidate.id === share.id)!;
            const info = zaicodeSoundEntry(share.id);
            const notFound = gone(share.id, share.missing);
            return (
              <div key={share.id} className="flex items-center gap-2" data-zaicode-pool-member={share.id}>
                <button
                  type="button"
                  className="flex size-5 shrink-0 items-center justify-center border border-border text-foreground-subtle hover:bg-hover hover:text-foreground"
                  title="Listen to this member"
                  aria-label={`Listen to ${zaicodeSoundDisplayName(share.id)}`}
                  onClick={() => onListen(share.id)}
                >
                  <Play className="size-3" />
                </button>
                <span className="min-w-0 flex-1 truncate" title={share.id}>
                  {zaicodeSoundDisplayName(share.id)}
                  {notFound ? <span className="ml-1 text-foreground-subtlest">(file not found)</span> : null}
                </span>
                {info ? <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-foreground-subtlest">{formatZaicodeSoundLength(info.seconds)}</span> : null}
                <input
                  type="number"
                  min={0}
                  max={1000}
                  value={entry.weight}
                  aria-label={`Weight of ${zaicodeSoundDisplayName(share.id)}`}
                  className="w-16 border border-border bg-background px-1 text-foreground"
                  onChange={(change) => zaicodeSetPoolWeight(event.id, share.id, Number(change.target.value))}
                />
                <span className="w-16 text-right tabular-nums text-foreground-subtle">{share.percent.toFixed(2)}%</span>
                {many || entry.locked ? (
                  <button
                    type="button"
                    className="border border-border px-1 text-foreground-subtlest hover:bg-hover"
                    title="Keep this share fixed when another member's weight changes"
                    onClick={() => toggleZaicodePoolPin(event.id, share.id)}
                  >
                    {entry.locked ? "pinned" : "pin"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="border border-border px-1 text-foreground-subtlest hover:bg-hover"
                  title="Take this sound out of the pool"
                  onClick={() => removeZaicodePoolMember(event.id, share.id)}
                >
                  remove
                </button>
              </div>
            );
          })}
          {many ? <p className="text-foreground-subtlest">Weights are relative; the percentages are what plays, and they always add up to 100%.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
