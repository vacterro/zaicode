// Build the suite payload from a clean source install whose clones sit on published commits.
// Every bundled file is a tracked file of its clone, so the installed clones are clean and update
// from GitHub like any source install. This never publishes or writes to the running install.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const option = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
if (!option("--bootstrap-root")) throw new Error("Usage: node install/build-suite.mjs --bootstrap-root CLEAN_SOURCE_INSTALL [--app-dir WIN_UNPACKED]");
const bootstrap = resolve(option("--bootstrap-root"));
const app = resolve(option("--app-dir") ?? join(bootstrap, "zcode", "packages", "desktop", "dist", "win-unpacked"));
const version = readFileSync(join(bootstrap, "VERSION"), "utf8").trim();
const release = join(resolve(import.meta.dirname, ".."), ".zaicode", "release", version);
mkdirSync(release, { recursive: true });
const stage = mkdtempSync(join(release, "payload-"));
const git = join(bootstrap, ".tools", "git", "cmd", "git.exe");
const python = join(bootstrap, ".tools", "python", "tools", "python.exe");
const gitText = (dir, args) => execFileSync(git, ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const clones = { workspace: bootstrap, zcode: join(bootstrap, "zcode"), saipen: join(bootstrap, "saipen"), saimail: join(bootstrap, "saimail") };

// A clone with content edits or an unpublished product commit would install as "local changes" and never update.
const commits = {};
for (const [name, dir] of Object.entries(clones)) {
  try {
    execFileSync(git, ["-C", dir, "diff", "--quiet", "--ignore-cr-at-eol", "HEAD"]);
  } catch {
    throw new Error(`${name} clone has local edits: ${dir}`);
  }
  commits[name] = gitText(dir, ["rev-parse", "HEAD"]).trim();
  const published = gitText(dir, ["branch", "-r", "--contains", "HEAD"]).trim();
  if (!published && name !== "workspace") throw new Error(`${name} HEAD ${commits[name]} is not on its remote yet: push it first`);
  if (!published) console.warn(`[suite] workspace ${commits[name].slice(0, 8)} is not on origin/master yet: installs report the workspace as ahead until it is published`);
}

function copy(from, relative) {
  if (!existsSync(from)) throw new Error(`Missing suite input: ${from}`);
  const to = resolve(stage, relative);
  if (!to.startsWith(stage + "\\")) throw new Error(`Suite path escaped staging: ${relative}`);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, dereference: false });
}
function snapshot(from, prefix) {
  for (const file of gitText(from, ["ls-files", "-z"]).split("\0").filter(Boolean)) {
    const source = join(from, file);
    // Paths outside a sparse checkout are not on disk; the copied .git keeps them out of status too.
    if (!existsSync(source) || lstatSync(source).isSymbolicLink() || lstatSync(source).isDirectory()) continue;
    copy(source, join(prefix, file));
  }
  copy(join(from, ".git"), join(prefix, ".git"));
}
snapshot(clones.workspace, "");
for (const name of ["zcode", "saipen", "saimail"]) snapshot(clones[name], name);
for (const file of ["install/install-state.json", "install/install-report.json", "install/update-state.json", "install/ownership.json", ".saipen/STATE.md"]) {
  if (existsSync(join(stage, file))) throw new Error(`Machine state or protocol memory was included in suite inputs: ${file}`);
}
copy(app, "zcode/packages/desktop/dist/win-unpacked");
copy(join(bootstrap, "ZAICODE.exe"), "ZAICODE.exe");
for (const name of ["git", "node", "python"]) copy(join(bootstrap, ".tools", name), `.tools/${name}`);
const wheels = join(stage, ".tools", "wheels");
mkdirSync(wheels, { recursive: true });
execFileSync(python, ["-m", "pip", "wheel", `${clones.saimail}[crypto]`, "--wheel-dir", wheels], { stdio: "inherit", windowsHide: true });
const appMeta = JSON.parse(readFileSync(join(app, "resources", "build-meta.json"), "utf8"));
if (appMeta.appVersion !== version) throw new Error(`App ${appMeta.appVersion} does not match suite ${version}`);
if (!commits.zcode.startsWith(appMeta.buildCommitId)) throw new Error(`App was built from ${appMeta.buildCommitId}, the bundled source is ${commits.zcode}`);
const meta = {
  schema: 1, version, target: "windows-x64", bundledAt: new Date().toISOString(), app: appMeta,
  commits, companions: { saipen: commits.saipen, saimail: commits.saimail },
};
writeFileSync(join(stage, "install", "payload-meta.json"), JSON.stringify(meta, null, 2));
const zip = join(release, `ZAICODE-Suite-${version}-win-x64.zip`);
// Python's standard ZIP implementation handles the bundled router's long Windows paths.
execFileSync(python, ["-c", "import os,sys,zipfile; root,out=sys.argv[1:]; z=zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=6); [(z.write(os.path.join(d,f),os.path.relpath(os.path.join(d,f),root))) for d,ds,fs in os.walk(root) for f in fs]; z.close()", stage, zip], { stdio: "inherit", windowsHide: true });
const digest = createHash("sha256").update(readFileSync(zip)).digest("hex");
writeFileSync(zip + ".sha256", digest + "\n");
writeFileSync(join(release, "suite-receipt.json"), JSON.stringify({ ...meta, zip, sha256: digest, bytes: statSync(zip).size, stage }, null, 2));
console.log(JSON.stringify({ zip, sha256: digest, bytes: statSync(zip).size, stage }));
