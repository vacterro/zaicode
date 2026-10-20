import type { ZaicodeAuditProgress } from "./zaicodeAuditStore.js";

/**
 * T-288 (SRC-201): the "A3 x/y" audit-wave chip on a project row.
 *
 * The chip says how much of the project's A3 campaign is done ("audit waves
 * done of planned"), and it is the operator's to switch off (Settings >
 * Sidebar > A3 audit marks). This component owns the ONE visibility rule, so
 * the row, the setting and the test read the same answer instead of each call
 * site deciding for itself:
 *
 * - nothing when the operator switched the A3 marks off;
 * - nothing when the project has no active campaign;
 * - nothing on a project switched off (Shift+click) -- unless the campaign is
 *   actually running, because a running audit is the one fact a switched-off
 *   project still has to show (SRC-062).
 */
export function ZaicodeAuditProgressChip({
  progress,
  running,
  projectOff,
  showMarks,
}: {
  progress: ZaicodeAuditProgress | null;
  running: boolean;
  projectOff: boolean;
  showMarks: boolean;
}) {
  if (!showMarks || !progress || (!running && projectOff)) return null;
  return (
    <span
      className={
        running
          ? "border border-[#a06a20] bg-[#2b2111] px-0.5 text-[10px] leading-3 text-[#f0c040]"
          : "border border-border px-0.5 text-[10px] leading-3 text-foreground-subtlest"
      }
      title={`${progress.campaigns} A3 campaign(s): ${progress.complete}/${progress.total} audit waves complete or reviewed${running ? " · running now" : " · planned: nothing runs until you press Start in the audit centre"}`}
      data-zaicode-a3-progress={`${progress.complete}/${progress.total}`}
      data-zaicode-a3-running={running ? "1" : "0"}
    >
      A3 {progress.complete}/{progress.total}
    </span>
  );
}
