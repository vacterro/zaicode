import type { HelpTopic } from "./zaicodeHelpContent.js";

// SRC-114: the encyclopedia had no order of its own -- it rendered whatever order
// the cards were written in, so a newcomer met SAIPEGGLE (a pixel game) third and
// window zones long before the composer. The content was fine; only the reading
// order was wrong.
//
// The curriculum lives here, apart from the content, for two reasons: it is the
// single place that decides the order (a new topic is appended to the chapter it
// belongs to, never to the content array alone), and it is pure data with only a
// type-only import, so a test can read the order without loading the component
// tree behind the cards.

export interface HelpChapter {
  title: string;
  what: string;
  topics: readonly string[];
}

/** A chapter whose topic ids have been resolved to the topics themselves. */
export interface ResolvedHelpChapter {
  title: string;
  what: string;
  topics: readonly HelpTopic[];
}

export const ZAICODE_HELP_CURRICULUM: readonly HelpChapter[] = [
  {
    title: "1 · Start here",
    what: "What ZAICODE is, and the four things you touch every day.",
    topics: ["start", "glossary", "sidebar", "home", "composer", "header"],
  },
  {
    title: "2 · Give it work",
    what: "Choosing who works, and what they are asked to do.",
    topics: ["workers", "engines", "accounts", "continue", "todo", "search"],
  },
  {
    title: "3 · Watch it work",
    what: "Limits, resets, results and what the agent says back.",
    topics: ["saihome", "meter", "timers", "changes", "sessiontext", "notifications"],
  },
  {
    title: "4 · Make it yours",
    what: "Settings, keys, sounds and the desktop itself.",
    topics: ["settings", "hotkeys", "sounds", "protrail", "zones", "splash", "memory"],
  },
  {
    title: "5 · Let it run",
    what: "Work that starts by itself, on a clock or on a refill.",
    topics: ["zaicode", "scheduler", "autostart", "dispatch", "audit", "saimail", "plugins"],
  },
  {
    // The game is a reward, not a foundation: it stays last on purpose.
    title: "6 · Extras",
    what: "Everything else worth knowing once the rest is obvious.",
    topics: ["saipeggle"],
  },
];

/**
 * The curriculum resolved against the real topics. A topic the curriculum does
 * not name yet is never lost: it lands in a trailing chapter, so a card can
 * never disappear from Help because somebody forgot to file it.
 */
export function resolveZaicodeHelpChapters(
  topics: readonly HelpTopic[],
): readonly ResolvedHelpChapter[] {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const orderedIds = new Set(ZAICODE_HELP_CURRICULUM.flatMap((chapter) => chapter.topics));
  return [
    ...ZAICODE_HELP_CURRICULUM.map((chapter) => ({
      title: chapter.title,
      what: chapter.what,
      topics: chapter.topics.flatMap((id) => {
        const topic = byId.get(id);
        return topic ? [topic] : [];
      }),
    })),
    {
      title: "7 · Not filed yet",
      what: "New surfaces land here until they are given their place.",
      topics: topics.filter((topic) => !orderedIds.has(topic.id)),
    },
  ].filter((chapter) => chapter.topics.length > 0);
}

/** The flat reading order the jump chips and the card list share. */
export function zaicodeHelpOrderedTopics(
  chapters: readonly ResolvedHelpChapter[],
): readonly HelpTopic[] {
  return chapters.flatMap((chapter) => chapter.topics);
}