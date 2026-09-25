import type { ZCodeTaskMeta } from "@zcode/shared";
import { ZaicodeTodoMiniGauge } from "@/v4/ZaicodeTodoGauge.js";
import type { ZaicodeTodoItem } from "./zaicodeTodoProgress.js";
import { ZaicodeRoleGlyph } from "./ZaicodeRoleGlyph.js";
import { ZAICODE_ROLE_META, useZaicodeSessionRole } from "./zaicodeSessionRoles.js";
import { useZaicodeMainSessionId, zaicodeMainSessionKey } from "./zaicodeMainSession.js";

const EMPTY_TODO_ITEMS: readonly ZaicodeTodoItem[] = [];

/**
 * Group view mixes sessions of every project, so each row carries what the
 * project view shows through nesting: a project stripe on the left (one
 * stable color per project, same project = same color everywhere), the
 * todo progress cells under the title, and the MAIN / helper role glyph.
 */
const PROJECT_HUES = ["#c9a227", "#58a6d8", "#7fc35a", "#d9774b", "#a78bda", "#4fc0b5", "#e0665a", "#b8b09a", "#e0884a", "#6aa5e8"];

export function zaicodeProjectColor(workspacePath: string): string {
  let hash = 0;
  const key = workspacePath.replace(/[\\/]+$/, "").toLowerCase();
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) | 0;
  return PROJECT_HUES[Math.abs(hash) % PROJECT_HUES.length]!;
}

function projectName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/")) + 1);
}

/** Absolute layer: stripe + todo cells. Place inside a `relative` row. */
export function ZaicodeGroupedRowDecor({
  task,
  todos,
}: {
  task: ZCodeTaskMeta;
  todos?: readonly ZaicodeTodoItem[] | undefined;
}) {
  const color = zaicodeProjectColor(task.workspacePath);
  return (
    <>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-1 left-0.5 w-[3px]"
        style={{ background: color }}
        title={projectName(task.workspacePath)}
        data-zaicode-project-stripe=""
      />
      <span
        className="pointer-events-none absolute bottom-0 left-2.5"
        style={{ width: "var(--zaicode-list-label-width, 112px)", maxWidth: "calc(100% - 20px)" }}
      >
        <ZaicodeTodoMiniGauge sessionId={task.taskId} {...(todos ? { liveItems: todos ?? EMPTY_TODO_ITEMS } : {})} />
      </span>
    </>
  );
}

/** Role glyph before the title: gold diamond = MAIN, colored helper glyph, hollow = side session. */
export function ZaicodeGroupedRowRole({ task }: { task: ZCodeTaskMeta }) {
  const mainId = useZaicodeMainSessionId(zaicodeMainSessionKey(task.workspacePath, task.workspaceIdentity));
  const role = useZaicodeSessionRole(task.taskId, task.title || "");
  const project = projectName(task.workspacePath);
  if (mainId === task.taskId) {
    return <ZaicodeRoleGlyph role="MAIN" title={`MAIN session of ${project}`} />;
  }
  return (
    <ZaicodeRoleGlyph
      role={role ?? "SIDE"}
      title={role ? `${ZAICODE_ROLE_META[role].title} in ${project}` : `Side session in ${project}`}
    />
  );
}
