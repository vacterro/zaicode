// Real packaged startup acceptance. Seed only disposable saved preferences,
// then close the seeding process before either accepted startup.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { _electron } = require("playwright-core");
const { checkProtrail, readExpectedProtrail } = require("./verify-zaicode-protrail.cjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const KEY = "zaicode-protrail-v1";

async function mainWindow(app) {
  const deadline = Date.now() + 60_000;
  let page;
  while (!page && Date.now() < deadline) {
    page = app
      .windows()
      .find((window) => !window.isClosed() && window.url().includes("/out/renderer/index.html"));
    if (!page) await sleep(200);
  }
  assert.ok(page, "the isolated packaged application opens its main window");
  await page.waitForFunction(() => document.querySelector('[data-workspace-shell="true"]'), null, {
    timeout: 90_000,
  });
  return page;
}

function helpersInProfile(profile) {
  if (process.platform !== "win32") return null;
  const prefix = `${path.resolve(profile, "zaicode-protrail")}${path.sep}`.replaceAll("'", "''");
  const script = `$prefix='${prefix}'; @(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'zaicode-protrail-input-*' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`;
  const raw = execFileSync(
    path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 15_000, windowsHide: true },
  ).trim();
  const result = raw ? JSON.parse(raw) : [];
  return Array.isArray(result) ? result : [result];
}

async function openControls(page) {
  await page.getByTestId("task-settings-button").filter({ visible: true }).click();
  const entry = page.getByTestId("settings-section-nav-zaicodeProtrail");
  await entry.evaluate((node) => {
    const fold = node.closest("details");
    if (fold) fold.open = true;
  });
  await entry.click();
  const master = page.getByRole("checkbox", {
    name: "ProTrail is on (the trail behind the cursor and the click effects)",
    exact: true,
  });
  await master.waitFor();
  return master;
}

async function checkProtrailProfiles({
  executablePath,
  tempBase,
  baseEnv,
  outDir,
  watch,
  closeApp,
}) {
  const receipts = [];
  for (const enabled of [false, true]) {
    const name = enabled ? "enabled" : "disabled";
    const profile = fs.mkdtempSync(path.join(tempBase, `zaicode-protrail-${name}-`));
    const config = readExpectedProtrail(
      JSON.stringify({ enabled, everywhere: true, followCalm: false }),
    );
    const saved = JSON.stringify(config);
    const env = {
      ...baseEnv,
      ZCODE_DESKTOP_APPLICATION_NAME: `ZAICODE ${path.basename(profile)}`,
      ZCODE_DESKTOP_HOME_DIR: profile,
      ZCODE_DESKTOP_USER_DATA_DIR: profile,
      ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, "session"),
      ZCODE_DATA_BASE_DIR: profile,
      ZCODE_HOME: path.join(profile, ".zcode"),
      HOME: profile,
      USERPROFILE: profile,
      APPDATA: path.join(profile, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(profile, "AppData", "Local"),
      ZAICODE_CUSTOMIZATION_DIR: path.join(profile, "customization"),
    };
    fs.writeFileSync(
      path.join(profile, "zaicode-engines.json"),
      JSON.stringify({ keepWindowsRolling: false }),
    );
    let app;
    const launch = async () => {
      app = await _electron.launch({
        executablePath,
        args: [`--user-data-dir=${profile}`],
        cwd: profile,
        env,
        timeout: 90_000,
      });
      app.on("window", watch);
      for (const page of app.windows()) watch(page);
      assert.equal(
        path.resolve(await app.evaluate(({ app }) => app.getPath("userData"))),
        path.resolve(profile),
      );
      return mainWindow(app);
    };
    const receipt = {
      profile: name,
      expectedEnabled: enabled,
      expectedEverywhere: true,
      startup: [],
      restartVerified: false,
      operatorProfileTouched: false,
    };
    try {
      let page = await launch();
      await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
        key: KEY,
        value: saved,
      });
      await closeApp(app);
      app = null;
      // Both accepted starts read an already-saved preference. No toggle or
      // startup override participates in these assertions.
      for (let restart = 0; restart < 2; restart += 1) {
        page = await launch();
        assert.equal(
          await page.evaluate((key) => localStorage.getItem(key), KEY),
          saved,
          `${name} preference survives startup ${restart + 1}`,
        );
        const result = await checkProtrail(app, { page, expectedConfig: config });
        assert.ok(
          result.verification === "VERIFIED" || result.skipped === "no display",
          "a real display is required for packaged enabled acceptance",
        );
        const master = await openControls(page);
        const actualEnabled = await master.isChecked();
        assert.equal(
          actualEnabled,
          enabled,
          "the actual renderer store agrees with the saved expected preference",
        );
        assert.equal(
          await page
            .getByRole("radio", { name: "Everywhere in Windows", exact: true })
            .getAttribute("aria-checked"),
          "true",
        );
        const helpers = enabled ? null : helpersInProfile(profile);
        if (!enabled)
          assert.deepEqual(
            helpers,
            [],
            "no native input helper remains running for a disabled profile",
          );
        receipt.startup.push({ ...result, actualEnabled, nativeHelperPids: helpers });
        if (restart === 0) {
          // Exercise transitions only AFTER proving genuine startup. Finish
          // Off and inspect both overlay ownership and the actual helper.
          for (let turn = 0; turn < 4; turn += 1) {
            await master.setChecked(true);
            await master.setChecked(false);
          }
          await checkProtrail(app, { page, expectedConfig: { ...config, enabled: false } });
          assert.deepEqual(
            helpersInProfile(profile),
            [],
            "rapid switching leaves no native helper orphans",
          );
          await master.setChecked(enabled);
          await checkProtrail(app, { page, expectedConfig: config });
          assert.equal(
            await page.evaluate((key) => localStorage.getItem(key), KEY),
            saved,
            "transition test restores exactly the original disposable setting",
          );
          receipt.rapidTransitions = {
            cycles: 4,
            orphanOverlays: 0,
            orphanHelpers: 0,
            preferenceRestored: true,
          };
        }
        await closeApp(app);
        app = null;
      }
      receipt.restartVerified = true;
      receipts.push(receipt);
    } catch (error) {
      if (outDir && app) {
        const page = app
          .windows()
          .find(
            (window) => !window.isClosed() && window.url().includes("/out/renderer/index.html"),
          );
        if (page)
          await page
            .screenshot({ path: path.join(outDir, `protrail-${name}-failed.png`) })
            .catch(() => undefined);
      }
      receipt.error = String(error?.message ?? error);
      throw error;
    } finally {
      if (outDir)
        fs.writeFileSync(
          path.join(outDir, `protrail-${name}.json`),
          `${JSON.stringify(receipt, null, 2)}\n`,
        );
      if (app) await closeApp(app);
      const resolved = path.resolve(profile);
      assert.ok(
        resolved.startsWith(`${path.resolve(tempBase)}${path.sep}`),
        "only the owned temporary profile may be cleaned",
      );
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  }
  return receipts;
}

module.exports = { checkProtrailProfiles };
