import type { ZaicodeJob } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import {
  readinessBarColor,
  todoReadinessRatio,
  useZaicodeTodoProgress,
} from "@/zaicode/zaicodeTodoProgress.js";

/**
 * Battlezone F-group readiness strip: one small rectangle per running worker,
 * tinted black -> red -> amber -> green by that worker's todo completion, plus
 * the live "how many are running right now" count. Workers with no todo yet
 * read dark (just started); a nearly finished one reads green.
 */
export function ZaicodeWorkingMeter({ jobs }: { jobs: readonly ZaicodeJob[] }) {
  const bySession = useZaicodeTodoProgress((state) => state.bySession);
  const running = jobs.filter((job) => job.status === "running" || job.status === "waiting");
  const count = running.length;
  const readiness = running.map((job) => {
    const items = job.sessionId ? bySession[job.sessionId] : undefined;
    return { id: job.id, ratio: todoReadinessRatio(items) };
  });

  return (
    <span
      className="flex shrink-0 items-center gap-1 tabular-nums"
      data-zaicode-working-meter={count}
      title={
        count === 0
          ? "No workers running"
          : `${count} working · ${readiness.map((r) => `${Math.round(r.ratio * 100)}%`).join(", ")}`
      }
      aria-label={`${count} workers running`}
    >
      {readiness.map((worker) => (
        <span
          key={worker.id}
          className="h-3.5 w-2 border border-border"
          style={{ background: readinessBarColor(worker.ratio) }}
        />
      ))}
      <span
        className={cn(
          "text-ui-xs",
          count > 0 ? "text-foreground" : "text-foreground-subtlest",
        )}
      >
        {count}
      </span>
    </span>
  );
}
