import { playZaicodeSoundAsync } from "./zaicodeSoundEvents.js";

/**
 * ZAICODE agent cues: one clear sound per kind of agent moment. The Sounds
 * table (rows `agent.<event>`, zaicodeSoundEvents.ts) owns on/off, sound,
 * gain and focus for every cue; this module only names the moments.
 *
 *   done      a session finished its turn
 *   failed    a session ended with an error
 *   question  an agent asks you something / wants a plan approved
 *   human     an agent needs your permission (a human is required)
 *   update    a progress/feedback update arrived
 *   started   a session started working (the first one after idle)
 *
 * Cues play inside ZAICODE independent of the system notification popup; the
 * stock notification "pop" stays silent in ZAICODE so nothing plays twice.
 */
export type ZaicodeCueEvent = "done" | "failed" | "question" | "human" | "update" | "started";

const lastPlayedAt = new Map<ZaicodeCueEvent, number>();
/** The same cue at most once per this window (several sessions finishing together = one sound). */
const CUE_DEBOUNCE_MS = 1200;

/** Plays the cue for `event` through the Sounds table row `agent.<event>`. */
export async function playZaicodeCue(
  event: ZaicodeCueEvent,
  options: { preview?: boolean } = {},
): Promise<boolean> {
  if (!options.preview) {
    const now = Date.now();
    if (now - (lastPlayedAt.get(event) ?? 0) < CUE_DEBOUNCE_MS) return false;
    lastPlayedAt.set(event, now);
  }
  return playZaicodeSoundAsync(`agent.${event}`, options);
}

/** Maps a task-notification status to its cue. */
export function zaicodeCueForNotificationStatus(status: string): ZaicodeCueEvent | null {
  switch (status) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "permission_request":
      return "human";
    case "elicitation_request":
      return "question";
    case "feedback_update":
      return "update";
    default:
      return null;
  }
}
