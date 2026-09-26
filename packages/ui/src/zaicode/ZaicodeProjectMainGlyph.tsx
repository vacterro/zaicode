import type { ZCodeTaskMeta } from "@zcode/shared";
import { ZaicodeInterruptedGlyph } from "./ZaicodeInterruptedGlyph.js";
import { ZaicodeRoleGlyph } from "./ZaicodeRoleGlyph.js";
import { ZAICODE_SESSION_STATE_LABEL, zaicodeSessionStateOf } from "./zaicodeSessionState.js";
import { ZaicodeWorkingIcon } from "./ZaicodeWorkingIcon.js";

/**
 * The project row's leading mark in the "project = MAIN" view (SRC-044): the
 * row is the MAIN session, so it shows MAIN's own state -- the Working icon
 * while it works, INTERRUPTED bars when it was cut off, "?" while it waits for
 * you, the gold MAIN diamond otherwise.
 */
export function ZaicodeProjectMainGlyph({ task, live = false }: { task: ZCodeTaskMeta; live?: boolean }) {
  // `live`: the open chat says MAIN runs right now (SRC-048), even if the list has not caught up.
  const state = live ? "running" : zaicodeSessionStateOf(task);
  const title = `MAIN: ${task.title || task.taskId} · ${ZAICODE_SESSION_STATE_LABEL[state]}`;
  if (state === "running") return <ZaicodeWorkingIcon className="size-4" title={title} />;
  if (state === "interrupted") return <ZaicodeInterruptedGlyph />;
  if (state === "waiting") {
    return (
      <span className="text-ui-xs font-semibold leading-none text-[var(--color-warning)]" title={title}>
        ?
      </span>
    );
  }
  return <ZaicodeRoleGlyph role="MAIN" title={title} />;
}
