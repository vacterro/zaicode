import { useEffect, useState } from "react";

/**
 * ZAICODE "where am I" chip (SRC-049): with the sidebar collapsed — a narrow
 * window auto-collapses it — nothing on screen says which project and session
 * this chat belongs to, so landing on "Done" felt like falling into the void.
 * One thin floating line, only while the window is narrow.
 */

const NARROW_PX = 720;

function useWindowNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => (typeof window === "undefined" ? false : window.innerWidth < NARROW_PX));
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW_PX);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return narrow;
}

export function ZaicodeWhereAmI({ workspacePath, sessionTitle }: { workspacePath: string; sessionTitle: string | null }) {
  const narrow = useWindowNarrow();
  if (!narrow) return null;
  const project = workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? workspacePath;
  return (
    <div
      data-zaicode-where-am-i
      title={workspacePath}
      className="pointer-events-none absolute left-2 top-9 z-20 flex max-w-[calc(100%-1rem)] items-center gap-1 truncate px-1 text-[10px] leading-4 text-foreground-subtle"
    >
      <span className="shrink-0 truncate font-medium text-foreground">{project}</span>
      {sessionTitle ? <span className="min-w-0 truncate">· {sessionTitle}</span> : null}
    </div>
  );
}
