import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// T-126 (SRC-089): the customization folder crosses four layers (shared contract, main handler, preload bridge,
// the renderer's typed platform). A channel that exists in one and not in the next is a button that does nothing,
// and a node test cannot run Electron, so this pins the wiring by reading the sources.

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, "..", "..", relative), "utf8");

const shared = read("shared/src/channels.ts");
const platform = read("shared/src/platform.ts");
const host = read("desktop/src/main/zaicodeCustomizationHost.ts");
const preload = read("desktop/src/preload/index.ts");
const ipc = read("desktop/src/main/desktopMainIpcPlatform.ts");

const INVOKE: [channel: string, method: string][] = [
  ["GetZaicodeCustomizationInfo", "getZaicodeCustomizationInfo"],
  ["ListZaicodeCustomSounds", "listZaicodeCustomSounds"],
  ["ReadZaicodeCustomSound", "readZaicodeCustomSound"],
  ["WriteZaicodeCustomSound", "writeZaicodeCustomSound"],
  ["ListZaicodeCustomPresets", "listZaicodeCustomPresets"],
  ["ReadZaicodeCustomPreset", "readZaicodeCustomPreset"],
  ["WriteZaicodeCustomPreset", "writeZaicodeCustomPreset"],
  ["OpenZaicodeCustomization", "openZaicodeCustomization"],
];

/** The preload line that defines `method`, up to the next method: it has to invoke `channel`. */
function preloadBody(method: string): string {
  const start = preload.indexOf(`  ${method}: `);
  assert.ok(start >= 0, `${method} is in the preload bridge`);
  const next = preload.indexOf("\n  ", preload.indexOf("\n", start) + 1);
  return preload.slice(start, next < 0 ? undefined : next + 200);
}

test("every customization request has a name, a contract, a main handler, a preload method and a platform method", () => {
  for (const [channel, method] of INVOKE) {
    assert.ok(shared.includes(`  ${channel}: "zaicode:customization-`), `${channel} has a channel name`);
    assert.ok(shared.includes(`[PlatformChannels.${channel}]: {`), `${channel} has a contract`);
    assert.ok(host.includes(`ipcMain.handle(PlatformChannels.${channel},`), `${channel} has a handler`);
    assert.ok(preloadBody(method).includes(`ipcRenderer.invoke(PlatformChannels.${channel}`), `${method} reaches ${channel}`);
    assert.ok(platform.includes(`  ${method}?(`), `${method} is on the platform type`);
  }
});

test("channel names are unique, so one request can never answer as another", () => {
  const names = [...shared.matchAll(/: "(zaicode:customization-[a-z-]+)"/g)].map((match) => match[1]);
  assert.equal(names.length, INVOKE.length + 1, "eight requests and one notice");
  assert.equal(new Set(names).size, names.length);
});

test("the change notice goes main to the windows and reaches the page as a callback that can be removed", () => {
  assert.ok(shared.includes('ZaicodeCustomizationChanged: "zaicode:customization-changed"'));
  assert.ok(host.includes("webContents.send(PlatformChannels.ZaicodeCustomizationChanged, change)"));
  assert.ok(preloadBody("onZaicodeCustomizationChanged").includes("ipcRenderer.on(PlatformChannels.ZaicodeCustomizationChanged, listener)"));
  assert.ok(preload.includes("removeListener(PlatformChannels.ZaicodeCustomizationChanged, listener)"));
  assert.ok(platform.includes("onZaicodeCustomizationChanged?("));
});

test("the host is registered with the other platform handlers, watches after the folders exist, and stops with the app", () => {
  assert.ok(ipc.includes("registerZaicodeCustomizationIpc("));
  assert.ok(host.includes("ensureZaicodeCustomizationFolders(info).then("));
  assert.ok(host.includes("watchZaicodeCustomization(info, broadcast)"));
  assert.ok(host.includes('app.on("will-quit", () => watcher.close())'));
});

test("main re-checks what the renderer sends: a request that is not the expected shape is refused before any file work", () => {
  assert.ok(host.includes('typeof path === "string" ? readZaicodeCustomSound(info, path) : { ok: false'));
  assert.ok(host.includes('request["bytes"] instanceof Uint8Array'));
  assert.ok(host.includes('typeof request["name"] !== "string" || typeof request["text"] !== "string"'));
  assert.ok(host.includes('kind !== "root" && kind !== "sounds" && kind !== "presets"'));
});
