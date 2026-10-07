// T-251 / SRC-163 surface probe: the SRC-151 items whose acceptance is a visible or runtime
// fact (geometry, theme paint, hit-testing, the settings surfaces). A source read cannot settle
// those, so they are driven here on the same staged package as hunt-drive.cjs, with screenshots
// and a machine-readable receipt.
//
// Honesty rules kept from hunt-drive: nothing is force-clicked, no production guard is touched,
// no blind sleep is presented as readiness, and a precondition that is genuinely absent is
// recorded as SKIP with its reason -- never as a pass.
//
// The throw-away profile seeds the sidebar line prefs so the Settings and WORKERS lines exist:
// the production default hides them behind the operator's own layout choice (zaicodeLayoutPrefs),
// which is a preference of the profile, not a code change.
//
// Env: T251_EXE (executable; default staged dist-next), T251_OUT (evidence dir).
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { createRequire } = require("node:module");
const root = "V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE";
const { _electron } = createRequire(path.join(root, "zcode/packages/desktop/package.json"))("playwright-core");
const exe = path.resolve(
  process.env.T251_EXE || path.join(root, "zcode/packages/desktop/dist-next/win-unpacked/ZAICODE.exe"),
);
const out = process.env.T251_OUT || path.join(root, ".saipen/evidence/T-251-src163/packaged");
fs.mkdirSync(out, { recursive: true });

const PROMPT = "Reply with exactly the word LOS and nothing else.";
const SENTINEL = "LOS";

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "zaicode-t251s-"));
const project = path.join(profile, "hunt-project");
fs.mkdirSync(project);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: pass === null ? null : !!pass, ...(detail === undefined ? {} : { detail }) });
  console.error(`${pass === null ? "SKIP" : pass ? "PASS" : "FAIL"} ${name}`);
};
const shot = (page, name) =>
  page.screenshot({ path: path.join(out, "surface-" + name + ".png") }).catch((e) => console.error("shot", name, String(e)));
const settle = (ms) => pause(ms);

function writeReceipt(extra) {
  const receipt = {
    at: new Date().toISOString(),
    driver: "surface-drive.cjs (T-251: SRC-151 items whose acceptance is visible/runtime)",
    executablePath: exe,
    profile,
    checks,
    ...extra,
  };
  try {
    const asar = path.join(path.dirname(exe), "resources/app.asar");
    if (fs.existsSync(asar)) {
      receipt.asarSha256 = crypto.createHash("sha256").update(fs.readFileSync(asar)).digest("hex");
      receipt.asarBytes = fs.statSync(asar).size;
    }
  } catch (e) {
    receipt.asarSha256 = `unreadable: ${String(e)}`;
  }
  receipt.pass = checks.filter((c) => c.pass !== null).every((c) => c.pass) && extra.errors.length === 0;
  fs.writeFileSync(path.join(out, "surface-receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify(
      { pass: receipt.pass, checks: checks.map((c) => `${c.pass === null ? "SKIP" : c.pass ? "PASS" : "FAIL"} ${c.name}`) },
      null,
      1,
    ),
  );
  return receipt;
}

if (!fs.existsSync(exe)) {
  const receipt = {
    at: new Date().toISOString(),
    driver: "surface-drive.cjs",
    executablePath: exe,
    checks,
    errors: [],
    pass: false,
    blocked: "EXECUTABLE_MISSING",
    error: `no packaged executable at ${exe}; stage a build into dist-next first`,
  };
  fs.writeFileSync(path.join(out, "surface-receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ pass: false, blocked: "EXECUTABLE_MISSING", error: receipt.error }));
  process.exit(2);
}

(async () => {
  let app,
    page,
    stage = "boot";
  const errors = [];
  const env = {
    ...process.env,
    ZCODE_ZAICODE_MODE: "1",
    ZAICODE_UPDATES: "off",
    ZCODE_DESKTOP_APPLICATION_NAME: "ZAICODE T251S " + path.basename(profile),
    ZCODE_DESKTOP_HOME_DIR: profile,
    ZCODE_DESKTOP_USER_DATA_DIR: profile,
    ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, "session"),
    ZCODE_DATA_BASE_DIR: profile,
    ZCODE_HOME: path.join(profile, ".zcode"),
    USERPROFILE: profile,
    HOME: profile,
    APPDATA: path.join(profile, "AppData/Roaming"),
    LOCALAPPDATA: path.join(profile, "AppData/Local"),
    ZAICODE_CUSTOMIZATION_DIR: path.join(profile, "customization"),
  };
  delete env.TZ;
  delete env.SAIMAIL_WORKSPACE;
  delete env.ZAICODE_INSTALL_ROOT;
  for (const key of Object.keys(env))
    if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key)) delete env[key];

  try {
    stage = "boot";
    app = await _electron.launch({ executablePath: exe, args: ["--user-data-dir=" + profile], env, timeout: 120000 });
    page = await (async () => {
      const end = Date.now() + 90000;
      while (Date.now() < end) {
        const hit = app.windows().find((w) => w.url().includes("/out/renderer/index.html"));
        if (hit) return hit;
        await pause(100);
      }
      throw new Error("no renderer");
    })();
    page.on("pageerror", (e) => errors.push({ stage, message: String(e).split("\n")[0] }));
    await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 90000 });
    // Profile preferences only: the locale for stable English labels, the sidebar menu lines the
    // operator would tick (the production default hides Settings and WORKERS), and the footer's
    // Usage tool (its footer entry ships hidden; the header one is not rendered in every view).
    await page.evaluate(() => {
      localStorage.setItem("zcode-locale-preference", "en-US");
      localStorage.setItem(
        "zaicode-layout-v1",
        JSON.stringify({
          navItems: [
            { id: "newTask", visible: true },
            { id: "zaicode", visible: true },
            { id: "settings", visible: true },
            { id: "workers", visible: true },
          ],
          footerTools: [
            { id: "settings", visible: true },
            { id: "usage", visible: true },
            { id: "workers", visible: true },
          ],
        }),
      );
    });
    await page.reload();
    await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 90000 });
    await page.setViewportSize({ width: 1280, height: 960 });

    stage = "open project";
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
    }, project);
    await page.getByTestId("project-add").click();
    await page.getByRole("menuitem", { name: "Open folder", exact: true }).click();
    const row = page.locator('[data-testid^="workspace-item"]').filter({ hasText: "hunt-project" }).first();
    await row.waitFor({ state: "visible", timeout: 30000 });
    await row.click();
    await page.locator('[data-testid="v4-composer"]').first().waitFor({ state: "visible", timeout: 60000 });

    // ------------------------------------------------------------------ R038
    // The reported confusion: a project click can land on nothing, so only a session click shows
    // what is going on. Whatever the project click decides, it must be a DEFINED outcome with a
    // usable surface -- a session pane, the new-task screen, or a live draft composer.
    stage = "R038 project click";
    const projectClick = await page.evaluate(() => {
      const pane = document.querySelector('[data-testid^="v4-session-pane"]');
      const composer = document.querySelector('[data-testid="v4-composer"]');
      const rect = composer?.getBoundingClientRect() ?? null;
      return {
        paneSessionId: pane?.getAttribute("data-session-id") ?? null,
        composerVisible: Boolean(composer && rect && rect.width > 0 && rect.height > 0),
        activeElement: document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? null,
      };
    });
    check(
      "R038: a project click lands on a usable surface (session pane or live draft), never a dead window",
      (projectClick.paneSessionId !== null || projectClick.composerVisible) && projectClick.composerVisible,
      projectClick,
    );

    // -------------------------------------------------- one real session to work with
    stage = "create a session";
    const input = page.locator('[data-testid="v4-composer-input"]').first();
    await input.waitFor({ state: "visible", timeout: 60000 });
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-testid="v4-composer-input"]')?.__zcodeLexicalInputE2E),
      null,
      { timeout: 60000 },
    );
    await page.evaluate((text) => {
      document.querySelector('[data-testid="v4-composer-input"]').__zcodeLexicalInputE2E.setText(text);
    }, PROMPT);
    const waitAdmitted = (ms) =>
      page
        .waitForFunction(
          () => {
            const b = document.querySelector('[data-testid="v4-composer-send"]');
            return Boolean(b && !b.hasAttribute("disabled") && b.getAttribute("aria-disabled") !== "true");
          },
          null,
          { timeout: ms },
        )
        .then(() => true)
        .catch(() => false);
    let modelPick = null;
    if (!(await waitAdmitted(15000))) {
      const trigger = page.locator('[data-testid="chat-model-select-trigger"]').first();
      if (await trigger.count()) {
        await trigger.click({ timeout: 15000 }).catch(() => {});
        await settle(800);
        const options = await page.locator('[data-testid^="chat-model-select-item-"]').count();
        if (options > 0)
          await page.locator('[data-testid^="chat-model-select-item-"]').first().click({ timeout: 15000 }).catch(() => {});
        modelPick = { options };
        await settle(900);
      }
    }
    const admitted = await waitAdmitted(120000);
    check("the composer admitted a submission (precondition for the surface items)", admitted, modelPick);
    if (!admitted) throw new Error("ADMISSION_FAILED: no session can be created; surface items not driven");
    await page.locator('[data-testid="v4-composer-send"]').first().click({ timeout: 15000 });
    const answered = await page
      .waitForFunction(
        (s) => {
          const a = document.querySelector('[data-testid="v4-latest-answer"]');
          const id = a?.getAttribute("data-v4-latest-answer-row-id");
          const r = id ? document.querySelector(`[data-row-id="${id}"]`) : null;
          return Boolean(r && (r.innerText || "").includes(s));
        },
        SENTINEL,
        { timeout: 240000 },
      )
      .then(() => true)
      .catch(() => false);
    check("a real session row exists for the surface items (turn answered)", answered);
    const sessionRowId = await page.evaluate(
      () => document.querySelector('[data-testid^="task-item-"]')?.getAttribute("data-testid") ?? null,
    );
    await shot(page, "00-baseline");

    // ------------------------------------------------------------------ R017
    // A repeated click on the sidebar toggle must hide the pane again.
    stage = "R017 sidebar toggle";
    const sidebarProbe = () =>
      page.evaluate(() => {
        const toggle = document.querySelector('[data-testid="desktop-sidebar-toggle"]');
        const pane = document.querySelector("#sidebar") ?? document.querySelector('[data-workspace-sidebar-panel="true"]');
        const rect = pane?.getBoundingClientRect() ?? null;
        return {
          togglePresent: Boolean(toggle),
          ariaExpanded: toggle?.getAttribute("aria-expanded") ?? null,
          paneFound: Boolean(pane),
          paneWidth: rect ? Math.round(rect.width) : 0,
        };
      });
    const before = await sidebarProbe();
    let toggleLocator = page.locator('[data-testid="desktop-sidebar-toggle"]').first();
    if (!(await toggleLocator.count())) toggleLocator = page.locator('button[aria-controls="sidebar"]').first();
    if (!(await toggleLocator.count())) toggleLocator = page.locator('button[aria-label*="sidebar" i]').first();
    const togglePresent = (await toggleLocator.count()) > 0;
    let afterFirst = null,
      afterSecond = null;
    if (togglePresent) {
      await toggleLocator.click({ timeout: 15000 }).catch(() => {});
      await settle(700);
      afterFirst = await sidebarProbe();
      await toggleLocator.click({ timeout: 15000 }).catch(() => {});
      await settle(700);
      afterSecond = await sidebarProbe();
    }
    await shot(page, "01-sidebar-toggle");
    // The collapsed state keeps a narrow rail, so "hidden" is a width threshold, not zero.
    const HIDDEN_PX = 40;
    check(
      "R017: the sidebar toggle both hides the pane and brings it back on the next click",
      !togglePresent
        ? null
        : afterFirst.ariaExpanded !== before.ariaExpanded &&
            afterSecond.ariaExpanded === before.ariaExpanded &&
            (!before.paneFound ||
              ((afterFirst.paneWidth < HIDDEN_PX) !== (before.paneWidth < HIDDEN_PX) &&
                (afterSecond.paneWidth < HIDDEN_PX) === (before.paneWidth < HIDDEN_PX))),
      { reason: togglePresent ? undefined : "no sidebar toggle is rendered in this layout", HIDDEN_PX, before, afterFirst, afterSecond },
    );

    // ------------------------------------------------------------------ R016
    // The archive/cleanup notice must own a bounded workspace row, never cover the sidebar.
    // Production entry point: the project row's "More" menu -> "Archive all sessions"
    // (WorkspaceSidebarItem:1938 trigger, :2062 the item). One dry turn makes the session idle.
    stage = "R016 archive notice";
    const projectRow = page.locator('[data-testid^="workspace-item"]').filter({ hasText: "hunt-project" }).first();
    let archivePath = null;
    if (await projectRow.count()) {
      await projectRow.hover().catch(() => {});
      await settle(400);
      const more = projectRow.locator('button[aria-label="More"]').first();
      if (await more.count()) {
        await more.click({ timeout: 15000 }).catch(() => {});
        await settle(700);
        const archiveItem = page.locator('[role="menuitem"]').filter({ hasText: /Archive all sessions/ }).first();
        if (await archiveItem.count()) {
          await archiveItem.click({ timeout: 15000 }).catch(() => {});
          archivePath = "project-row More -> Archive all sessions";
        } else {
          archivePath = "menu opened, no 'Archive all sessions' item";
          await page.keyboard.press("Escape").catch(() => {});
        }
      } else {
        const sessionRow = sessionRowId ? page.locator(`[data-testid="${sessionRowId}"]`).first() : null;
        if (sessionRow && (await sessionRow.count())) {
          await sessionRow.click({ button: "right", timeout: 15000 }).catch(() => {});
          archivePath = "session row right-click (no More trigger on the project row)";
        }
      }
    }
    const noticeAppeared = await page
      .waitForFunction(() => Boolean(document.querySelector("[data-zaicode-archive-notice]")), null, { timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    await shot(page, "02-archive-notice");
    const geometry = await page.evaluate(() => {
      const notice = document.querySelector("[data-zaicode-archive-notice]");
      if (!notice) return null;
      const n = notice.getBoundingClientRect();
      const pane = document.querySelector("#sidebar") ?? document.querySelector('[data-workspace-sidebar-panel="true"]');
      const s = pane?.getBoundingClientRect() ?? null;
      const overlap = s
        ? !(n.right <= s.left + 1 || n.left >= s.right - 1 || n.bottom <= s.top + 1 || n.top >= s.bottom - 1)
        : null;
      return {
        notice: { left: Math.round(n.left), top: Math.round(n.top), width: Math.round(n.width), height: Math.round(n.height) },
        sidebar: s ? { left: Math.round(s.left), right: Math.round(s.right), width: Math.round(s.width) } : null,
        overlapsSidebar: overlap,
        position: getComputedStyle(notice).position,
        text: (notice.textContent || "").trim().slice(0, 60),
      };
    });
    check(
      "R016: the archive notice keeps its own bounded row and never covers the sidebar",
      noticeAppeared &&
        geometry !== null &&
        geometry.overlapsSidebar === false &&
        geometry.position === "relative" &&
        geometry.notice.height <= 40,
      geometry ?? { reason: "no archive notice appeared", archivePath, sessionRowId },
    );

    // ------------------------------------------------------------------ settings surfaces
    stage = "open settings";
    const navBlock = page.locator("[data-zaicode-nav-block]").first();
    if (await navBlock.count()) await navBlock.hover().catch(() => {});
    await settle(400);
    const settingsLine = page.locator('[data-zaicode-nav-block] button').filter({ hasText: /^Settings$/ }).first();
    const settingsLineFound = await settingsLine.count();
    if (settingsLineFound) await settingsLine.click({ timeout: 15000 }).catch(() => {});
    await page.locator('[data-settings-content-frame="true"]').first().waitFor({ timeout: 30000 }).catch(() => {});
    await settle(900);
    const settingsOpen = await page.locator('[data-settings-content-frame="true"]').count();
    await shot(page, "03-settings");

    // Leaving Settings is the same nav line again (its hint: "inside Settings: back to the
    // workspace"). The sidebar toggle does NOT close Settings, and while Settings is open the
    // workspace subtree is inert -- computed `pointer-events: none` -- so a composer, a header tool
    // or the workers dock cannot be clicked at all until this returns true.
    // Leaving Settings: the Settings page is a route in the shell, and while it is open the
    // workspace subtree is inert (computed `pointer-events: none`), so a composer, a header tool or
    // the workers dock cannot be clicked at all until this returns true. Clicking the nav line again
    // is tried first; if the page is still up, the shell is reloaded -- the same throw-away profile,
    // back on the workspace -- rather than pretending a swallowed click was an effect.
    const leaveSettings = async () => {
      if ((await page.locator('[data-settings-content-frame="true"]').count()) === 0) return true;
      await settingsLine.click({ timeout: 8000 }).catch(() => {});
      await settle(900);
      if ((await page.locator('[data-settings-content-frame="true"]').count()) === 0) return true;
      await page.reload().catch(() => {});
      await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 90000 }).catch(() => {});
      await settle(2500);
      return (await page.locator('[data-settings-content-frame="true"]').count()) === 0;
    };

    // R027 -- the low-priority extras stay folded, so the first screen is the useful one.
    const advancedProbe = await page.evaluate(() => {
      const folds = Array.from(document.querySelectorAll("[data-zaicode-settings-advanced]")).map((el) =>
        el.getAttribute("data-zaicode-settings-advanced"),
      );
      const saiasuiVisible = Array.from(document.querySelectorAll("h1,h2,h3,label,span,button")).some(
        (el) => /SAIASUI/i.test(el.textContent || "") && el.offsetParent !== null && el.getBoundingClientRect().height > 0,
      );
      const nav = document.querySelector('[data-testid="settings-section-search"]')?.closest("nav");
      const topRows = nav
        ? Array.from(nav.querySelectorAll("button"))
            .slice(0, 6)
            .map((el) => (el.textContent || "").trim().slice(0, 32))
        : [];
      return { foldStates: folds, saiasuiVisible, topRows, sections: nav ? nav.querySelectorAll("button").length : 0 };
    });
    check(
      "R027: the low-priority extras are folded by default (SAIASUI does not greet the operator)",
      settingsOpen > 0 &&
        advancedProbe.foldStates.length > 0 &&
        advancedProbe.foldStates.every((s) => s === "closed") &&
        !advancedProbe.saiasuiVisible,
      { settingsOpen, settingsLineFound, ...advancedProbe },
    );

    // Walk the real section list (testId(TID_SETTINGS_SECTION_NAV, id)) to find the section that
    // hosts the presentation picker and one that renders sliders. Only section buttons are clicked,
    // never the nav's external-link rows. The theme picker lives in an advanced section
    // (settingsPageConfig: advancedSections, folded by default -- R027), so the folds open first;
    // R027 was already measured before this point.
    stage = "R022 presentation";
    const foldSummaries = page.locator("details[data-zaicode-settings-advanced] > summary");
    const foldCount = await foldSummaries.count();
    for (let i = 0; i < foldCount; i += 1) {
      await foldSummaries.nth(i).click({ timeout: 8000 }).catch(() => {});
      await settle(300);
    }
    const sectionButtons = page.locator('[data-testid^="settings-section-nav-"]');
    const sectionCount = await sectionButtons.count();
    const walked = [];
    let presetsSection = null,
      rangesSection = null;
    for (let i = 0; i < sectionCount && (presetsSection === null || rangesSection === null); i += 1) {
      // A re-render can re-fold the advanced group, so the fold opens again before every step.
      const closedFold = page.locator("details[data-zaicode-settings-advanced]:not([open]) > summary").first();
      if (await closedFold.count()) {
        await closedFold.click({ timeout: 8000 }).catch(() => {});
        await settle(300);
      }
      const id = await sectionButtons.nth(i).getAttribute("data-testid");
      await sectionButtons.nth(i).click({ timeout: 15000 }).catch(() => {});
      await settle(450);
      const found = await page.evaluate(() => ({
        presets: document.querySelectorAll("[data-zaicode-style-preset]").length,
        ranges: Array.from(document.querySelectorAll('input[type="range"]')).filter(
          (el) => el.offsetParent !== null && el.getBoundingClientRect().height > 0,
        ).length,
      }));
      walked.push({ index: i, id, ...found });
      if (presetsSection === null && found.presets >= 2) presetsSection = { index: i, id, ...found };
      if (rangesSection === null && found.ranges > 0) rangesSection = { index: i, id, ...found };
    }

    let presets = [];
    let repaint = null;
    if (presetsSection) {
      await sectionButtons.nth(presetsSection.index).click({ timeout: 15000 }).catch(() => {});
      await settle(500);
      presets = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-zaicode-style-preset]")).map((el) => ({
          id: el.getAttribute("data-zaicode-style-preset"),
          checked: el.getAttribute("aria-checked"),
          label: (el.textContent || "").trim(),
        })),
      );
      const sample = () =>
        page.evaluate(() => {
          const button =
            document.querySelector('[data-zaicode-style-preset][aria-checked="true"]') ?? document.querySelector("button");
          const style = button ? getComputedStyle(button) : null;
          return {
            root: document.documentElement.dataset.zaicodeStyle ?? null,
            boxShadow: style?.boxShadow ?? null,
            borderRadius: style?.borderRadius ?? null,
          };
        });
      const classic = await sample();
      await page.locator('[data-zaicode-style-preset="flat"]').first().click({ timeout: 15000 }).catch(() => {});
      await settle(600);
      const flat = await sample();
      await shot(page, "04-presentation-flat");
      await page.locator('[data-zaicode-style-preset="classic"]').first().click({ timeout: 15000 }).catch(() => {});
      await settle(600);
      repaint = { classic, flat, restored: await sample() };
    }
    check(
      "R022: the presentation picker offers the non-bevel variants and switching one really repaints",
      presets.length >= 4 &&
        repaint !== null &&
        repaint.flat.root === "flat" &&
        repaint.flat.boxShadow === "none" &&
        repaint.flat.borderRadius === "0px",
      { presets: presets.map((p) => p.id), repaint, presetsSection, walked },
    );

    // R034 -- native controls carry the theme tint, not a white native control.
    let tintProbe = { rangeCount: 0, reason: "no settings section rendered a visible slider" };
    if (rangesSection) {
      await sectionButtons.nth(rangesSection.index).click({ timeout: 15000 }).catch(() => {});
      await settle(500);
      tintProbe = await page.evaluate(() => {
        const ranges = Array.from(document.querySelectorAll('input[type="range"]')).filter(
          (el) => el.offsetParent !== null && el.getBoundingClientRect().height > 0,
        );
        const first = ranges[0] ?? null;
        return {
          rangeCount: ranges.length,
          accentColor: first ? getComputedStyle(first).accentColor : null,
          colorScheme: first ? getComputedStyle(first).colorScheme : null,
          rootColorScheme: document.documentElement.style.colorScheme || null,
        };
      });
      await shot(page, "05-slider-tint");
    }
    check(
      "R034: range sliders take the palette tint and a dark color-scheme, never a white native control",
      tintProbe.rangeCount === 0
        ? null
        : tintProbe.accentColor !== null &&
            tintProbe.accentColor !== "rgb(255, 255, 255)" &&
            /dark/.test(String(tintProbe.colorScheme)),
      tintProbe,
    );

    // R030 -- the search box filters the section list and Enter jumps into the hit.
    stage = "R030 settings search";
    const searchBox = page.locator('[data-testid="settings-section-search"]').first();
    const searchPresent = await searchBox.count();
    let searchBefore = null,
      searchAfter = null,
      jumped = null;
    if (searchPresent) {
      searchBefore = await sectionButtons.count();
      await searchBox.fill("usage").catch(() => {});
      await settle(800);
      searchAfter = await sectionButtons.count();
      await shot(page, "06-settings-search");
      await page.keyboard.press("Enter").catch(() => {});
      await settle(1000);
      jumped = await page.evaluate(
        () => document.querySelector('[data-testid^="settings-section-nav-"][aria-current="page"]')?.textContent?.trim() ?? null,
      );
    }
    check(
      "R030: the settings search filters the section list and Enter jumps into the hit",
      searchPresent > 0 && searchAfter !== null && searchAfter < searchBefore && jumped !== null,
      { searchPresent, searchBefore, searchAfter, jumped },
    );

    // R028 -- usage meter: selectable refresh, resizable name column, no useless Done word.
    // It is a main view (WorkspaceShellLayout: `isWorkspaceVisible && usageMode === "page"`), opened
    // by the header tool whose title -- and therefore aria-label -- is "9router Usage · right-click:
    // sidebar" (ZaicodeCommonTools: usage case; ZAICODE_HEADER_TOOLS lists it visible by default).
    // That branch only renders with the workspace on screen, so Settings is closed first: the
    // operator clicks this tool from the workspace, not from inside Settings.
    stage = "R028 usage meter";
    const leftSettingsForUsage = await leaveSettings();
    const usageSelector = 'button[aria-label^="9router Usage"], button[title^="9router Usage"]';
    const usageTool = page.locator(usageSelector).first();
    const usageCandidates = await page.locator(usageSelector).count();
    let usageClickError = null;
    let usageOpened = false;
    if (usageCandidates) {
      await usageTool.click({ timeout: 15000 }).catch((e) => {
        usageClickError = String(e).slice(0, 200);
      });
      await settle(1200);
      usageOpened = await page.evaluate(() => Boolean(document.querySelector("[data-zaicode-usage]")));
    }
    const usageProbe = await page.evaluate(() => {
      const view = document.querySelector("[data-zaicode-usage]");
      const refresh = document.querySelector("[data-zaicode-usage-refresh]");
      const options = refresh ? Array.from(refresh.querySelectorAll("option")).map((o) => o.getAttribute("value")) : null;
      const resize = document.querySelector("[data-zaicode-usage-column-resize]");
      const doneCells = Array.from(document.querySelectorAll("[data-zaicode-usage] *"))
        .map((el) => (el.childElementCount === 0 ? (el.textContent || "").trim() : ""))
        .filter((t) => t === "Done");
      return {
        viewPresent: Boolean(view),
        usageMode: view?.getAttribute("data-zaicode-usage") ?? null,
        refreshLabel: refresh?.getAttribute("aria-label") ?? null,
        options,
        resizeHandle: Boolean(resize),
        doneCells: doneCells.length,
      };
    });
    await shot(page, "07-usage-meter");
    check(
      "R028: the usage meter offers 10/5/3/2/1s live refresh, keeps a resizable name column and has no bare Done word",
      usageProbe.viewPresent
        ? JSON.stringify(usageProbe.options) === JSON.stringify(["10", "5", "3", "2", "1"]) &&
            usageProbe.resizeHandle &&
            usageProbe.doneCells === 0
        : null,
      usageProbe.viewPresent
        ? usageProbe
        : {
            reason: "the usage view was not opened by this probe",
            usageOpened,
            usageCandidates,
            usageClickError,
            leftSettingsForUsage,
            ...usageProbe,
          },
    );
    if (usageOpened) {
      await usageTool.click({ timeout: 15000 }).catch(() => {});
      await settle(600);
    }

    // ------------------------------------------------------------------ R031
    // WORKERS panel: every visible control must be hit-testable and labelled.
    stage = "R031 workers controls";
    const leftSettingsForWorkers = await leaveSettings();
    // The dock also has a sidebar menu line (only when the operator ticks it) and the production
    // hotkey for it (zaicodeHotkeys: ui.workers, default Alt+W). Either may be used.
    const workersLine = page.locator('[data-zaicode-nav-block] button').filter({ hasText: /^WORKERS$/ }).first();
    const workersLineFound = await workersLine.count();
    // R031's operator complaint is that the controls "do not work and do not react at all", so the
    // honest probe presses them and reads the panel's own state projection, instead of merely
    // hit-testing geometry (a docked panel can sit partly outside the viewport, which is a probe
    // artefact, not a dead button).
    const openWorkersDock = async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await page.keyboard.press("Alt+w").catch(() => {});
        if (attempt > 1) {
          await page.locator("[data-zaicode-nav-block]").first().hover().catch(() => {});
          await settle(350);
          if (workersLineFound) await workersLine.click({ timeout: 15000 }).catch(() => {});
        }
        await settle(1000);
        if (await page.evaluate(() => Boolean(document.querySelector("[data-zaicode-workers-panel]")))) return true;
      }
      return false;
    };
    const panelAttrs = () =>
      page.evaluate(() => {
        const panel = document.querySelector("[data-zaicode-workers-panel]");
        if (!panel) return null;
        const buttons = Array.from(panel.querySelectorAll("button")).filter((b) => b.offsetParent !== null);
        const viewport = { w: window.innerWidth, h: window.innerHeight };
        const onScreen = [];
        const covered = [];
        const outside = [];
        const unlabelled = [];
        for (const b of buttons) {
          const label = (b.getAttribute("title") || b.getAttribute("aria-label") || b.textContent || "").trim();
          if (!label) unlabelled.push((b.textContent || "").trim().slice(0, 30));
          const r = b.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const inside = cx >= 0 && cy >= 0 && cx <= viewport.w && cy <= viewport.h;
          if (!inside) {
            outside.push(label.slice(0, 40));
            continue;
          }
          const hit = document.elementFromPoint(cx, cy);
          // A button with an icon renders a child at its centre, so `hit` is normally a descendant.
          if (hit === b || (hit && b.contains(hit))) onScreen.push(label.slice(0, 40));
          else covered.push({ label: label.slice(0, 40), by: hit ? hit.tagName + "." + (hit.className || "").toString().slice(0, 40) : "null" });
        }
        const box = panel.getBoundingClientRect();
        return {
          layout: panel.getAttribute("data-zaicode-workers-panel"),
          collapsed: panel.getAttribute("data-zaicode-workers-panel-collapsed"),
          buttons: buttons.length,
          onScreen,
          covered,
          outside,
          unlabelled,
          box: { l: Math.round(box.left), t: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) },
          viewport,
        };
      });
    let workersOpen = await openWorkersDock();
    const beforeAttrs = await panelAttrs();
    let tabsFlip = null;
    let collapseFlip = null;
    let maximizeBack = null;
    const pressErrors = {};
    const press = async (key, locator) => {
      if (!(await locator.count())) {
        pressErrors[key] = "not found";
        return;
      }
      try {
        await locator.click({ timeout: 8000 });
      } catch (e) {
        pressErrors[key] = String(e).split("\n")[0].slice(0, 160);
      }
      await settle(500);
    };
    if (workersOpen) {
      const tabsButton = page.locator('[data-zaicode-workers-panel] [aria-label^="Tabs:"], [data-zaicode-workers-panel] [title^="Tabs:"]').first();
      const splitButton = page.locator('[data-zaicode-workers-panel] [aria-label^="Split:"], [data-zaicode-workers-panel] [title^="Split:"]').first();
      await press("tabs", tabsButton);
      tabsFlip = await page.evaluate(() =>
        document.querySelector("[data-zaicode-workers-panel]")?.getAttribute("data-zaicode-workers-panel"),
      );
      await press("split", splitButton);
      const collapseButton = page.locator('[data-zaicode-workers-panel] [aria-label^="Collapse the panel"], [data-zaicode-workers-panel] [title^="Collapse the panel"]').first();
      const maximizeButton = page.locator('[data-zaicode-workers-panel] [aria-label^="Maximize the panel"], [data-zaicode-workers-panel] [title^="Maximize the panel"]').first();
      await press("collapse", collapseButton);
      collapseFlip = await page.evaluate(() =>
        document.querySelector("[data-zaicode-workers-panel]")?.getAttribute("data-zaicode-workers-panel-collapsed"),
      );
      await press("maximize", maximizeButton);
      maximizeBack = await page.evaluate(() =>
        document.querySelector("[data-zaicode-workers-panel]")?.getAttribute("data-zaicode-workers-panel-collapsed"),
      );
    }
    const afterAttrs = await panelAttrs();
    await shot(page, "08-workers");
    const controlsReact =
      (tabsFlip === "tabs" || tabsFlip === null) && collapseFlip === "true" && maximizeBack === "false";
    // Both R028 and R031 report "the control does not react", and Playwright's own click timed out
    // for every one of them. Before that is called a product defect, say WHICH element actually
    // owns the point: a control under an overlay is unreachable for the mouse (the operator's
    // complaint), while a control merely outside a scroll viewport is a probe limit.
    stage = "R028/R031 overlap diagnostics";
    const overlapProbe = await page.evaluate(() => {
      const describe = (el) => {
        if (!el || el.nodeType !== 1) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const path = [];
        for (let n = el; n && n.nodeType === 1 && path.length < 7; n = n.parentElement) {
          path.push(
            n.tagName.toLowerCase() +
              (n.getAttribute("data-testid") ? "[" + n.getAttribute("data-testid") + "]" : "") +
              (n.getAttribute("data-zaicode-workers-panel") ? "[workers-panel]" : ""),
          );
        }
        return {
          tag: el.tagName,
          label: (el.getAttribute("title") || el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 60),
          rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          z: cs.zIndex,
          position: cs.position,
          pointerEvents: cs.pointerEvents,
          appRegion: cs.webkitAppRegion || cs.getPropertyValue("-webkit-app-region") || null,
          path,
        };
      };
      const centre = (el) => {
        const r = el.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
      };
      const panel = document.querySelector("[data-zaicode-workers-panel]");
      const unreachable = [];
      let reachable = 0;
      if (panel) {
        for (const b of Array.from(panel.querySelectorAll("button")).filter((x) => x.offsetParent !== null)) {
          const r = b.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const [cx, cy] = centre(b);
          const hit = document.elementFromPoint(cx, cy);
          if (hit && (hit === b || b.contains(hit))) {
            reachable += 1;
            continue;
          }
          unreachable.push({ button: describe(b), hit: describe(hit), outsideViewport: cx > innerWidth || cy > innerHeight || cx < 0 || cy < 0 });
        }
      }
      const usage = document.querySelector('button[aria-label^="9router Usage"], button[title^="9router Usage"]');
      let usageTool = null;
      if (usage) {
        usageTool = { button: describe(usage), hit: describe(document.elementFromPoint(...centre(usage))) };
      }
      const dragRegions = [];
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const a = getComputedStyle(el).webkitAppRegion || getComputedStyle(el).getPropertyValue("-webkit-app-region");
        if (a && a !== "no-drag") {
          dragRegions.push(describe(el));
          if (dragRegions.length >= 5) break;
        }
      }
      return { viewport: { w: innerWidth, h: innerHeight }, panel: describe(panel), reachable, unreachable, usageTool, dragRegions };
    });
    check(
      "R031: the WORKERS panel controls react (layout flip and collapse flip both take effect)",
      !workersOpen || beforeAttrs === null
        ? null
        : Boolean(controlsReact && beforeAttrs.buttons > 0 && beforeAttrs.unlabelled.length === 0),
      {
        workersOpen,
        workersLineFound,
        leftSettingsForWorkers,
        pressErrors,
        beforeAttrs,
        afterAttrs,
        tabsFlip,
        collapseFlip,
        maximizeBack,
        overlapProbe,
        reason: workersOpen ? undefined : "the WORKERS dock was not opened by this probe",
      },
    );
    if (workersOpen) {
      await page.keyboard.press("Alt+w").catch(() => {});
      await settle(500);
    }

    // ------------------------------------------------------------------ R004
    // Malformed maximize: the maximized window must land on the display work area.
    stage = "R004 maximize geometry";
    let maximizeProbe = null;
    try {
      maximizeProbe = await app.evaluate(({ BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return { error: "no window" };
        const before = win.getBounds();
        win.maximize();
        const after = win.getBounds();
        const work = screen.getDisplayMatching(after).workArea;
        win.unmaximize();
        const restored = win.getBounds();
        const fits =
          after.x >= work.x - 2 &&
          after.y >= work.y - 2 &&
          after.x + after.width <= work.x + work.width + 2 &&
          after.y + after.height <= work.y + work.height + 2;
        return { before, after, work, fits, restored };
      });
    } catch (error) {
      maximizeProbe = { error: String(error).slice(0, 200) };
    }
    check(
      "R004: a maximized window lands inside the display work area (not over the taskbar or off-screen)",
      maximizeProbe && maximizeProbe.error ? null : Boolean(maximizeProbe && maximizeProbe.fits),
      maximizeProbe,
    );

    await settle(300);
    check("zero renderer exceptions", errors.length === 0, errors);
    writeReceipt({ errors, stage: "done" });
    if (!checks.filter((c) => c.pass !== null).every((c) => c.pass) || errors.length) process.exitCode = 1;
  } catch (error) {
    if (page) await shot(page, "error");
    writeReceipt({ errors, stage, error: String(error.stack || error) });
    console.error("ERROR at", stage, String(error));
    process.exitCode = 1;
  } finally {
    if (app)
      try {
        await app.close();
      } catch {}
  }
})();
