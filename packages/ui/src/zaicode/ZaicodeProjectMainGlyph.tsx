import type { ZCodeTaskMeta } from "@zcode/shared";
import { ZaicodeInterruptedGlyph } from "./ZaicodeInterruptedGlyph.js";
import { useZaicodeDiamondColor, zaicodeDiamondLabel } from "./zaicodeDiamondColors.js";
import { ZaicodeRoleGlyph } from "./ZaicodeRoleGlyph.js";
import { ZAICODE_SESSION_STATE_LABEL, zaicodeSessionStateOf } from "./zaicodeSessionState.js";
import { ZaicodeWorkingIcon } from "./ZaicodeWorkingIcon.js";

/**
 * The project row's leading mark in the "project = MAIN" view (SRC-044): the
 * row is the MAIN session, so it shows MAIN's own state -- the Working icon
 * while it works, INTERRUPTED bars when it was cut off, "?" while it waits for
 * you, the unseen dot while it just finished out of sight (SRC-131), the MAIN
 * diamond (in its model's colour) otherwise.
 */
export function ZaicodeProjectMainGlyph({ task, live = false }: { task: ZCodeTaskMeta; live?: boolean }) {
  // `live`: the open chat says MAIN runs right now (SRC-048), even if the list has not caught up.
  const state = live ? "running" : zaicodeSessionStateOf(task);
  const title = `MAIN: ${task.title || task.taskId} · ${ZAICODE_SESSION_STATE_LABEL[state]}`;
  if (state === "running") return <ZaicodeWorkingIcon model={task.model} className="size-4" title={title} />;
  if (state === "interrupted") return <ZaicodeInterruptedGlyph />;
  if (state === "waiting") {
    return (
      <span className="text-ui-xs font-semibold leading-none text-[var(--color-warning)]" title={title}>
        ?
      </span>
    );
  }
  // "Just finished" has to look different from "idle since Tuesday", or the two
  // read as one state (SRC-131). The dot is the row's own mark; opening the
  // project clears unreadAt and the plain MAIN diamond comes back.
  if (state === "done") return <ZaicodeUnseenDoneDot title={`${title} · unseen`} />;
  return <ZaicodeProjectMainDiamond task={task} title={title} />;
}

/** A finished run nobody has looked at yet — the task list's own unread dot (SRC-131). */
function ZaicodeUnseenDoneDot({ title }: { title: string }) {
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      data-unread-indicator="true"
      className="h-1.5 w-1.5 rounded-full bg-sky-500 dark:bg-sky-400"
    />
  );
}

/** The idle MAIN diamond in the colour of MAIN's model (SRC-049: SAIFREN yellow, SAIOPP orange). */
function ZaicodeProjectMainDiamond({ task, title }: { task: ZCodeTaskMeta; title: string }) {
  const color = useZaicodeDiamondColor(task.model);
  return (
    <ZaicodeRoleGlyph
      role="MAIN"
      {...(color ? { color } : {})}
      title={color ? `${title} · ${zaicodeDiamondLabel(task.model)}` : title}
    />
  );
}
