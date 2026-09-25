import { cn } from "@/components/lib/utils.js";
import { ZAICODE_INTERRUPTED_HINT } from "./zaicodeSessionState.js";

/** ZAICODE (SRC-044): the mark of a session cut off mid-turn -- two amber bars, never the DONE dot. */
export function ZaicodeInterruptedGlyph({ className }: { className?: string }) {
  return (
    <span
      className={cn("flex size-4 shrink-0 items-center justify-center gap-[2px]", className)}
      title={ZAICODE_INTERRUPTED_HINT}
      aria-label="Interrupted"
      data-zaicode-interrupted=""
    >
      <span className="h-2 w-[2px] bg-[#e0a03c]" />
      <span className="h-2 w-[2px] bg-[#e0a03c]" />
    </span>
  );
}
