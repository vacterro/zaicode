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
import { ZAICODE_HELP_WIKI } from "./zaicodeHelpWiki.js";
import { ZaicodeHelpArticle, zaicodeHelpArticleText } from "./ZaicodeHelpArticle.js";
import { isZaicodeHelpTopicId } from "@/zaicode/zaicodeHelpTopics.js";

const BEGINNER_KEY = "zaicode-help-beginner";

function readBeginner(): boolean {
  try {
    return localStorage.getItem(BEGINNER_KEY) !== "0";
  } catch {
    return true;
  }
}

function articleOf(id: string) {
  return isZaicodeHelpTopicId(id) ? ZAICODE_HELP_WIKI[id] : undefined;
}

export { ZAICODE_HELP_TOPICS as TOPICS } from "./zaicodeHelpContent.js";

export function ZaicodeHelpSection() {
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLElement>());
  // SRC-060: the encyclopedia. Beginner mode (the default) shows every full
  // explanation; otherwise each card opens its own, and a jump opens its target.
  const [beginner, setBeginner] = useState(readBeginner);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const toggleOpened = (id: string) =>
    setOpened((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // One place decides how a topic is shown, so a mount-time jump and a live
  // Shift+F1 behave identically. SRC-060: the mount path used to be the only
  // one, which meant pressing Shift+F1 while Help was already open did nothing.
  const showTopic = useCallback((topic: string) => {
    setFocus(topic);
    setQuery("");
    setOpened((current) => new Set(current).add(topic));
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
      [topic.title, topic.what, ...topic.lines, ...zaicodeHelpArticleText(articleOf(topic.id))].some((text) =>
        text.toLowerCase().includes(needle),
      ),
    );
  }, [query]);

  return (
    <div className="flex flex-col gap-3 text-ui-xs" data-zaicode-help>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-ui-lg text-foreground">Help</h2>
        <span className="text-foreground-subtle">
          The ZAICODE encyclopedia: every part explained, from the first project to audits. Point at
          anything in the app and press Shift+F1 to land on its explanation. Almost anything can also
          be right-clicked for its own settings.
        </span>
        <label className="flex items-center gap-1 text-foreground-subtle" title="Show every card's full explanation, not only its one-line summary">
          <input
            type="checkbox"
            checked={beginner}
            onChange={(event) => {
              setBeginner(event.target.checked);
              try {
                localStorage.setItem(BEGINNER_KEY, event.target.checked ? "1" : "0");
              } catch {
                // a view preference only
              }
            }}
          />
          Beginner: show every full explanation
        </label>
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
          {articleOf(topic.id) ? (
            beginner || opened.has(topic.id) || query.trim() ? (
              <>
                <ZaicodeHelpArticle article={articleOf(topic.id)!} />
                {!beginner ? (
                  <button type="button" className="self-start text-foreground-subtle underline decoration-dotted" onClick={() => toggleOpened(topic.id)}>
                    Hide the full explanation
                  </button>
                ) : null}
              </>
            ) : (
              <button type="button" className="self-start text-foreground-subtle underline decoration-dotted hover:text-foreground" aria-expanded={false} onClick={() => toggleOpened(topic.id)}>
                Read the full explanation
              </button>
            )
          ) : null}
        </section>
      ))}
    </div>
  );
}
