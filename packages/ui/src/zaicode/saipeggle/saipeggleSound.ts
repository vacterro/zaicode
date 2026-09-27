import { isZaicodeSoundQuietNow } from "../zaicodeNotifications.js";
import { playZaicodeSoundFile, readZaicodeSoundSettings } from "../zaicodeSoundEvents.js";
import type { SpgCue } from "./saipeggleRules.js";

/**
 * SAIPEGGLE's sound. Every cue is a row of Settings -> Sounds (group
 * SAIPEGGLE): its switch, its sound and its gain apply here, the master
 * volume and mute too. Unlike app cues, game cues play while ZAICODE is in
 * front (it is the game) and are never debounced: a shot is a burst of hits.
 *
 * The Extreme Fever tune is Beethoven's "Ode to Joy" (public domain),
 * synthesised as an 8-bit square-wave melody over a triangle bass.
 */

const PER_FRAME = { "saipeggle.peg": 4, "saipeggle.clear": 3 } as Record<string, number>;

/** Plays the cues a frame queued (a few per kind, so a Space Blast is not forty clips at once). */
export function playSaipeggleCues(cues: readonly SpgCue[]): void {
  if (cues.length === 0) return;
  const settings = readZaicodeSoundSettings();
  if (settings.muted) return;
  const counts = new Map<string, number>();
  for (const cue of cues) {
    const row = settings.events[cue.id];
    if (!row?.enabled) continue;
    const count = (counts.get(cue.id) ?? 0) + 1;
    counts.set(cue.id, count);
    if (count > (PER_FRAME[cue.id] ?? 1)) continue;
    void playZaicodeSoundFile(row.sound, { gainDb: row.gainDb, ownMix: true, ...(cue.rate ? { rate: cue.rate } : {}) }).catch(() => undefined);
  }
}

// ---- The fever tune.

const NOTE: Record<string, number> = { G3: 196, A3: 220, B3: 246.94, C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392, A4: 440, B4: 493.88, C5: 523.25 };

/** [note, beats] -- two phrases of the theme. */
const ODE: readonly [string, number][] = [
  ["E4", 1], ["E4", 1], ["F4", 1], ["G4", 1], ["G4", 1], ["F4", 1], ["E4", 1], ["D4", 1],
  ["C4", 1], ["C4", 1], ["D4", 1], ["E4", 1], ["E4", 1.5], ["D4", 0.5], ["D4", 2],
  ["E4", 1], ["E4", 1], ["F4", 1], ["G4", 1], ["G4", 1], ["F4", 1], ["E4", 1], ["D4", 1],
  ["C4", 1], ["C4", 1], ["D4", 1], ["E4", 1], ["D4", 1.5], ["C4", 0.5], ["C4", 2],
];
/** One bass note per bar (4 beats). */
const BASS = ["C4", "G3", "C4", "G3", "C4", "G3", "C4", "C4"];
const BEAT = 0.3;

let context: AudioContext | null = null;
let playing: { stop: () => void } | null = null;

export function stopSaipeggleMusic(): void {
  playing?.stop();
  playing = null;
}

export function playSaipeggleFeverMusic(): void {
  stopSaipeggleMusic();
  const settings = readZaicodeSoundSettings();
  const row = settings.events["saipeggle.fever"];
  if (settings.muted || isZaicodeSoundQuietNow() || typeof AudioContext === "undefined") return;
  context ??= new AudioContext();
  const ctx = context;
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  const master = ctx.createGain();
  master.gain.value = (Math.max(0, Math.min(100, settings.masterVolume)) / 100) * 10 ** (((row?.gainDb ?? -4) - 14) / 20);
  master.connect(ctx.destination);
  const start = ctx.currentTime + 0.05;
  const voices: OscillatorNode[] = [];
  const tone = (type: OscillatorType, frequency: number, at: number, length: number, level: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.01);
    gain.gain.setValueAtTime(level * 0.7, at + Math.max(0.02, length - 0.06));
    gain.gain.linearRampToValueAtTime(0, at + length);
    osc.connect(gain).connect(master);
    osc.start(at);
    osc.stop(at + length + 0.02);
    voices.push(osc);
  };
  let beat = 0;
  for (const [note, beats] of ODE) {
    tone("square", NOTE[note]! * 2, start + beat * BEAT, beats * BEAT * 0.92, 0.28);
    beat += beats;
  }
  BASS.forEach((note, bar) => tone("triangle", NOTE[note]! / 2, start + bar * 4 * BEAT, 4 * BEAT * 0.95, 0.5));
  playing = {
    stop: () => {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(0, ctx.currentTime);
      for (const osc of voices) {
        try {
          osc.stop();
        } catch {
          // already stopped
        }
      }
      master.disconnect();
    },
  };
}
