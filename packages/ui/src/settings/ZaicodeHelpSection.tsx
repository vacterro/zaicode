import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  onZaicodeHelpTopicRequest,
  openZaicodeSettings,
  takeZaicodeHelpTopic,
} from "@/zaicode/zaicodeActions.js";

/**
 * ZAICODE Help: every control in plain words. One card per area, each line
 * is "what you see — what it does". Type to filter; "Open" jumps to the
 * place where it is set up. Nothing here is required reading: the product
 * works without it, this is where to look when something is unclear.
 */

import { ZAICODE_HELP_TOPICS, type HelpTopic } from "./zaicodeHelpContent.js";

export { ZAICODE_HELP_TOPICS as TOPICS } from "./zaicodeHelpContent.js";

export function ZaicodeHelpSection() {
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLElement>());

  // One place decides how a topic is shown, so a mount-time jump and a live
  // Shift+F1 behave identically. SRC-060: the mount path used to be the only
  // one, which meant pressing Shift+F1 while Help was already open did nothing.
  const showTopic = useCallback((topic: string) => {
    setFocus(topic);
    setQuery("");
    requestAnimationFrame(() => refs.current.get(topic)?.scrollIntoView({ block: "start" }));
  }, []);

  useEffect(() => {
    const topic = takeZaicodeHelpTopic();
    if (topic) showTopic(topic);
    return onZaicodeHelpTopicRequest(showTopic);
  }, [showTopic]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return ZAICODE_HELP_TOPICS;
    return ZAICODE_HELP_TOPICS.filter((topic: HelpTopic) =>
      [topic.title, topic.what, ...topic.lines].some((text) => text.toLowerCase().includes(needle)),
    );
  }, [query]);

  return (
    <div className="flex flex-col gap-3 text-ui-xs" data-zaicode-help>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-ui-lg text-foreground">Help</h2>
        <span className="text-foreground-subtle">
          Every control in one line. Almost anything can also be right-clicked for its own settings.
        </span>
      </div>
      <input
        className="max-w-[420px] border border-border bg-background px-2 py-1 text-foreground"
        placeholder="Find: worker, meter, sound, reset, hotkey…"
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="flex flex-wrap gap-1">
        {ZAICODE_HELP_TOPICS.map((topic: HelpTopic) => (
          <button
            key={topic.id}
            type="button"
            className="border border-border px-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
            onClick={() => {
              setQuery("");
              setFocus(topic.id);
              requestAnimationFrame(() =>
                refs.current.get(topic.id)?.scrollIntoView({ block: "start" }),
              );
            }}
          >
            {topic.title}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="text-foreground-subtle">Nothing matches “{query}”.</p>
      ) : null}
      {shown.map((topic) => (
        <section
          key={topic.id}
          ref={(element) => {
            if (element) refs.current.set(topic.id, element);
            else refs.current.delete(topic.id);
          }}
          className={cn(
            "flex flex-col gap-1 border bg-card p-3",
            focus === topic.id
              ? "border-[var(--zaicode-highlight,var(--color-border-hover))]"
              : "border-border",
          )}
          data-zaicode-help-topic={topic.id}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-ui-base text-foreground">{topic.title}</h3>
              <p className="text-foreground-subtle">{topic.what}</p>
            </div>
            {topic.open ? (
              <button
                type="button"
                className="shrink-0 border border-border px-1.5 text-foreground hover:bg-hover"
                onClick={() => {
                  topic.open?.run?.();
                  if (topic.open?.section) void openZaicodeSettings(topic.open.section);
                }}
              >
                Open {topic.open.label}
              </button>
            ) : null}
          </div>
          <ul className="flex flex-col gap-0.5 pl-3">
            {topic.lines.map((line) => (
              <li key={line} className="list-disc text-foreground">
                {line}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
