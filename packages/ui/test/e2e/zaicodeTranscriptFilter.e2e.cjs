// Real timeline regression. Run through the Playwright skill or pass an installed
// Chromium launcher to run(); every request stays inside a synthetic fixture.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

async function run({ chromium, subject = "current", out }) {
  const product = path.resolve(__dirname, "../../../..");
  const root = path.dirname(product);
  const req = createRequire(path.join(product, "packages/desktop/package.json"));
  const src = path.join(product, "packages/ui/src").replaceAll("\\", "/");
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), "zaicode-transcript-layout-"));
  fs.mkdirSync(out, { recursive: true });
  const report = {
    subject,
    at: new Date().toISOString(),
    fixtureOnly: true,
    productionTouched: false,
    checks: [],
    errors: [],
  };
  let server, browser;
  const check = (name, pass, detail) => report.checks.push({ name, pass: !!pass, detail });
  try {
    const { createServer } = await import(pathToFileURL(req.resolve("vite")));
    const react = (await import(pathToFileURL(req.resolve("@vitejs/plugin-react")))).default;
    const tailwind = (await import(pathToFileURL(req.resolve("@tailwindcss/vite")))).default;
    fs.writeFileSync(
      path.join(owned, "index.html"),
      '<html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body class="bg-background text-foreground"><div id="root"></div><script>globalThis.__ZAICODE_PRODUCT_MODE__=true;localStorage.setItem("zaicode-ui-prefs-v1",JSON.stringify({transcriptView:"full",autoRetry:false,noMotion:true}));</script><script type="module" src="/fixture.tsx"></script></body></html>',
    );
    fs.writeFileSync(
      path.join(owned, "fixture.css"),
      `@import "${src}/styles.css";\nhtml,body,#root{margin:0;height:100%;overflow:hidden}`,
    );
    fs.writeFileSync(
      path.join(owned, "fixture.tsx"),
      `
import React from 'react';
import {createRoot} from 'react-dom/client';
import './fixture.css';
import {ConversationTimeline} from '${src}/v4/ConversationTimeline.tsx';
import {ZCodeIntlProvider} from '${src}/i18n/IntlProvider.tsx';
import {DEFAULT_CODE_PREVIEW_SETTINGS} from '${src}/lib/codePreviewSettings.ts';
import {ServiceProvider} from '${src}/hooks/useServices.tsx';
import {TabStoreProvider} from '${src}/store/TabStoreProvider.tsx';
import {TooltipProvider} from '${src}/components/ui/tooltip.tsx';
import {applyZaicodeAppearance} from '${src}/zaicode/zaicodeAppearance.ts';
import {useZaicodeUiPrefs} from '${src}/zaicode/zaicodeUiPrefs.ts';
applyZaicodeAppearance();
const now=Date.now(), rows=[];
for(let turn=0;turn<8;turn++){
 const base={turnId:'turn-'+turn,createdAt:now-600000+turn*1000};
 rows.push({...base,rowId:turn*3+1,kind:'turnHeader',origin:'userInput',state:'completedSuccess',startedAt:base.createdAt,endedAt:base.createdAt+900});
 rows.push({...base,rowId:turn*3+2,kind:'userInput',origin:'realUser',text:'Question '+turn,attachments:[]});
 const table='| Ticket | Event | Evidence | Status |\\n| --- | --- | --- | --- |\\n'+Array.from({length:14},(_,i)=>'| T-'+turn+'-'+i+' | E-'+i+' | Verified actual result | DONE |').join('\\n');
 const prose=Array.from({length:8},(_,i)=>'Paragraph '+turn+'.'+i+': Detailed transcript result that must keep its measured height while another section is hidden.').join('\\n\\n');
 rows.push({...base,rowId:turn*3+3,kind:'assistantText',state:'complete',text:'### Result '+turn+'\\n\\n'+table+'\\n\\n'+prose});
}
const context={workspacePath:'',theme:'dark',codePreviewSettings:DEFAULT_CODE_PREVIEW_SETTINGS,messageStreamShowReasoning:true,messageStreamShowTodos:true,logEpoch:'synthetic-one'};
const dock=<div data-fixture-composer style={{height:100,flexShrink:0,border:'1px solid var(--color-border)',background:'var(--color-background)'}}><textarea aria-label="Preserved draft" defaultValue="keep this draft"/><button>Send</button></div>;
window.__T345={rows:JSON.stringify(rows),prefs:()=>useZaicodeUiPrefs.getState().transcriptView};
createRoot(document.getElementById('root')).render(<ServiceProvider services={{}}><TabStoreProvider><ZCodeIntlProvider initialLocale="en-US"><TooltipProvider><main style={{height:'100%',display:'flex',flexDirection:'column'}}><ConversationTimeline rows={rows} totalCount={rows.length} sessionKey="synthetic-transcript" rowContext={context} sessionPhase="completedSuccess" bottomDock={dock} hideTurnNavigator/></main></TooltipProvider></ZCodeIntlProvider></TabStoreProvider></ServiceProvider>);
`,
    );
    const preimage = path.join(root, ".saipen/evidence/T-345/original/ConversationTimeline.tsx");
    server = await createServer({
      configFile: false,
      root: owned,
      logLevel: "error",
      plugins: [
        subject === "original" && {
          name: "preserved-original-timeline",
          enforce: "pre",
          load(id) {
            if (id.split("?")[0].replaceAll("\\", "/") === src + "/v4/ConversationTimeline.tsx")
              return fs.readFileSync(preimage, "utf8");
          },
        },
        react(),
        tailwind(),
      ].filter(Boolean),
      resolve: {
        alias: {
          "@": src,
          react: path.dirname(req.resolve("react/package.json")),
          "react-dom": path.dirname(req.resolve("react-dom/package.json")),
        },
      },
      server: {
        host: "127.0.0.1",
        port: 0,
        fs: { allow: [owned, product, path.dirname(preimage)] },
      },
    });
    await server.listen();
    report.target = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: false });
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    page.on("pageerror", (error) => report.errors.push(String(error)));
    await page.addInitScript(() => {
      window.__T345Errors = [];
      window.addEventListener("error", (event) => window.__T345Errors.push(event.message));
    });
    await page.goto(report.target);
    await page.waitForFunction(
      () => {
        if (window.__T345Errors.length) throw new Error(window.__T345Errors.join("; "));
        return document.querySelector("[data-v4-turn-unit]");
      },
      null,
      { timeout: 60_000 },
    );
    const geometry = () =>
      page.evaluate(() => {
        const history = document.querySelector("[data-v4-timeline-virtual-history]");
        const rect = history.getBoundingClientRect();
        const rows = [...history.querySelectorAll(":scope > [data-v4-turn-unit]")]
          .map((node) => {
            const box = node.getBoundingClientRect();
            return {
              index: Number(node.dataset.index),
              turn: node.dataset.turnId,
              top: box.top,
              bottom: box.bottom,
              height: box.height,
            };
          })
          .sort((a, b) => a.index - b.index);
        const overlaps = rows.slice(1).filter((row, index) => row.top < rows[index].bottom - 1);
        const scroll = document.querySelector("[data-v4-timeline-scroll]");
        const viewport = scroll.getBoundingClientRect(),
          dock = document.querySelector("[data-fixture-composer]").getBoundingClientRect();
        return {
          rows,
          overlaps,
          historyHeight: rect.height,
          extentValid:
            !rows.length || Math.max(...rows.map((row) => row.bottom)) <= rect.bottom + 1,
          draft: document.querySelector('[aria-label="Preserved draft"]').value,
          following: scroll.dataset.following,
          scrollTop: scroll.scrollTop,
          dockValid:
            dock.top >= viewport.top - 1 &&
            dock.bottom <= viewport.bottom + 1 &&
            viewport.bottom - dock.bottom < 40,
        };
      });
    await page.waitForFunction(
      () => {
        const rows = [
          ...document.querySelectorAll("[data-v4-timeline-virtual-history] > [data-v4-turn-unit]"),
        ];
        return (
          rows.length >= 3 &&
          rows.every(
            (node, index) =>
              !index ||
              node.getBoundingClientRect().top >=
                rows[index - 1].getBoundingClientRect().bottom - 1,
          )
        );
      },
      null,
      { timeout: 25_000 },
    );
    const baseline = await geometry();
    check(
      "valid long-history baseline",
      baseline.overlaps.length === 0 && baseline.extentValid && baseline.rows.length >= 3,
      baseline,
    );
    report.instrumentReady = report.checks[0].pass;
    await page
      .getByLabel("Preserved draft", { exact: true })
      .fill("edited draft survives filtering");
    await page.evaluate(() => {
      window.__T345Nodes = [
        ...document.querySelectorAll("[data-v4-timeline-virtual-history] > [data-v4-turn-unit]"),
      ];
      window.__T345Composer = document.querySelector("[data-fixture-composer]");
    });
    async function toggle(attribute, key) {
      let target = page.locator(`[${attribute}="${key}"]:visible`);
      if (!(await target.count())) {
        await page.locator("[data-transcript-filters-menu]").click();
        target = page.locator(`[${attribute}="${key}"]:visible`);
      }
      await target.click();
      await page.keyboard.press("Escape");
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    }
    await toggle("data-transcript-visible", "tools");
    const absent = await geometry();
    check(
      "hiding an absent section retains nonoverlapping measured turns",
      absent.overlaps.length === 0 && absent.extentValid,
      absent,
    );
    check(
      "filter preserves existing row nodes and edited draft",
      (await page.evaluate(
        () =>
          window.__T345Nodes.every((node) => node.isConnected) && window.__T345Composer.isConnected,
      )) && absent.draft === "edited draft survives filtering",
    );
    check(
      "following filter keeps composer at the bottom of the viewport",
      absent.dockValid && absent.following === baseline.following,
      absent,
    );
    await page.screenshot({ path: path.join(out, "after-filter.png"), fullPage: true });
    await toggle("data-transcript-visible", "tools");
    await toggle("data-transcript-scroll", "tools");
    const policy = await geometry();
    check(
      "changing another section scroll policy retains measured offsets",
      policy.overlaps.length === 0 && policy.extentValid,
      policy,
    );
    await toggle("data-transcript-visible", "user");
    const agentOnly = await geometry();
    check(
      "hiding visible user inputs reflows actual history without overlap",
      agentOnly.overlaps.length === 0 && agentOnly.extentValid,
      agentOnly,
    );
    await toggle("data-transcript-visible", "user");
    await page.locator("[data-v4-timeline-scroll]").hover();
    await page.mouse.wheel(0, -1800);
    await page.waitForFunction(
      () => document.querySelector("[data-v4-timeline-scroll]").dataset.following === "false",
    );
    const reading = await geometry();
    await toggle("data-transcript-visible", "thoughts");
    const retainedReading = await geometry();
    check(
      "reading position and detached follow state survive an unchanged-section filter",
      retainedReading.following === "false" &&
        Math.abs(retainedReading.scrollTop - reading.scrollTop) <= 1,
      {
        before: reading.scrollTop,
        after: retainedReading.scrollTop,
        following: retainedReading.following,
      },
    );
    await page.setViewportSize({ width: 640, height: 540 });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await toggle("data-transcript-visible", "tools");
    const narrow = await geometry();
    check(
      "narrow filtered history has valid turns and total extent",
      narrow.overlaps.length === 0 && narrow.extentValid,
      narrow,
    );
    await page.screenshot({ path: path.join(out, "narrow.png"), fullPage: true });
    check("no renderer exception", report.errors.length === 0, report.errors);
  } catch (error) {
    report.error = String(error);
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    report.pass =
      !!report.instrumentReady && !report.error && report.checks.every((check) => check.pass);
    fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify(report, null, 2));
  }
  return report;
}
module.exports = { run };
