import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * Memory in plain words (Settings -> Memory, ZAICODE): what gets remembered,
 * when, where it lives, what it costs and how to steer it. The facts mirror
 * the agent runtime: one Markdown file per fact under
 * `~/.zcode/cli/memories/projects/<project>-<hash>/memory/`, an index
 * (MEMORY.md) read at the start of each new session, and an automatic
 * extraction pass after conversations while the switch is on.
 */
export function ZaicodeMemoryExplainer({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(!enabled);
  return (
    <section className="border border-border bg-card p-3 text-ui-xs" data-zaicode-memory-explainer>
      <button
        type="button"
        className="flex w-full items-center gap-1 text-left text-ui-sm text-foreground"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        How Memory works
        <span className="ml-2 text-ui-xs text-foreground-subtle">
          {enabled ? "On: the in-app agent keeps notes per project" : "Off: every session starts from zero"}
        </span>
      </button>
      {open ? (
        <div className="mt-2 flex flex-col gap-2 text-foreground">
          <p className="text-foreground-subtle">
            Without Memory every new session starts knowing nothing about your project except what it reads in the
            files. Memory lets the in-app ZAICODE agent keep short notes between sessions, like a colleague&apos;s notebook.
          </p>
          <ol className="flex list-decimal flex-col gap-1 pl-4">
            <li>
              <strong className="font-normal text-foreground">It learns.</strong>{" "}
              <span className="text-foreground-subtle">
                After a conversation a small background pass looks for facts worth keeping — “tests run with pnpm test”,
                “never edit the prod folder”, “the user wants answers in Estonian” — and saves each as one small note.
              </span>
            </li>
            <li>
              <strong className="font-normal text-foreground">It remembers.</strong>{" "}
              <span className="text-foreground-subtle">
                Every new session in the same project starts with the list of those notes and opens the ones that matter.
              </span>
            </li>
            <li>
              <strong className="font-normal text-foreground">You steer it.</strong>{" "}
              <span className="text-foreground-subtle">
                Say “remember that …” in a chat to save a note on purpose, or “forget …” to drop one. Below you can read
                every note per project.
              </span>
            </li>
          </ol>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-foreground-subtle">
            <span>Where</span>
            <code className="break-all text-foreground">~/.zcode/cli/memories/projects/&lt;project&gt;/memory/</code>
            <span>Cost</span>
            <span>A few extra model requests after conversations; nothing when it is off.</span>
            <span>Who</span>
            <span>
              Only the in-app agent. Subscription workers (Claude Code, Codex, Antigravity) keep their own memory in their
              own folders.
            </span>
            <span>When</span>
            <span>Switching it on applies to sessions started afterwards.</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
