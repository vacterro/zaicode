import { TargetIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  useZaicodeAutoGoal,
  zaicodeAutoGoalEnabled,
  ZAICODE_AUTO_GOAL_SUFFIX,
} from "./zaicodeAutoGoal.js";
import {
  describeZaicodeGoalState,
  useZaicodeGoalVersion,
  zaicodeGoalLiveIntent,
} from "./zaicodeGoalSupervisor.js";

/**
 * SRC-138 + T-222: the Auto-Goal switch next to the composer send control. On
 * (the default for every project) every prompt leaves with the goal suffix
 * appended invisibly AND one supervised intent is registered per prompt; off,
 * the operator writes the goal by hand as before. When a live intent exists
 * the tooltip names its truthful state (Goal active / recovering / blocked /
 * ...). Per project, so a long handoff in one workspace does not put a goal
 * into another.
 */
export function ZaicodeAutoGoalButton({ workspaceKey, sessionId }: { workspaceKey: string; sessionId?: string | null }) {
  const enabled = useZaicodeAutoGoal((state) => zaicodeAutoGoalEnabled(state, workspaceKey));
  const toggle = useZaicodeAutoGoal((state) => state.toggle);
  useZaicodeGoalVersion();
  const live = enabled ? zaicodeGoalLiveIntent(workspaceKey, sessionId ?? null) : null;
  const state = describeZaicodeGoalState(enabled, live);
  const title = live
    ? state + " — " + ZAICODE_AUTO_GOAL_SUFFIX + " rides every prompt"
    : enabled
      ? "Auto-Goal on — " + ZAICODE_AUTO_GOAL_SUFFIX + " is appended to every prompt"
      : "Auto-Goal off — write /goal cc all yourself";
  return (
    <ControlHintTooltip title={title}>
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        data-testid="zaicode-auto-goal"
        data-zaicode-auto-goal={enabled ? "on" : "off"}
        data-zaicode-goal-state={live ? live.outcome : "none"}
        aria-label={title}
        aria-pressed={enabled}
        title={title}
        className={cn("cursor-pointer", enabled && "bg-selected text-foreground")}
        onClick={() => toggle(workspaceKey)}
      >
        <TargetIcon className="size-4" />
        <span className="sr-only">{title}</span>
      </Button>
    </ControlHintTooltip>
  );
}
