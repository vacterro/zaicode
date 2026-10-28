import { FlaskConical } from "lucide-react";
import { withZaicodeHighlight } from "./zaicodeHighlights.js";
import { useZaicodeModelHighlight } from "./useZaicodeModelHighlight.js";

export function ZaicodeTestsIndicator({ count, commands = [], project = false }: { count: number; commands?: readonly string[]; project?: boolean }) {
  const light = useZaicodeModelHighlight(project ? "projectTests" : "sessionTests", count > 0);
  if (!count) return null;
  const label = `${count} test command${count === 1 ? "" : "s"} running`;
  return <span {...withZaicodeHighlight({ className: "inline-flex shrink-0 items-center gap-0.5 text-ui-xs text-foreground-subtle", title: [label, ...commands].join("\n") }, light)} aria-label={label} data-zaicode-tests={project ? "project" : "session"}>
    <FlaskConical className="size-3.5" aria-hidden="true" />TEST{count > 1 ? ` ${count}` : ""}
  </span>;
}
