/**
 * The one door every ZAICODE action uses to make a sound. It carries no
 * audio itself: the Sounds engine (zaicodeSoundEvents) registers the player
 * when the app loads it, so logic modules stay free of bundled assets.
 */
export type ZaicodeSoundPlayer = (id: string, options?: { preview?: boolean; sound?: string }) => void;

export interface ZaicodePlayOptions {
  preview?: boolean;
  sound?: string;
  /**
   * The sound is a consequence of a state change (the app noticed that the
   * project or the session changed), not of the operator's own action. SRC-038:
   * "Switch project" and "New task" used to play together, because creating a
   * task in another project also changes the project. An echo stays silent when
   * a direct action sound played just before it.
   */
  echo?: boolean;
  /**
   * How long after the operator's own sound an echo still belongs to it
   * (default ZAICODE_SOUND_ECHO_MS). Navigation echoes use a longer one
   * (SRC-062): a cold session can take over a second to open, and its
   * "session opened" used to land as a second, late sound.
   */
  echoWindowMs?: number;
}

/** An echo this soon after a direct sound belongs to that action. */
export const ZAICODE_SOUND_ECHO_MS = 700;
/** Navigation echoes (project switched, session opened) belong to the click for this long (SRC-062). */
export const ZAICODE_SOUND_NAV_ECHO_MS = 1600;

/**
 * One navigation, one sound (SRC-062): switching project and then landing on a
 * session of it are two state changes of one move. The second is silent when
 * the first was announced (or asked for) this recently.
 */
export function zaicodeNavigationEcho(
  change: { workspaceChanged: boolean; taskChanged: boolean },
  now: number,
  lastNavigationAt: number,
): "sidebar.project" | "session.open" | null {
  if (change.workspaceChanged) return "sidebar.project";
  if (!change.taskChanged) return null;
  return now - lastNavigationAt < ZAICODE_SOUND_NAV_ECHO_MS ? null : "session.open";
}
/** The same event twice this fast is one event (double renders, double listeners). */
export const ZAICODE_SOUND_DEDUPE_MS = 120;
/**
 * SRC-061: an echo waits this long before it may play. React opens a popover
 * (or calls toast()) inside the click handler, before the document-level
 * listener plays the click's own sound, so an echo decided at once always
 * came first and the operator heard two sounds for one click (Problip's
 * second click, every right-click that opens a panel). Waiting lets the
 * direct sound of the same action land first and claim the moment.
 */
export const ZAICODE_SOUND_ECHO_DEFER_MS = 150;

interface SoundMemory {
  lastDirectAt: number;
  lastById: Map<string, number>;
}

/** Whether `id` should play now; updates `memory` when it does. Pure apart from `memory`. */
export function admitZaicodeSound(
  id: string,
  echo: boolean,
  now: number,
  memory: SoundMemory,
  echoWindowMs: number = ZAICODE_SOUND_ECHO_MS,
): boolean {
  const last = memory.lastById.get(id);
  if (last !== undefined && now - last < ZAICODE_SOUND_DEDUPE_MS) return false;
  if (echo && now - memory.lastDirectAt < echoWindowMs) return false;
  memory.lastById.set(id, now);
  if (!echo) memory.lastDirectAt = now;
  return true;
}

export function createZaicodeSoundMemory(): SoundMemory {
  return { lastDirectAt: Number.NEGATIVE_INFINITY, lastById: new Map() };
}

let player: ZaicodeSoundPlayer | null = null;
/** Whether event `id` can be heard at all (on, not muted); registered by the Sounds engine. */
let audible: ((id: string) => boolean) | null = null;
const memory = createZaicodeSoundMemory();

/**
 * SRC-060: a silent event must not take part in merging. Without this, a
 * switched-off voice fired on every hover or key press (the Orchestra's hover
 * and typing rows) counted as "a direct sound just played" and silenced the
 * notices and windows that followed it.
 */
export function registerZaicodeSoundAudible(next: (id: string) => boolean): void {
  audible = next;
}

/** Lets the generic UI listener stand down when a control played its own cue. */
export function zaicodeDirectSoundPlayedSince(at: number): boolean {
  return memory.lastDirectAt >= at;
}

export function registerZaicodeSoundPlayer(next: ZaicodeSoundPlayer): void {
  player = next;
}

export function playZaicodeSound(id: string, options: ZaicodePlayOptions = {}): void {
  try {
    const { echo, echoWindowMs = ZAICODE_SOUND_ECHO_MS, ...rest } = options;
    // Previews are the operator testing a sound: never merged or suppressed.
    if (rest.preview) {
      player?.(id, rest);
      return;
    }
    if (audible && !audible(id)) return;
    if (echo) {
      const asked = Date.now();
      // Dropped at once when a direct sound just played; otherwise decided
      // after the rest of this action has had its say.
      if (asked - memory.lastDirectAt < echoWindowMs) return;
      setTimeout(() => {
        if (memory.lastDirectAt >= asked) return;
        if (admitZaicodeSound(id, true, Date.now(), memory, echoWindowMs)) player?.(id, rest);
      }, ZAICODE_SOUND_ECHO_DEFER_MS);
      return;
    }
    if (!admitZaicodeSound(id, false, Date.now(), memory)) return;
    player?.(id, rest);
  } catch {
    // a sound never breaks an action
  }
}
