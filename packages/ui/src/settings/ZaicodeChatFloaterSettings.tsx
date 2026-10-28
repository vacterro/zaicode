import { useState } from "react";
import { PencilIcon } from "lucide-react";
import { ZaicodePrefCheck, ZaicodePrefSegment, ZaicodePrefStepper } from "@/zaicode/ZaicodePrefControls.js";
import { useZaicodeChatChangeFloater } from "@/zaicode/useZaicodeChatChangeFloater.js";
import {
  ZAICODE_FLOATER_LIMITS,
  ZAICODE_FLOATER_STYLES,
  useZaicodeChangeFloaters,
  type ZaicodeChatFloaterStyle,
} from "@/zaicode/zaicodeChangeFloaters.js";

/**
 * Settings -> Highlights & motion -> Change numbers in the chat (SRC-062):
 * the agent's Edit rows play their own +N / -N as files change. Every
 * condition and every timing is the operator's, with demo rows to try them.
 */

const CHAT_STYLES: readonly { value: ZaicodeChatFloaterStyle; label: string; hint?: string }[] = [
  { value: "same", label: "Same", hint: "The counter's style above" },
  ...ZAICODE_FLOATER_STYLES.map((style) => ({ value: style.id, label: style.label, hint: style.hint })),
];

function DemoEditRow({ id, file, counts }: { id: string; file: string; counts: { added: number; removed: number } }) {
  const ref = useZaicodeChatChangeFloater(id, counts, { running: true });
  return (
    <div className="flex items-center gap-1.5 border border-border/60 px-2 py-0.5">
      <PencilIcon className="size-3.5 text-foreground-subtle" />
      <span className="text-foreground-subtle">Edit</span>
      <span className="text-foreground">{file}</span>
      <span ref={ref} className="ml-auto inline-flex gap-1 font-mono tabular-nums">
        {counts.added > 0 ? <span className="text-diff-added">+{counts.added}</span> : null}
        {counts.removed > 0 ? <span className="text-diff-removed">-{counts.removed}</span> : null}
      </span>
    </div>
  );
}

const DEMO_FILES = ["WintageInstaller.ps1", "sidebar.tsx", "README.md"] as const;

export function ZaicodeChatFloaterSettings() {
  const prefs = useZaicodeChangeFloaters();
  const [demo, setDemo] = useState(() => DEMO_FILES.map(() => ({ added: 0, removed: 0 })));
  const off = !prefs.enabled || !prefs.chatEnabled;
  const bump = (rows: readonly number[], added: number, removed: number) =>
    setDemo((current) =>
      current.map((row, index) => (rows.includes(index) ? { added: row.added + added, removed: row.removed + removed } : row)),
    );
  return (
    <section
      className="flex flex-col gap-2 border border-border bg-card p-4 text-ui-xs"
      data-zaicode-chat-floater-settings
      data-zaicode-help="changes"
    >
      <div>
        <h2 className="text-ui-lg text-foreground">Change numbers in the chat</h2>
        <p className="mt-1 max-w-[620px] text-foreground-subtle">
          When the agent edits a file, its Edit row in the chat plays the same +N / -N right where it
          shows the change. Old chats and rows scrolled back into view stay quiet; only an edit that
          is happening now plays. Several edits at once play one after another.
        </p>
      </div>

      <div className="flex max-w-[720px] flex-col gap-1 border border-border/60 p-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground-subtle">Try it:</span>
          {(
            [
              ["Agent edits a file", [0], 12, 3],
              ["Only adds", [1], 40, 0],
              ["Only removes", [2], 0, 9],
              ["Three at once", [0, 1, 2], 5, 2],
              ["Big rewrite", [0], Math.max(prefs.critAt, 1), 60],
            ] as const
          ).map(([label, rows, added, removed]) => (
            <button
              key={label}
              type="button"
              className="border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover hover:text-foreground"
              onClick={() => bump(rows, added, removed)}
            >
              {label}
            </button>
          ))}
        </div>
        {DEMO_FILES.map((file, index) => (
          <DemoEditRow key={file} id={`settings-chat-demo-${file}`} file={file} counts={demo[index]!} />
        ))}
      </div>

      <div className="grid max-w-[720px] grid-cols-1 gap-x-6 gap-y-1.5 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <ZaicodePrefCheck
            checked={prefs.chatEnabled}
            disabled={!prefs.enabled}
            onChange={(chatEnabled) => prefs.update({ chatEnabled })}
            label="Play numbers on the agent's Edit rows"
          />
          <ZaicodePrefCheck
            checked={prefs.chatOnlyVisible}
            disabled={off}
            onChange={(chatOnlyVisible) => prefs.update({ chatOnlyVisible })}
            label="Only when the row is on screen"
          />
          <ZaicodePrefCheck
            checked={prefs.chatOnlyFocused}
            disabled={off}
            onChange={(chatOnlyFocused) => prefs.update({ chatOnlyFocused })}
            label="Only while ZAICODE has focus"
          />
          <ZaicodePrefCheck
            checked={prefs.chatFlashRow}
            disabled={off}
            onChange={(chatFlashRow) => prefs.update({ chatFlashRow })}
            label="The row's +N -M flashes"
          />
          <ZaicodePrefCheck
            checked={prefs.chatSound}
            disabled={off}
            onChange={(chatSound) => prefs.update({ chatSound })}
            label="Sound (the same Lines added / Lines removed rows)"
          />
          <ZaicodePrefSegment
            label="Style"
            value={prefs.chatStyle}
            options={CHAT_STYLES}
            disabled={off}
            onChange={(chatStyle) => prefs.update({ chatStyle })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <ZaicodePrefStepper
            label="Smallest change that plays (lines)"
            value={prefs.chatMinLines}
            min={ZAICODE_FLOATER_LIMITS.chatMinLines[0]}
            max={ZAICODE_FLOATER_LIMITS.chatMinLines[1]}
            step={1}
            format={(lines) => (lines === 0 ? "any" : String(lines))}
            disabled={off}
            onChange={(chatMinLines) => prefs.update({ chatMinLines })}
          />
          <ZaicodePrefStepper
            label="An edit counts as new for"
            value={prefs.chatFreshSec}
            min={ZAICODE_FLOATER_LIMITS.chatFreshSec[0]}
            max={ZAICODE_FLOATER_LIMITS.chatFreshSec[1]}
            step={5}
            suffix=" s"
            disabled={off}
            onChange={(chatFreshSec) => prefs.update({ chatFreshSec })}
          />
          <ZaicodePrefStepper
            label="Wait before playing"
            value={prefs.chatDelayMs}
            min={ZAICODE_FLOATER_LIMITS.chatDelayMs[0]}
            max={ZAICODE_FLOATER_LIMITS.chatDelayMs[1]}
            step={50}
            format={(ms) => (ms === 0 ? "at once" : `${(ms / 1000).toFixed(2)} s`)}
            disabled={off}
            onChange={(chatDelayMs) => prefs.update({ chatDelayMs })}
          />
          <ZaicodePrefStepper
            label="Between edits"
            value={prefs.chatStaggerMs}
            min={ZAICODE_FLOATER_LIMITS.chatStaggerMs[0]}
            max={ZAICODE_FLOATER_LIMITS.chatStaggerMs[1]}
            step={50}
            format={(ms) => `${(ms / 1000).toFixed(2)} s`}
            disabled={off}
            onChange={(chatStaggerMs) => prefs.update({ chatStaggerMs })}
          />
          <ZaicodePrefStepper
            label="Most edits waiting"
            value={prefs.chatQueueMax}
            min={ZAICODE_FLOATER_LIMITS.chatQueueMax[0]}
            max={ZAICODE_FLOATER_LIMITS.chatQueueMax[1]}
            disabled={off}
            onChange={(chatQueueMax) => prefs.update({ chatQueueMax })}
          />
          <ZaicodePrefStepper
            label="Float distance"
            value={prefs.chatDistancePx}
            min={ZAICODE_FLOATER_LIMITS.chatDistancePx[0]}
            max={ZAICODE_FLOATER_LIMITS.chatDistancePx[1]}
            step={2}
            suffix="px"
            disabled={off}
            onChange={(chatDistancePx) => prefs.update({ chatDistancePx })}
          />
          <ZaicodePrefStepper
            label="How long it stays"
            value={prefs.chatDurationMs}
            min={ZAICODE_FLOATER_LIMITS.chatDurationMs[0]}
            max={ZAICODE_FLOATER_LIMITS.chatDurationMs[1]}
            step={100}
            format={(ms) => `${(ms / 1000).toFixed(1)} s`}
            disabled={off}
            onChange={(chatDurationMs) => prefs.update({ chatDurationMs })}
          />
          <ZaicodePrefStepper
            label="Size"
            value={prefs.chatScalePct}
            min={ZAICODE_FLOATER_LIMITS.chatScalePct[0]}
            max={ZAICODE_FLOATER_LIMITS.chatScalePct[1]}
            step={10}
            suffix="%"
            disabled={off}
            onChange={(chatScalePct) => prefs.update({ chatScalePct })}
          />
        </div>
      </div>
    </section>
  );
}
