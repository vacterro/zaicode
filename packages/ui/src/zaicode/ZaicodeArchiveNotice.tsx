import { useEffect } from "react";
import { useZaicodeArchiveUndo } from "./zaicodeArchiveUndo.js";

/** The existing archive owner; feedback occupies one bounded workspace row. */
export function ZaicodeArchiveNotice() {
  const notice = useZaicodeArchiveUndo((state) => state.notice);
  const undoable = useZaicodeArchiveUndo((state) => state.noticeUndoable);
  const undo = useZaicodeArchiveUndo((state) => state.undo);
  const clear = useZaicodeArchiveUndo((state) => state.clearNotice);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(clear, 8000);
    return () => window.clearTimeout(timer);
  }, [clear, notice]);
  if (!notice) return null;
  return (
    // 清理提示曾把完整会话标题塞入侧栏，长文本挤走项目列表。工作区独占一行并截断，Undo 保留。
    // z-9999 > toast host 的 z-9998：右上角的通知卡会压住这一行的 Undo，让 8 秒内点不到撤销。
    <div role="status" className="relative z-[9999] flex h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-card px-2 text-ui-xs text-foreground-subtle" data-zaicode-archive-notice>
      <span className="min-w-0 flex-1 truncate" title={notice}>{notice}</span>
      {undoable ? <button type="button" aria-label="Undo archive" className="shrink-0 border border-border px-2 hover:bg-hover" onClick={() => void undo()}>Undo</button> : null}
      <button type="button" aria-label="Dismiss archive notice" className="shrink-0 px-1 hover:bg-hover" onClick={clear}>×</button>
    </div>
  );
}
