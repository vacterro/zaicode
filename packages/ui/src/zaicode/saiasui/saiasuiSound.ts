import { readZaicodeSoundSettings } from "../zaicodeSoundEvents.js";
import type { SaiasuiConfig } from "./saiasuiConfig.js";

export type SaiasuiSoundKind = "hit" | "special" | "miss" | "event" | "gameover";

/** Per-run original percussion; no music, samples, network or shared audio ownership. */
export function createSaiasuiSound() {
  let context: AudioContext | null = null;
  let closed = false;
  const tone = (freq: number, gainScale: number, volume: number) => {
    if (closed || typeof AudioContext === "undefined") return;
    try {
      const settings = readZaicodeSoundSettings();
      if (settings.muted || settings.masterVolume <= 0) return;
      context ??= new AudioContext();
      const ctx = context;
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const now = ctx.currentTime;
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(freq, now);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(80, freq * 0.28), now + 0.06);
      const level = Math.min(1, (settings.masterVolume / 100) * (volume / 100)) * gainScale;
      gain.gain.setValueAtTime(Math.max(0.0001, level), now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.075);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(now);
      oscillator.stop(now + 0.08);
    } catch {
      /* Audio failure must never affect work or scoring. */
    }
  };
  return {
    play(kind: SaiasuiSoundKind, config: SaiasuiConfig) {
      if (!config.audioEnabled) return;
      if (kind === "hit" && !config.hitSound) return;
      if (kind === "special" && !config.hitSound && !config.eventSound) return;
      if (kind === "miss" && !config.missSound) return;
      if (kind === "event" && !config.eventSound) return;
      if (kind === "gameover" && !config.gameOverSound) return;
      const freq = kind === "special" || kind === "event" ? 1100 : kind === "gameover" ? 300 : kind === "miss" ? 420 : 780;
      tone(freq, 0.16, config.volume);
    },
    close() {
      closed = true;
      if (context) void context.close().catch(() => undefined);
      context = null;
    },
  };
}
