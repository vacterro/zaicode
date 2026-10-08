import { createRequire } from "node:module";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const product = path.join(root, "zcode");
const require = createRequire(path.join(product, "package.json"));
const asar = require("@electron/asar");
const packages = [];
for (const name of ["dist", "dist-next", "dist-t217", "dist-t166", "dist-t188"]) {
  const base = path.join(product, "packages/desktop", name, "win-unpacked");
  const archive = path.join(base, "resources/app.asar");
  if (!fs.existsSync(archive)) continue;
  const files = asar.listPackage(archive);
  const metadataName = files
    .map((entry) => entry.split(String.fromCharCode(92)).join("/").replace(/^\//, ""))
    .find((entry) => entry.endsWith("/metadata/build-meta.json"));
  const metadata = metadataName
    ? JSON.parse(asar.extractFile(archive, metadataName.split("/").join(path.sep)).toString("utf8"))
    : null;
  const pkg = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  let containsT217 = null;
  if (metadata?.buildCommitId && metadata.buildCommitId !== "unknown") {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", "dfacb62d", metadata.buildCommitId], { cwd: product });
      containsT217 = true;
    } catch (error) {
      containsT217 = error.status === 1 ? false : null;
    }
  }
  const updateConfigPath = path.join(base, "resources/app-update.yml");
  const mainBytes = asar.extractFile(archive, path.join("out", "main", "index.js"));
  const mainText = mainBytes.toString("utf8");
  packages.push({
    name,
    executablePath: fs.realpathSync(path.join(base, "ZAICODE.exe")),
    metadataName,
    metadata,
    packageVersion: pkg.version,
    containsT217,
    mainSha256: crypto.createHash("sha256").update(mainBytes).digest("hex"),
    supervisorMarkers: {
      persistedSupervisorFile: mainText.includes("zaicode-router-supervisor.json"),
      sharedRecoveryLog: mainText.includes("zaicode-shared-router-recovery.log"),
    },
    executableMtime: fs.statSync(path.join(base, "ZAICODE.exe")).mtime.toISOString(),
    asarMtime: fs.statSync(archive).mtime.toISOString(),
    asarSha256: crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"),
    updateConfig: fs.existsSync(updateConfigPath) ? fs.readFileSync(updateConfigPath, "utf8") : null,
  });
}
const result = {
  capturedAt: new Date().toISOString(),
  sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: product, encoding: "utf8" }).trim(),
  packages,
  limitations: [
    "Read-only on-disk package evidence; live process path observed separately.",
    "No router outage exercised; screenshot runtime attribution remains unproven.",
    "Metadata records a commit label, not a signed exact source-tree attestation.",
  ],
};
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime-package-inspection.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
