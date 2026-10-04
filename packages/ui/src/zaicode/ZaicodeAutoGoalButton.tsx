import { TargetIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  useZaicodeAutoGoal,
  zaicodeAutoGoalEnabled,
  ZAICODE_AUTO_GOAL_SUFFIX,
} from "./zaicodeAutoGoal.js";

/**
 * SRC-138: the Auto-Goal switch next to the composer send control. On (the default for
 * every project) it is highlighted and every prompt leaves with "/goal cc all" appended
 * invisibly; off it is plain and the operator writes the goal by hand as before.
 * Per project, so a long handoff in one workspace does not put a goal into another.
 */
export function ZaicodeAutoGoalButton({ workspaceKey }: { workspaceKey: string }) {
  const enabled = useZaicodeAutoGoal((state) => zaicodeAutoGoalEnabled(state, workspaceKey));
  const toggle = useZaicodeAutoGoal((state) => state.toggle);
  const title = enabled
    ? `Auto-Goal on — ${ZAICODE_AUTO_GOAL_SUFFIX} is appended to every prompt`
    : "Auto-Goal off — write /goal cc all yourself";
  return (
    <ControlHintTooltip title={title}>
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        data-testid="zaicode-auto-goal"
        data-zaicode-auto-goal={enabled ? "on" : "off"}
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