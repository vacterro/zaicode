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
}

/** An echo this soon after a direct sound belongs to that action. */
export const ZAICODE_SOUND_ECHO_MS = 700;
/** The same event twice this fast is one event (double renders, double listeners). */
export const ZAICODE_SOUND_DEDUPE_MS = 120;

interface SoundMemory {
  lastDirectAt: number;
  lastById: Map<string, number>;
}

/** Whether `id` should play now; updates `memory` when it does. Pure apart from `memory`. */
export function admitZaicodeSound(id: string, echo: boolean, now: number, memory: SoundMemory): boolean {
  const last = memory.lastById.get(id);
  if (last !== undefined && now - last < ZAICODE_SOUND_DEDUPE_MS) return false;
  if (echo && now - memory.lastDirectAt < ZAICODE_SOUND_ECHO_MS) return false;
  memory.lastById.set(id, now);
  if (!echo) memory.lastDirectAt = now;
  return true;
}

export function createZaicodeSoundMemory(): SoundMemory {
  return { lastDirectAt: Number.NEGATIVE_INFINITY, lastById: new Map() };
}

let player: ZaicodeSoundPlayer | null = null;
const memory = createZaicodeSoundMemory();

export function registerZaicodeSoundPlayer(next: ZaicodeSoundPlayer): void {
  player = next;
}

export function playZaicodeSound(id: string, options: ZaicodePlayOptions = {}): void {
  try {
    const { echo, ...rest } = options;
    // Previews are the operator testing a sound: never merged or suppressed.
    if (!rest.preview && !admitZaicodeSound(id, Boolean(echo), Date.now(), memory)) return;
    player?.(id, rest);
  } catch {
    // a sound never breaks an action
  }
}
