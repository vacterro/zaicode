import { readZaicodeSoundSettings } from "../zaicodeSoundEvents.js";

/** Per-run original percussion; no music, samples, network or shared audio ownership. */
export function createSaiasuiSound() {
  let context: AudioContext | null = null;
  let closed = false;
  return {
    hit(enabled: boolean, special: boolean) {
      if (!enabled || closed || typeof AudioContext === "undefined") return;
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
        oscillator.frequency.setValueAtTime(special ? 1100 : 780, now);
        oscillator.frequency.exponentialRampToValueAtTime(220, now + 0.06);
        gain.gain.setValueAtTime(Math.min(1, settings.masterVolume / 100) * 0.16, now);
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
    },
    close() {
      closed = true;
      if (context) void context.close().catch(() => undefined);
      context = null;
    },
  };
}
