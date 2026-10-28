/**
 * A localStorage for the node process, filled BEFORE the preset store module is evaluated (T-125 tests).
 * A server render reads a store's initial snapshot, and the presets store builds that snapshot from storage
 * once, when it is first imported: so a test that wants to see saved presets on screen imports this first.
 */

const data = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, String(value)),
    removeItem: (key: string) => void data.delete(key),
  },
});

const base = { createdAt: "2026-09-29T12:00:00.000Z", assets: [] };

data.set(
  "zaicode-presets-v1",
  JSON.stringify([
    { ...base, id: "a", section: "zaicodeSounds", name: "Night shift", settings: { "zaicode-audio-v1": null } },
    { ...base, id: "b", section: "zaicodeColors", name: "Amber", settings: { "zaicode-palette": "gray-amber" } },
  ]),
);

data.set(
  "zaicode-preset-undo-v1",
  JSON.stringify({
    zaicodeSounds: { label: "Night shift", at: "2026-09-29T12:00:00.000Z", settings: { "zaicode-audio-v1": null }, assets: [] },
  }),
);
