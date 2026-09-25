import { useEffect, useRef, useState } from "react";
import { ZAICODE_HIT_AND_GO_PROMPT, type ZaicodeAutostartJob, type ZaicodeScheduleBeforeRun, type ZaicodeScheduleOrder } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Switch } from "@/components/ui/switch.js";
import { useZaicodeSchedulerMarks } from "./zaicodeSchedulerMarks.js";

/**
 * Two parts of a schedule row (SRC-044 / SRC-046):
 * - the prompt as a growing text box without a length cap (whole audits fit;
 *   a long prompt reaches a CLI worker as a file, see buildZaicodeWorkerCommand);
 * - its conditions: what to clear out first, idle-only, project order, and
 *   "only the sessions I marked".
 */

const PROMPT_MIN_ROWS = 2;
const PROMPT_MAX_HEIGHT = "40vh";

export function ZaicodeSchedulePrompt({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(value), [value]);
  // Grows with the text up to 40% of the window, then scrolls.
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight + 2}px`;
  }, [draft]);
  return (
    <div className="flex flex-col gap-0.5">
      <textarea
        ref={ref}
        rows={PROMPT_MIN_ROWS}
        className="w-full resize-y border border-border bg-background px-1 py-0.5 text-foreground"
        style={{ maxHeight: PROMPT_MAX_HEIGHT }}
        placeholder={`Prompt — empty = ${ZAICODE_HIT_AND_GO_PROMPT}. Any length: paste a whole audit.`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) onChange(draft);
        }}
        data-zaicode-schedule-prompt=""
      />
      {draft.length > 500 ? (
        <span className="text-right text-foreground-subtlest tabular-nums">{draft.length.toLocaleString()} characters</span>
      ) : null}
    </div>
  );
}

function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string; title: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-px">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          className={cn(
            "border px-1.5 py-0.5",
            option.value === value
              ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
              : "border-border text-foreground-subtle hover:bg-hover hover:text-foreground",
          )}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const BEFORE: readonly { value: ZaicodeScheduleBeforeRun; label: string; title: string }[] = [
  { value: "none", label: "nothing", title: "Start next to whatever already runs" },
  {
    value: "stopWeaker",
    label: "stop the stopgap",
    title: "Stop sessions on the free pool (SAIFREN) and workers of a weaker engine in these projects first -- e.g. before a subscription takes over /goal cc all",
  },
  { value: "stopAll", label: "stop everything", title: "Stop every running session and worker in these projects first" },
];

const ORDER: readonly { value: ZaicodeScheduleOrder; label: string; title: string }[] = [
  { value: "problems", label: "most open work first", title: "Projects with the most blocked, then open SAIPEN tickets go first" },
  { value: "list", label: "sidebar order", title: "In the order the sidebar lists them" },
];

export function ZaicodeScheduleConditions({
  job,
  inApp,
  onChange,
}: {
  job: ZaicodeAutostartJob;
  /** START / an in-app model / an agent (not a subscription CLI). */
  inApp: boolean;
  onChange: (patch: Partial<ZaicodeAutostartJob>) => void;
}) {
  const marked = useZaicodeSchedulerMarks((state) => Object.keys(state.marks).length);
  return (
    <div className="flex flex-wrap items-center gap-2 text-foreground-subtle" data-zaicode-schedule-conditions="">
      <span title="Conditions: what happens in the target projects before this schedule starts">Before</span>
      <Choice value={job.beforeRun} options={BEFORE} onChange={(beforeRun) => onChange({ beforeRun })} />
      <label className="flex items-center gap-1" title="Skip a project where a session or worker still runs (after the step before)">
        <Switch checked={job.onlyWhenIdle} onCheckedChange={(onlyWhenIdle) => onChange({ onlyWhenIdle })} />
        only when idle
      </label>
      {job.targetKind === "section" ? (
        <>
          <span>Order</span>
          <Choice value={job.order} options={ORDER} onChange={(order) => onChange({ order })} />
        </>
      ) : null}
      {inApp ? (
        <label
          className="flex items-center gap-1"
          title="Continue only the sessions you marked (right-click a session → Mark for the SCHEDULER); nothing new is started"
        >
          <Switch checked={job.onlyMarked} onCheckedChange={(onlyMarked) => onChange({ onlyMarked })} />
          only marked sessions ({marked})
        </label>
      ) : null}
    </div>
  );
}
