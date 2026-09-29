// T-129 diagnostic: start a PACKAGED ZAICODE on a throw-away profile and ask its ProTrail overlays whether they
// really draw. Reuses the boot gate's check (zcode/packages/desktop/scripts/verify-zaicode-protrail.cjs), so what
// this prints is exactly what `pnpm bundle:zaicode` gates on.
//
//   node protrail-probe.cjs <ZAICODE.exe> [--seed <operator userData>] [--repeat N]
//
// --seed copies the operator's renderer settings (Local Storage) and launcher preferences into the throw-away
// profile, so the app starts with THEIR ProTrail config. It never writes to the operator's profile and kills only
// the process tree it started. The operator's mouse is never touched: the sweep goes through the overlay feed.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..", "zcode");
const { _electron } = require(path.join(repoRoot, "node_modules", "playwright-core"));
const { checkProtrail } = require(path.join(repoRoot, "packages", "desktop", "scripts", "verify-zaicode-protrail.cjs"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const option = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const executablePath = path.resolve(process.argv[2] ?? "");
const seed = option("--seed");
const repeat = Number(option("--repeat") ?? 1);
const tempBase = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "Temp");

async function once(index) {
  const profile = fs.mkdtempSync(path.join(tempBase, "zaicode-probe-"));
  if (seed) {
    const from = path.resolve(seed);
    const to = path.join(profile, "session", "Local Storage");
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(path.join(from, "session", "Local Storage"), to, { recursive: true, filter: (src) => !/[\\/]LOCK$/.test(src) });
    const launcher = path.join(from, "zaicode-launcher.json");
    if (fs.existsSync(launcher)) fs.copyFileSync(launcher, path.join(profile, "zaicode-launcher.json"));
  }
  const env = {
    ...process.env,
    ZCODE_DESKTOP_APPLICATION_NAME: `ZAICODE probe ${path.basename(profile)}`,
    ZCODE_DESKTOP_HOME_DIR: profile,
    ZCODE_DESKTOP_USER_DATA_DIR: profile,
    ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, "session"),
    ZCODE_DATA_BASE_DIR: profile,
    ZCODE_HOME: path.join(profile, ".zcode"),
    ZCODE_ZAICODE_MODE: "1",
    ZCODE_ZAICODE_IDENTITY: "1",
  };
  delete env.TZ;
  delete env.SAIMAIL_WORKSPACE;
  const t0 = Date.now();
  let app;
  let child;
  try {
    app = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env, timeout: 90_000 });
    child = app.process();
    const result = await checkProtrail(app, { timeoutMs: 60_000 });
    console.log(`run ${index}: ProTrail draws on ${result.monitors} monitor(s), lit pixels ${JSON.stringify(result.lit)}, ${((Date.now() - t0) / 1000).toFixed(1)} s after launch`);
    return true;
  } catch (error) {
    console.log(`run ${index}: ${String(error?.message ?? error).split("\n")[0]}`);
    return false;
  } finally {
    if (app) {
      await Promise.race([app.close().catch(() => undefined), sleep(15_000)]);
      if (child && child.exitCode === null) {
        try {
          execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } catch {
          // already gone
        }
      }
    }
    const base = path.resolve(tempBase);
    if (path.resolve(profile).startsWith(`${base}${path.sep}`)) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

(async () => {
  let ok = 0;
  for (let index = 1; index <= repeat; index += 1) if (await once(index)) ok += 1;
  console.log(`${ok} of ${repeat} cold starts drew`);
  process.exitCode = ok === repeat ? 0 : 1;
})();
