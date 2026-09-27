/**
 * Preload of a ZAICODE ProTrail overlay (one per monitor, SRC-062).
 *
 * The overlay is a click-through, never-focused window over every app, so it
 * gets the smallest surface possible: it only listens to what the main
 * process feeds it (config, its monitor's origin, mouse events). It can send
 * nothing back.
 */
import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels, type ZaicodeProtrailOverlayFeed } from "@zcode/shared";

contextBridge.exposeInMainWorld("zaicodeProtrailOverlay", {
  onFeed: (callback: (feed: ZaicodeProtrailOverlayFeed) => void) => {
    const listener = (_event: unknown, feed: ZaicodeProtrailOverlayFeed) => callback(feed);
    ipcRenderer.on(PlatformChannels.ZaicodeProtrailOverlayFeed, listener);
    return () => ipcRenderer.removeListener(PlatformChannels.ZaicodeProtrailOverlayFeed, listener);
  },
});
