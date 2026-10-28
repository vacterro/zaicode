/**
 * An empty preset shelf for a test that must meet the menu the way a first-time user does.
 * The same trick as ./presetStorage: a server render reads a store's INITIAL snapshot, and the preset
 * store builds that snapshot once, when it is first imported, from the explicit stored value if there
 * is one and otherwise from the BUNDLED settings default. That bundled default is a live-machine
 * snapshot, so it can carry presets; a test that means "nothing saved yet" has to say so in storage.
 */
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => (key === "zaicode-presets-v1" ? "[]" : null),
    setItem: () => undefined,
    removeItem: () => undefined,
  },
});
