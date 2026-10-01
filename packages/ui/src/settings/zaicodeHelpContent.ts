import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import { ZAICODE_HELP_TOPICS_ADVANCED } from "./zaicodeHelpTopicsAdvanced.js";
import { ZAICODE_HELP_TOPICS_CORE } from "./zaicodeHelpTopicsCore.js";
import {
  resolveZaicodeHelpChapters,
  zaicodeHelpOrderedTopics,
  type ResolvedHelpChapter,
} from "./zaicodeHelpOrder.js";

/** One explained surface: what it is, in one sentence, and the few lines that matter. */
export interface HelpTopic {
  id: string;
  title: string;
  /** One sentence: why this exists. */
  what: string;
  lines: readonly string[];
  open?: { label: string; section?: SettingsSectionId; run?: () => void };
}

/** Every card, in declaration order. The reading order is the curriculum, not this. */
export const ZAICODE_HELP_TOPICS: readonly HelpTopic[] = [
  ...ZAICODE_HELP_TOPICS_CORE,
  ...ZAICODE_HELP_TOPICS_ADVANCED,
];

// SRC-114: the reading order lives in zaicodeHelpOrder.ts and is resolved here,
// where the topics themselves live. The component imports the two constants
// below and never has to know that an order exists.
export const ZAICODE_HELP_ORDERED_CHAPTERS: readonly ResolvedHelpChapter[] =
  resolveZaicodeHelpChapters(ZAICODE_HELP_TOPICS);
export const ZAICODE_HELP_ORDERED_TOPICS: readonly HelpTopic[] = zaicodeHelpOrderedTopics(
  ZAICODE_HELP_ORDERED_CHAPTERS,
);
