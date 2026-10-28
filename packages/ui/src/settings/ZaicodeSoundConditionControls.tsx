import { cn } from "@/components/lib/utils.js";
import {
  ZAICODE_SOUND_COOLDOWN_MAX,
  ZAICODE_SOUND_WHENS,
  describeZaicodeSoundConditions,
  normalizeZaicodeSoundWhen,
  type ZaicodeSoundWhen,
} from "@/zaicode/zaicodeSoundConditions.js";
import { setZaicodeSoundEvent, type ZaicodeSoundEventDef, type ZaicodeSoundEventSetting } from "@/zaicode/zaicodeSoundSettingsModel.js";

/**
 * T-134: the "When" cell of a Sounds-table row and the sub-row it unfolds.
 * The cell shows the row's own conditions in two letters (bg = only in the
 * background, fg = only in front, !q = through quiet hours, 30s = cooldown);
 * a dot means "the master rules only".
 */

const WHEN_LABELS: Record<ZaicodeSoundWhen, { label: string; hint: string }> = {
  always: { label: "Always", hint: "Follows the master rules (Settings above: also while focused, quiet hours)" },
  background: { label: "Only in the background", hint: "Plays only while another window has the focus: news from ZAICODE while you work elsewhere" },
  foreground: { label: "Only in front", hint: "Plays only while ZAICODE has the focus, even when the master switch keeps the others quiet there" },
};

const COOLDOWN_CHOICES = [0, 5, 15, 30, 60, 300, 900, 3600] as const;

function cooldownLabel(seconds: number): string {
  if (seconds === 0) return "no limit";
  if (seconds < 60) return `once per ${seconds} s`;
  if (seconds < 3600) return `once per ${seconds / 60} min`;
  return "once per hour";
}

export function ZaicodeSoundConditionButton({
  event,
  row,
  open,
  onToggle,
}: {
  event: ZaicodeSoundEventDef;
  row: ZaicodeSoundEventSetting;
  open: boolean;
  onToggle: () => void;
}) {
  const summary = describeZaicodeSoundConditions(row);
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`When ${event.label} plays`}
      title={summary ? `Own conditions: ${summary}. Click to change.` : "When this sound plays: always (the master rules). Click for its own conditions."}
      data-zaicode-sound-when={event.id}
      className={cn(
        "h-5 min-w-0 truncate border px-0.5 text-[10px]",
        summary
          ? "border-[var(--zaicode-highlight,var(--color-border-hover))] text-foreground"
          : "border-border text-foreground-subtlest hover:text-foreground",
        open && "bg-selected",
      )}
      onClick={onToggle}
    >
      {summary || "·"}
    </button>
  );
}

export function ZaicodeSoundConditionRow({ event, row }: { event: ZaicodeSoundEventDef; row: ZaicodeSoundEventSetting }) {
  const when = normalizeZaicodeSoundWhen(row.when);
  const cooldown = row.cooldownSec ?? 0;
  const choices = COOLDOWN_CHOICES.includes(cooldown as (typeof COOLDOWN_CHOICES)[number])
    ? COOLDOWN_CHOICES
    : [...COOLDOWN_CHOICES, cooldown].sort((left, right) => left - right);
  return (
    <div className="col-span-full flex flex-wrap items-center gap-x-3 gap-y-1 pb-1 pl-6 text-foreground-subtle" data-zaicode-sound-conditions={event.id}>
      <span className="text-foreground-subtlest">When "{event.label}" plays:</span>
      <div className="flex gap-px" role="radiogroup" aria-label="When">
        {ZAICODE_SOUND_WHENS.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={when === value}
            title={WHEN_LABELS[value].hint}
            className={cn(
              "border px-1 text-[10px]",
              when === value
                ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                : "border-border text-foreground-subtlest hover:text-foreground",
            )}
            onClick={() => setZaicodeSoundEvent(event.id, { when: value })}
          >
            {WHEN_LABELS[value].label}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1" title="Quiet hours (Notifications) keep every sound silent; this one still plays">
        <input
          type="checkbox"
          checked={row.throughQuiet === true}
          onChange={(change) => setZaicodeSoundEvent(event.id, { throughQuiet: change.target.checked })}
        />
        also in quiet hours
      </label>
      <label className="flex items-center gap-1" title="A sound that would ring again sooner stays silent">
        at most
        <select
          className="border border-border bg-background px-0.5 text-foreground"
          value={cooldown}
          onChange={(change) => setZaicodeSoundEvent(event.id, { cooldownSec: Math.min(ZAICODE_SOUND_COOLDOWN_MAX, Number(change.target.value)) })}
        >
          {choices.map((seconds) => (
            <option key={seconds} value={seconds}>
              {cooldownLabel(seconds)}
            </option>
          ))}
        </select>
      </label>
      {describeZaicodeSoundConditions(row) ? (
        <button
          type="button"
          className="border border-border px-1 text-[10px] text-foreground-subtlest hover:text-foreground"
          title="Back to the master rules"
          onClick={() => setZaicodeSoundEvent(event.id, { when: "always", throughQuiet: false, cooldownSec: 0 })}
        >
          reset
        </button>
      ) : null}
    </div>
  );
}
