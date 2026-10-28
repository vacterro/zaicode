import { app } from "electron";
import { join } from "node:path";
import { readZaicodeRuntimeIdentity } from "./zaicodeRuntimeIdentity.js";
import { resolveZaicodeInstallRoot } from "./zaicodeUpdates.js";

/** One runtime projection for About and machine diagnostics; never reads live credentials. */
export function getZaicodeRuntimeIdentity() {
  return readZaicodeRuntimeIdentity({
    executablePath: process.execPath,
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged,
    metadataPath: join(app.getAppPath(), "out", "metadata", "build-meta.json"),
    installRoot: resolveZaicodeInstallRoot({
      env: process.env,
      execPath: process.execPath,
      appPath: app.getAppPath(),
    }),
  });
}
