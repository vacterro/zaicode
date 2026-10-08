// Build a reviewable suite payload; this never publishes or writes to the running install.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const option = (name) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes("--bootstrap-root") || !process.argv.includes("--app-dir")) throw new Error("Usage: node install/build-suite.mjs --bootstrap-root CLEAN_SOURCE_INSTALL --app-dir WIN_UNPACKED");
const bootstrap = resolve(option("--bootstrap-root"));
const app = resolve(option("--app-dir"));
const version = readFileSync(join(root, "VERSION"), "utf8").trim();
const release = join(root, ".zaicode", "release", version);
mkdirSync(release, { recursive: true });
const stage = mkdtempSync(join(release, "payload-"));
const git = join(bootstrap, ".tools", "git", "cmd", "git.exe");
const python = join(bootstrap, ".tools", "python", "tools", "python.exe");
const files = (dir) => execFileSync(git, ["-C", dir, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\0").filter(Boolean);
const excluded = (path) => /(^|\/)(\.saipen|\.saimail-workspace|stats|customization|mail|__pycache__|\.pytest_cache)(\/|$)/.test(path);
function copy(from, relative) {
  if (!existsSync(from)) throw new Error(`Missing suite input: ${from}`);
  const to = resolve(stage, relative);
  if (!to.startsWith(stage + "\\")) throw new Error(`Suite path escaped staging: ${relative}`);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, dereference: false });
}
function snapshot(from, prefix, paths) {
  for (const file of paths) if (!excluded(file) && existsSync(join(from, file))) copy(join(from, file), join(prefix, file));
}
snapshot(root, "", files(root).filter((file) => /^(install\/|tools\/launcher\/|VERSION$|README\.md$|UI\.md$|CHANGELOG\.md$|\.gitignore$|\.gitattributes$|ZAICODE\.(cmd|ps1)$)/.test(file)));
// New release files and the user's approved artwork are not necessarily committed in a candidate build.
for (const file of ["ZaicodeSuite.ps1", "Uninstall-ZAICODE.ps1", "setup/assets/launch.jpg", "setup/assets/background.jpg"]) copy(join(root, "install", file), join("install", file));
for (const file of ["install-state.json", "install-report.json", "update-state.json", "ownership.json"]) {
  if (existsSync(join(stage, "install", file))) throw new Error(`Machine state was included in suite inputs: ${file}`);
}
copy(join(bootstrap, ".git"), ".git");
snapshot(join(root, "zcode"), "zcode", files(join(root, "zcode")));
copy(join(root, "zcode", "ZAICODE_VERSION"), "zcode/ZAICODE_VERSION");
copy(join(bootstrap, "zcode", ".git"), "zcode/.git");
for (const name of ["saipen", "saimail"]) {
  snapshot(join(bootstrap, name), name, files(join(bootstrap, name)));
  copy(join(bootstrap, name, ".git"), `${name}/.git`);
}
copy(app, "zcode/packages/desktop/dist/win-unpacked");
copy(join(bootstrap, "ZAICODE.exe"), "ZAICODE.exe");
for (const name of ["git", "node", "python"]) copy(join(bootstrap, ".tools", name), `.tools/${name}`);
const wheels = join(stage, ".tools", "wheels");
mkdirSync(wheels, { recursive: true });
execFileSync(python, ["-m", "pip", "wheel", `${join(bootstrap, "saimail")}[crypto]`, "--wheel-dir", wheels], { stdio: "inherit", windowsHide: true });
const appMeta = JSON.parse(readFileSync(join(app, "resources", "build-meta.json"), "utf8"));
if (appMeta.appVersion !== version) throw new Error(`App ${appMeta.appVersion} does not match suite ${version}`);
const meta = {
  schema: 1, version, target: "windows-x64", bundledAt: new Date().toISOString(), app: appMeta,
  companions: Object.fromEntries(["saipen", "saimail"].map((name) => [name, execFileSync(git, ["-C", join(bootstrap, name), "rev-parse", "HEAD"], { encoding: "utf8" }).trim()])),
  sourceSnapshot: "candidate; workspace changes are included; publish only after review and release gates",
};
writeFileSync(join(stage, "install", "payload-meta.json"), JSON.stringify(meta, null, 2));
const zip = join(release, `ZAICODE-Suite-${version}-win-x64.zip`);
// Python's standard ZIP implementation handles the bundled router's long Windows paths.
execFileSync(python, ["-c", "import os,sys,zipfile; root,out=sys.argv[1:]; z=zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=6); [(z.write(os.path.join(d,f),os.path.relpath(os.path.join(d,f),root))) for d,ds,fs in os.walk(root) for f in fs]; z.close()", stage, zip], { stdio: "inherit", windowsHide: true });
const digest = createHash("sha256").update(readFileSync(zip)).digest("hex");
writeFileSync(zip + ".sha256", digest + "\n");
writeFileSync(join(release, "suite-receipt.json"), JSON.stringify({ ...meta, zip, sha256: digest, bytes: statSync(zip).size, stage }, null, 2));
console.log(JSON.stringify({ zip, sha256: digest, bytes: statSync(zip).size, stage }));
