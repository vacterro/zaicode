// T-251 / SRC-163 SAIHUNT packaged probe.
//
// Throw-away profile, staged dist-next build, one real SAIFREN turn. Three rules this
// driver obeys, because the earlier packaged runs broke all three:
//
//   1. ADMISSION IS PROVEN, NOT ASSUMED. The prompt goes through the canonical Lexical
//      E2E bridge on `[data-testid="v4-composer-input"]` (real editor state, not DOM
//      paint), then the driver WAITS for `[data-testid="v4-composer-send"]` to lose its
//      `disabled` attribute. No blind sleep is treated as readiness, nothing is
//      force-clicked, and a disabled button aborts the run with diagnostics instead of
//      being worked around.
//   2. THE TURN PROOF IS AUTHORITY-BOUND. "A real turn completed" is not a regex over
//      `[data-row-id]`. It reads the production anchors the turn-nav strip derives from
//      the live render units (`v4-latest-user` / `v4-latest-answer`), requires the exact
//      sent prompt inside the user bubble of that very row, requires a DISTINCT later
//      row inside the same timeline carrying the sentinel, and requires both rows and the
//      session title to survive a navigation away and back.
//   3. NOTHING DOWNSTREAM RUNS ON A FAILED PREMISE. R009/R020/R036 are only driven after
//      the turn proof holds.
//
// Env: T251_EXE (executable, default staged dist-next), T251_OUT (evidence dir).
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { createRequire } = require("node:module");
const root = "V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE";
const { _electron } = createRequire(path.join(root, "zcode/packages/desktop/package.json"))(
  "playwright-core",
);
const exe = path.resolve(
  process.env.T251_EXE ||
    path.join(root, "zcode/packages/desktop/dist-next/win-unpacked/ZAICODE.exe"),
);
const out = process.env.T251_OUT || path.join(root, ".saipen/evidence/T-251-src163/packaged");
fs.mkdirSync(out, { recursive: true });

const PROMPT = "Reply with exactly the word ZUBR and nothing else.";
const SENTINEL = "ZUBR";
/** Second, cheap turn used only to produce a completion while the operator is elsewhere (R036). */
const PROMPT_2 = "Reply with exactly the word BOBR and nothing else.";
const SENTINEL_2 = "BOBR";

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "zaicode-t251-"));
const project = path.join(profile, "hunt-project");
const idleProject = path.join(profile, "hunt-idle");
fs.mkdirSync(project);
fs.mkdirSync(idleProject);
fs.writeFileSync(path.join(profile, "zaicode-engines.json"), JSON.stringify({ keepWindowsRolling: false }));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: pass === null ? null : !!pass, ...(detail === undefined ? {} : { detail }) });
  console.error(`${pass === null ? "SKIP" : pass ? "PASS" : "FAIL"} ${name}`);
};
const shot = (page, name) =>
  page.screenshot({ path: path.join(out, name + ".png") }).catch((e) => console.error("shot", name, String(e)));
const settle = (ms) => pause(ms);

function writeReceipt(extra) {
  const receipt = {
    at: new Date().toISOString(),
    driver: "hunt-drive.cjs (T-251 repaired: canonical composer bridge, bounded admission, authority-bound turn proof)",
    executablePath: exe,
    profile,
    prompt: PROMPT,
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
  fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(
    JSON.stringify({ pass: receipt.pass ?? null, checks: checks.map((c) => `${c.pass === null ? "SKIP" : c.pass ? "PASS" : "FAIL"} ${c.name}`) }, null, 1),
  );
  return receipt;
}

if (!fs.existsSync(exe)) {
  writeReceipt({
    pass: false,
    blocked: "EXECUTABLE_MISSING",
    error: `no packaged executable at ${exe}; stage a build into dist-next first (pnpm run bundle:zaicode)`,
  });
  process.exit(2);
}

/** Everything needed to explain a composer that refused admission. Read from production DOM only. */
const admissionDiagnostics = (page) =>
  page.evaluate(() => {
    const text = (el) => (el ? (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() : "");
    const attributes = (el, prefix) =>
      el
        ? Object.fromEntries(
            Array.from(el.attributes)
              .filter((a) => a.name.startsWith(prefix))
              .map((a) => [a.name, a.value]),
          )
        : null;
    const input = document.querySelector('[data-testid="v4-composer-input"]');
    const send = document.querySelector('[data-testid="v4-composer-send"]');
    const pre = Array.from(document.querySelectorAll('[data-zaicode-pre-conditions], [data-pre-conditions]')).map((el) => attributes(el, "data-"));
    return {
      composerText: text(input),
      composerPresent: Boolean(input),
      lexicalBridgeReady: Boolean(input && input.__zcodeLexicalInputE2E),
      sendButton: send
        ? {
            disabled: send.hasAttribute("disabled"),
            ariaDisabled: send.getAttribute("aria-disabled"),
            ariaLabel: send.getAttribute("aria-label"),
            pointerEvents: getComputedStyle(send).pointerEvents,
            opacity: getComputedStyle(send).opacity,
          }
        : null,
      modelConfig: attributes(document.querySelector('[data-testid="v4-model-config"]'), "data-"),
      modelTrigger: (() => {
        const t = document.querySelector('[data-testid="chat-model-select-trigger"]');
        return t
          ? {
              present: true,
              value: t.getAttribute("data-model-current-value"),
              label: text(t),
              title: t.querySelector("span")?.getAttribute("title") ?? null,
              ariaLabel: t.getAttribute("aria-label"),
            }
          : { present: false };
      })(),
      sessionTitle: text(document.querySelector('[data-testid="v4-session-title"]')) || null,
      transcriptRows: document.querySelectorAll("[data-row-id]").length,
      bannerText: Array.from(document.querySelectorAll('[role="alert"], [role="status"], [aria-live]'))
        .map((el) => text(el))
        .filter((t) => t.length > 0)
        .slice(0, 8),
      visibleConfigControls: Array.from(
        document.querySelectorAll('[data-testid="v4-model-config"], [data-composer-leading-actions], [data-composer-trailing-actions]'),
      ).length,
      preConditions: pre,
    };
  });

(async () => {
  let app,
    page,
    stage = "boot";
  const errors = [];
  const env = {
    ...process.env,
    ZCODE_ZAICODE_MODE: "1",
    ZAICODE_UPDATES: "off",
    ZCODE_DESKTOP_APPLICATION_NAME: "ZAICODE T251 " + path.basename(profile),
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
    if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key))
      delete env[key];

  try {
    stage = "boot";
    app = await _electron.launch({
      executablePath: exe,
      args: ["--user-data-dir=" + profile],
      env,
      timeout: 120000,
    });
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
    await page.evaluate(() => localStorage.setItem("zcode-locale-preference", "en-US"));
    await page.reload();
    await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 90000 });
    await page.setViewportSize({ width: 959, height: 1060 });

    const openFolder = async (folder, label) => {
      await app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
      }, folder);
      await page.getByTestId("project-add").click();
      await page.getByRole("menuitem", { name: "Open folder", exact: true }).click();
      const row = page.locator('[data-testid^="workspace-item"]').filter({ hasText: label }).first();
      await row.waitFor({ state: "visible", timeout: 30000 });
      return row;
    };

    stage = "open project";
    // A second, never-run project is opened first so R036 has an honest inactive control
    // row to compare against instead of assuming "other rows look different".
    const idleRow = await openFolder(idleProject, "hunt-idle");
    const row = await openFolder(project, "hunt-project");
    await row.click();
    await page.locator('[data-testid="v4-composer"]').first().waitFor({ state: "visible", timeout: 60000 });

    // ---------------------------------------------------------------- admission
    stage = "composer admission";
    const input = page.locator('[data-testid="v4-composer-input"]').first();
    await input.waitFor({ state: "visible", timeout: 60000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="v4-composer-input"]');
        return Boolean(el && el.__zcodeLexicalInputE2E);
      },
      null,
      { timeout: 60000 },
    );
    const bridgeAttached = await page.evaluate(
      () =>
        document.querySelector('[data-testid="v4-composer-input"]')?.getAttribute("data-e2e-lexical-bridge") ??
        null,
    );
    check("the v4 composer exposes its canonical E2E bridge", bridgeAttached === "ready", bridgeAttached);

    // Real Lexical state, so `hasDraftToSubmit` is true for the same reason a keystroke
    // would make it true -- this is the defect hunt's whole point, not a DOM shortcut.
    await page.evaluate((text) => {
      document.querySelector('[data-testid="v4-composer-input"]').__zcodeLexicalInputE2E.setText(text);
    }, PROMPT);
    const textLanded = await page
      .waitForFunction(
        (t) => {
          const el = document.querySelector('[data-testid="v4-composer-input"]');
          return Boolean(el && (el.innerText || "").includes(t));
        },
        SENTINEL,
        { timeout: 20000 },
      )
      .then(() => true)
      .catch(() => false);
    check("the probe prompt landed in the composer's own Lexical state", textLanded);

    const send = page.locator('[data-testid="v4-composer-send"]').first();
    await send.waitFor({ state: "visible", timeout: 30000 });
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

    // Admission is `createComposerSubmissionConfig`: it returns null until a provider+model is
    // resolved for this draft. A throw-away profile can come up with the selection still empty,
    // so the driver does exactly what the operator does -- pick a model in the product's own
    // selector. Nothing is force-clicked and no production gate is touched: if the product
    // offers no model to pick, that IS the finding and the run stops below with diagnostics.
    let modelPick = null;
    if (!(await waitAdmitted(15000))) {
      const trigger = page.locator('[data-testid="chat-model-select-trigger"]').first();
      if (await trigger.count()) {
        const valueBefore = await trigger.getAttribute("data-model-current-value").catch(() => null);
        await trigger.click({ timeout: 15000 }).catch(() => {});
        await settle(800);
        const options = await page.locator('[data-testid^="chat-model-select-item-"]').count();
        let chosen = null;
        if (options > 0) {
          const option = page.locator('[data-testid^="chat-model-select-item-"]').first();
          chosen = await option.getAttribute("data-testid").catch(() => null);
          await option.click({ timeout: 15000 }).catch(() => {});
        } else {
          await page.keyboard.press("Escape").catch(() => {});
        }
        await settle(900);
        modelPick = { valueBefore, options, chosen };
      } else {
        modelPick = { triggerMissing: true };
      }
    }
    const admitted = await waitAdmitted(120000);
    const admission = await admissionDiagnostics(page);
    check("the composer reached send-ready admission within 120s (no force, no sleep proof)", admitted, {
      ...admission,
      modelPick,
    });
    await shot(page, "00-admission");
    if (!admitted) {
      // A disabled send button is evidence, not an obstacle: stop here and keep the receipt
      // honest instead of driving R009/R020/R036 on a conversation that never existed.
      throw new Error(`ADMISSION_FAILED: composer never became send-ready -- ${JSON.stringify(admission)}`);
    }

    stage = "send";
    await send.click({ timeout: 15000 });
    const userAnchorAppeared = await page
      .waitForFunction(
        () => Boolean(document.querySelector('[data-testid="v4-latest-user"]')),
        null,
        { timeout: 60000 },
      )
      .then(() => true)
      .catch(() => false);
    check("the sent prompt produced a real user anchor", userAnchorAppeared);

    // ------------------------------------------------------- authority-bound proof
    stage = "authority-bound turn proof";
    const answered = await page
      .waitForFunction(
        (sentinel) => {
          const a = document.querySelector('[data-testid="v4-latest-answer"]');
          const rowId = a?.getAttribute("data-v4-latest-answer-row-id");
          const row = rowId ? document.querySelector(`[data-row-id="${rowId}"]`) : null;
          return Boolean(row && (row.innerText || "").includes(sentinel));
        },
        SENTINEL,
        { timeout: 240000 },
      )
      .then(() => true)
      .catch(() => false);
    await settle(1000);

    const readProof = () =>
      page.evaluate(
        ({ prompt, sentinel }) => {
          const flat = (el) => (el ? (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() : "");
          const strip = document.querySelector('[data-v4-turn-nav-strip="true"]');
          const u = document.querySelector('[data-testid="v4-latest-user"]');
          const a = document.querySelector('[data-testid="v4-latest-answer"]');
          const timeline = document.querySelector('[data-testid="v4-timeline"]');
          const rowOf = (id) => (id === null || id === undefined ? null : document.querySelector(`[data-row-id="${id}"]`));
          const uRowId = u?.getAttribute("data-v4-latest-user-row-id") ?? null;
          const aRowId = a?.getAttribute("data-v4-latest-answer-row-id") ?? null;
          const uRow = rowOf(uRowId);
          const aRow = rowOf(aRowId);
          const bubble = uRow?.querySelector('[data-v4-user-input-bubble="true"]') ?? null;
          // The operator's own prompt is the body the product renders FOR it; the Auto-Goal
          // mark (SRC-151:R006) is a sibling chip inside the same bubble and is deliberately
          // not part of that body. Reading the whole bubble would count the mark as text.
          const operatorBody = bubble?.querySelector('[data-v4-user-input-collapsible-content="true"]') ?? null;
          const goalChip = bubble?.querySelector('[data-zaicode-auto-goal-chip="true"]') ?? null;
          const title = document.querySelector('[data-testid="v4-session-title"]');
          // The pane's own session projection: `draft` before promotion, the real session id
          // after it (SessionPane root, data-session-id).
          const pane = document.querySelector('[data-testid^="v4-session-pane"]');
          return {
            userRowId: uRowId,
            answerRowId: aRowId,
            userIdentity: u?.getAttribute("data-v4-latest-user-identity") ?? null,
            answerIdentity: a?.getAttribute("data-v4-latest-answer-identity") ?? null,
            bubbleText: flat(operatorBody),
            bubbleWholeText: flat(bubble),
            goalChipText: goalChip ? flat(goalChip) : null,
            bubbleMatchesPrompt: flat(operatorBody) === prompt,
            answerCarriesSentinel: flat(aRow).includes(sentinel),
            answerRowIsNotAUserRow: Boolean(aRow) && !aRow.querySelector('[data-v4-user-input-bubble="true"]'),
            answerRowIsLaterInTheSameTimeline:
              Boolean(timeline && uRow && aRow) &&
              timeline.contains(uRow) &&
              timeline.contains(aRow) &&
              Number(aRowId) > Number(uRowId),
            bothChipsFromOneStrip: Boolean(strip && u && a),
            sessionId: pane?.getAttribute("data-session-id") ?? null,
            sessionPanePresent: pane !== null,
            sessionTitlePresent: title !== null,
            sessionTitleAttr: title?.getAttribute("data-title") ?? null,
            sessionTitle: flat(title) || null,
            transcriptRows: document.querySelectorAll("[data-row-id]").length,
          };
        },
        { prompt: PROMPT, sentinel: SENTINEL },
      );

    const proof = await readProof();
    check("a settled assistant answer carries the sentinel", answered, { answerRowId: proof.answerRowId });
    check(
      "the exact sent prompt sits in the user bubble of its own row",
      proof.bubbleMatchesPrompt,
      { rowId: proof.userRowId, bubbleText: proof.bubbleText, bubbleWholeText: proof.bubbleWholeText },
    );
    check(
      "R006: the Auto-Goal mark is a chip, not part of the operator's prompt text",
      proof.goalChipText !== null && proof.bubbleText === PROMPT && proof.bubbleWholeText.includes(proof.goalChipText),
      { operatorText: proof.bubbleText, wholeBubble: proof.bubbleWholeText, goalChip: proof.goalChipText },
    );
    check(
      "the answer is a distinct, later row of the same timeline (same turn, same session)",
      proof.answerRowIsLaterInTheSameTimeline && proof.answerRowIsNotAUserRow && proof.answerCarriesSentinel && proof.bothChipsFromOneStrip,
      proof,
    );
    check(
      "both anchors, the promoted session id and the title projection are non-null",
      proof.userRowId !== null &&
        proof.answerRowId !== null &&
        proof.userIdentity !== null &&
        proof.answerIdentity !== null &&
        proof.sessionPanePresent &&
        proof.sessionId !== null &&
        proof.sessionId !== "draft" &&
        proof.sessionTitlePresent,
      {
        sessionId: proof.sessionId,
        sessionTitle: proof.sessionTitle,
        sessionTitleAttr: proof.sessionTitleAttr,
        userIdentity: proof.userIdentity,
        answerIdentity: proof.answerIdentity,
      },
    );
    await shot(page, "01-conversation");
    const userBubble = await page
      .locator(`[data-row-id="${proof.userRowId}"] [data-v4-user-input-collapsible-content="true"]`)
      .first()
      .innerText()
      .catch(() => "");
    check(
      "R006: the sent bubble never shows the Auto-Goal suffix as operator text",
      userBubble.trim() === PROMPT && !/\/goal cc all/.test(userBubble),
      userBubble,
    );

    const realTurn = checks
      .filter((c) => /sentinel|user bubble of its own row|Auto-Goal mark is a chip|distinct, later row|non-null/.test(c.name))
      .every((c) => c.pass === true);
    if (!realTurn) throw new Error("TURN_PROOF_FAILED: no authority-bound real turn; R009/R020/R036 not driven");

    // ---------------------------------------------------- R009 turn nav geometry
    stage = "R009 turn nav";
    const nav = await page.evaluate(() => {
      const strip = document.querySelector('[data-v4-turn-nav-strip="true"]');
      const scroller = document.querySelector('[data-testid="v4-timeline"]');
      const header = document.querySelector("header");
      const rect = (el) => (el ? { top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, height: el.getBoundingClientRect().height } : null);
      return {
        strip: rect(strip),
        scrollRoot: rect(scroller),
        header: rect(header),
        latestUser: Boolean(document.querySelector('[data-testid="v4-latest-user"]')),
        latestAnswer: Boolean(document.querySelector('[data-testid="v4-latest-answer"]')),
      };
    });
    check("R009: latest-user and latest-answer controls both exist", nav.latestUser && nav.latestAnswer, nav);
    check(
      "R009: the nav strip sits below the header and above the transcript it labels",
      Boolean(nav.strip) &&
        (!nav.header || nav.strip.top >= nav.header.bottom - 1) &&
        (!nav.scrollRoot || nav.strip.bottom <= nav.scrollRoot.top + 1),
      nav,
    );

    // ---------------------------------------------- navigation away + R020 + persistence
    stage = "R020 view switching";
    const navBlock = page.locator("[data-zaicode-nav-block]").first();
    if (await navBlock.count()) await navBlock.hover().catch(() => {});
    const openView = async (testId) => {
      if (await navBlock.count()) await navBlock.hover().catch(() => {});
      const button = page.locator(`[data-testid="${testId}"]`).first();
      if (!(await button.count())) return false;
      await button.click({ timeout: 15000 }).catch(() => {});
      await settle(900);
      return true;
    };
    const sessionRow = () => {
      const task = page.locator('[data-testid^="task-item-"]').filter({ hasText: "hunt-project" }).first();
      return task;
    };
    const restore = async (label) => {
      let clicked = null;
      const task = sessionRow();
      if (await task.count()) {
        await task.click({ timeout: 15000 }).catch(() => {});
        clicked = "task-item";
      } else {
        const projectRow = page
          .locator('[data-testid^="workspace-item"]')
          .filter({ hasText: /hunt-project/ })
          .first();
        if (await projectRow.count()) {
          await projectRow.click({ timeout: 15000 }).catch(() => {});
          clicked = "workspace-item";
        }
      }
      const restored = await page
        .waitForFunction(
          (ids) =>
            ids.every((id) => document.querySelector(`[data-row-id="${id}"]`)) &&
            Boolean(document.querySelector('[data-testid="v4-latest-user"]')),
          [proof.userRowId, proof.answerRowId],
          { timeout: 45000 },
        )
        .then(() => true)
        .catch(() => false);
      const after = await readProof();
      check(
        `R020: one click on the same project/session after ${label} restores the exact conversation`,
        restored && after.sessionId === proof.sessionId && after.sessionTitleAttr === proof.sessionTitleAttr,
        {
          clicked,
          restored,
          sessionIdBefore: proof.sessionId,
          sessionIdAfter: after.sessionId,
          titleBefore: proof.sessionTitle,
          titleAfter: after.sessionTitle,
          rows: after.transcriptRows,
        },
      );
      if (!restored) await shot(page, `02-r020-${label}`);
      return restored;
    };

    await openView("zaicode-sidebar-open") || check("R020: ZAICODE nav line present", null, "not found");
    await restore("ZAICODE");
    await openView("zaicode-sidebar-saihome") || check("R020: SAIHOME nav line present", null, "not found");
    const survived = await restore("SAIHOME");
    const afterNav = await readProof();
    check(
      "the transcript survives a navigation away and back (same row ids, same session id, no lost rows)",
      survived && afterNav.transcriptRows >= proof.transcriptRows && afterNav.userRowId === proof.userRowId && afterNav.answerRowId === proof.answerRowId,
      {
        sessionId: afterNav.sessionId,
        userRowIdBefore: proof.userRowId,
        userRowIdAfter: afterNav.userRowId,
        answerRowIdBefore: proof.answerRowId,
        answerRowIdAfter: afterNav.answerRowId,
        rows: afterNav.transcriptRows,
      },
    );

    // ---------------------------------------------------------------- R036 unseen
    stage = "R036 done-unseen";
    // The producer marks only a session that LEFT running while it was NOT the open one
    // (zaicodeUnseenDone.pickZaicodeUnseenDone skips `activeTaskId`). Switching the center
    // view to SAIHOME does not move `activeTaskId`, so the driver does what the operator
    // described: starts a turn and then moves to ANOTHER project, which really is elsewhere.
    const beforeUnseen = await page.evaluate(
      () => document.querySelectorAll('[data-unread-indicator="true"]').length,
    );
    const paneScope = () =>
      page.evaluate(() => {
        const pane = document.querySelector('[data-testid^="v4-session-pane"]');
        const badge = document.querySelector('[data-testid^="v4-pane-workspace-badge"]');
        return {
          sessionId: pane?.getAttribute("data-session-id") ?? null,
          badge: (badge?.textContent || "").trim() || null,
          badgeTitle: badge?.getAttribute("title") ?? null,
        };
      });
    const input2 = page.locator('[data-testid="v4-composer-input"]').first();
    if (await input2.count()) {
      const rowsBefore = await page.evaluate(
        () => document.querySelectorAll('[data-v4-user-input-collapsible-content="true"]').length,
      );
      await page.evaluate((text) => {
        document.querySelector('[data-testid="v4-composer-input"]').__zcodeLexicalInputE2E.setText(text);
      }, PROMPT_2);
      const admitted2 = await waitAdmitted(60000);
      check("R036: the composer is send-ready for the unseen-completion turn", admitted2, await admissionDiagnostics(page));
      if (admitted2) {
        await send.click({ timeout: 15000 });
        // The second turn must really exist, or "no marker" would mean nothing at all.
        const turn2Started = await page
          .waitForFunction(
            (n) => document.querySelectorAll('[data-v4-user-input-collapsible-content="true"]').length > n,
            rowsBefore,
            { timeout: 45000 },
          )
          .then(() => true)
          .catch(() => false);
        check("R036: the second turn is really in the transcript before the operator leaves", turn2Started, {
          rowsBefore,
          rowsAfter: await page.evaluate(
            () => document.querySelectorAll('[data-v4-user-input-collapsible-content="true"]').length,
          ),
        });
        // Move to the other, never-run project: that is "the operator is elsewhere".
        const idleRow = page
          .locator('[data-testid^="workspace-item"]')
          .filter({ hasText: "hunt-idle" })
          .first();
        if (await idleRow.count()) await idleRow.click({ timeout: 15000 }).catch(() => {});
        await settle(900);
        const leftScope = await paneScope();
        check(
          "R036: the operator really left the session (another project is the open scope)",
          leftScope.sessionId !== proof.sessionId,
          { before: proof.sessionId, after: leftScope },
        );
        const dot = await page
          .waitForFunction(
            () => document.querySelectorAll('[data-unread-indicator="true"]').length > 0,
            null,
            { timeout: 300000 },
          )
          .then(() => true)
          .catch(() => false);
        await shot(page, "03-sidebar-after-done");
        const survey = await page.evaluate(() => {
          const rows = Array.from(
            document.querySelectorAll('[data-testid^="workspace-item"], [data-testid^="task-item"]'),
          );
          return rows.map((el) => ({
            id: el.getAttribute("data-testid"),
            text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
            unseen: el.querySelector('[data-unread-indicator="true"]') !== null,
            glyph: el.querySelector("[data-unread-indicator]")?.getAttribute("aria-label") ?? null,
          }));
        });
        check(
          "R036: a run that finished while the operator was elsewhere shows the completed-unseen marker",
          dot,
          { scope: leftScope, survey },
        );
        const finished = survey.filter((r) => r.unseen);
        // The marker belongs to the session that finished (or to its project row) -- the
        // idle project's rows must stay clean either way.
        const onFinishedSession = finished.some((r) => r.id === `task-item-${proof.sessionId}`);
        const onFinishedProject = finished.some((r) => /hunt-project/.test(r.id));
        check(
          "R036: only the finished session carries the marker; the idle project does not look identical",
          dot &&
            finished.length === 1 &&
            (onFinishedSession || onFinishedProject) &&
            !finished.some((r) => /hunt-idle/.test(r.id)),
          { finished, expectedSessionId: proof.sessionId, survey },
        );
        // Opening that exact project must clear the marker, and only a marker that was
        // really there can be cleared -- otherwise "cleared" would pass on nothing.
        await restore("R036 open");
        const cleared = await page
          .waitForFunction(
            () =>
              !Array.from(
                document.querySelectorAll('[data-testid^="workspace-item"], [data-testid^="task-item"]'),
              ).some((el) => el.querySelector('[data-unread-indicator="true"]')),
            null,
            { timeout: 45000 },
          )
          .then(() => true)
          .catch(() => false);
        await shot(page, "04-sidebar-after-open");
        check("R036: opening that exact project clears the unseen marker", dot && cleared, {
          markerWasShown: dot,
          cleared,
          remaining: await page.evaluate(
            () => document.querySelectorAll('[data-unread-indicator="true"]').length,
          ),
        });
      }
    }
    check("R036: control -- no unseen marker existed before the turn", beforeUnseen === 0, beforeUnseen);

    await settle(300);
    check("zero renderer exceptions", errors.length === 0, errors);
    const receipt = writeReceipt({ errors, stage: "done", profile, checks });
    receipt.pass = checks.filter((c) => c.pass !== null).every((c) => c.pass) && errors.length === 0;
    fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
    if (!receipt.pass) process.exitCode = 1;
  } catch (error) {
    if (page) await shot(page, "error");
    writeReceipt({ pass: false, stage, errors, error: String(error.stack || error) });
    console.error("ERROR at", stage, String(error));
    process.exitCode = 1;
  } finally {
    if (app)
      try {
        await app.close();
      } catch {}
  }
})();
