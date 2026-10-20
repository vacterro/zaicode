// Mount the actual pane owner: pure preference tests alone miss restore order.
const fs = require("node:fs/promises");
const syncFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

async function run({ chromium, subject = "current", out, preimage: suppliedPreimage }) {
  const product = path.resolve(__dirname, "../../../..");
  const root = path.dirname(product);
  const req = createRequire(path.join(product, "packages/desktop/package.json"));
  const src = path.join(product, "packages/ui/src").replaceAll("\\", "/");
  const preimage = suppliedPreimage || path.join(root, ".saipen/evidence/T-224-current/original-live/useAppPanels.ts");
  const owned = await fs.mkdtemp(path.join(os.tmpdir(), "zaicode-pane-policy-"));
  await fs.mkdir(out, { recursive: true });
  const report = { at: new Date().toISOString(), subject, fixtureOnly: true, instrumentReady: false, checks: [], errors: [] };
  let browser, server;
  try {
    await fs.writeFile(path.join(owned, "index.html"), '<html><body><div id="root"></div><script>globalThis.__ZAICODE_PRODUCT_MODE__=true;if(!localStorage.getItem("zaicode-ui-prefs-v1"))localStorage.setItem("zaicode-ui-prefs-v1",JSON.stringify({sidePaneVisibility:{mode:"everywhere",everywhere:null,byOwner:{}}}));</script><script type="module" src="/fixture.tsx"></script></body></html>');
    await fs.writeFile(path.join(owned, "fixture.tsx"), `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{ServiceProvider}from'${src}/hooks/useServices.tsx';
import{useAppPanels}from'${src}/hooks/useAppPanels.ts';
import{useZaicodeUiPrefs}from'${src}/zaicode/zaicodeUiPrefs.ts';
import{getVisibleSidePaneTabs}from'${src}/lib/workspaceSidePane.ts';
const params=new URLSearchParams(location.search);
function Fixture(){const[workspace,setWorkspace]=useState(params.get('workspace')??'/fixture/a');const[owner,setOwner]=useState(params.get('owner'));
const panel=useAppPanels({workspaceAbsPath:workspace,activeTaskId:owner,sidePaneOwnerId:owner,isDesktop:false,defaultWhiteboardNamePrefix:'fixture'});
const prefs=useZaicodeUiPrefs(s=>s.sidePaneVisibility);
const mode=value=>useZaicodeUiPrefs.getState().update({sidePaneVisibility:{...useZaicodeUiPrefs.getState().sidePaneVisibility,mode:value}});
return <main><button onClick={()=>setWorkspace('/fixture/a')}>Project A</button><button onClick={()=>setWorkspace('/fixture/b')}>Project B</button><button onClick={()=>setOwner('session-A')}>Owner A</button><button onClick={()=>setOwner('session-B')}>Owner B</button><button onClick={panel.handleOpenSaipenTab}>Open pane</button><button onClick={panel.handleOpenTerminalTab}>Open terminal</button><button onClick={panel.handleToggleSidePaneCollapse}>Toggle pane</button><button onClick={()=>mode('everywhere')}>Everywhere</button><button onClick={()=>mode('perOwner')}>Per owner</button><output data-pane-state>{JSON.stringify({workspace,owner,collapsed:panel.isSidePaneCollapsed,tabs:panel.sidePaneState?.tabs.map(t=>t.type)||[],visible:panel.sidePaneState?getVisibleSidePaneTabs(panel.sidePaneState.tabs,{workspaceKey:workspace,ownerTaskId:owner}):[],active:panel.sidePaneState?.activeTabId,prefs})}</output></main>}
createRoot(document.getElementById('root')).render(<ServiceProvider services={{}}><Fixture/></ServiceProvider>);
`);
    const { createServer } = await import(pathToFileURL(req.resolve("vite")).href);
    const react = (await import(pathToFileURL(req.resolve("@vitejs/plugin-react")).href)).default;
    server = await createServer({ configFile: false, root: owned, logLevel: "error", plugins: [subject === "original" && { name: "preserved-pane-owner", enforce: "pre", load(id) { if (id.split("?")[0].replaceAll("\\", "/") === src + "/hooks/useAppPanels.ts") return syncFs.readFileSync(preimage, "utf8"); } }, react()].filter(Boolean), resolve: { alias: { "@": src, react: path.dirname(req.resolve("react/package.json")), "react-dom": path.dirname(req.resolve("react-dom/package.json")) } }, server: { host: "127.0.0.1", port: 0, fs: { allow: [owned, product, path.dirname(preimage)] } } });
    await server.listen();
    browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    page.on("pageerror", (error) => report.errors.push(String(error)));
    await page.goto("http://127.0.0.1:" + server.httpServer.address().port);
    await page.locator("[data-pane-state]").waitFor({ timeout: 30000 });
    const state = async () => JSON.parse(await page.locator("[data-pane-state]").innerText());
    const click = async (name) => { await page.getByRole("button", { name, exact: true }).click(); await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); };
    const check = async (name, collapsed) => { const actual = await state(); report.checks.push({ name, pass: actual.collapsed === collapsed, detail: actual }); };
    await click("Open pane");
    assertState(await state(), false);
    report.instrumentReady = true;
    await click("Toggle pane"); await click("Project B"); await click("Open pane"); await click("Toggle pane");
    await click("Project A"); await click("Open pane"); await click("Project B");
    await check("global open overrides an old closed owner memory", false);
    await click("Open pane"); await click("Project A"); await click("Open pane"); await click("Toggle pane"); await click("Project B");
    await check("global closed overrides an old open owner memory", true);
    await click("Per owner"); await click("Project A"); await click("Open pane"); await click("Toggle pane"); await click("Open pane");
    await click("Project B"); await click("Open pane"); await click("Toggle pane"); await click("Project A");
    await check("per-owner A retains its explicit open answer", false);
    await click("Project B"); await check("per-owner B retains its explicit closed answer", true);
    await click("Project A"); await click("Everywhere");
    await check("changing mode reprojects the current owner immediately", true);
    await click("Per owner"); await click("Owner A"); await click("Open pane"); await click("Toggle pane");
    await click("Owner B"); await click("Open pane"); await click("Owner A");
    await check("session owner A retains its closed answer", true);
    await click("Owner B"); await check("session owner B retains its open answer", false);
    await click("Everywhere"); await click("Open pane"); await click("Owner A");
    await check("global answer overrides a closed session owner on owner switch", false);
    await click("Open terminal");
    const terminal = (await state()).active;
    await click("Per owner"); await click("Everywhere");
    const preserved = await state();
    report.checks.push({ name: "policy restoration preserves the existing visible terminal and active tab", pass: !preserved.collapsed && preserved.active === terminal && preserved.tabs.filter(t => t === "terminal").length === 1, detail: preserved });
    const saved = async () => page.evaluate(() => JSON.parse(localStorage.getItem("zaicode-ui-prefs-v1")).sidePaneVisibility);
    const cold = async (prefs, query = "") => {
      await page.evaluate((value) => localStorage.setItem("zaicode-ui-prefs-v1", JSON.stringify({ sidePaneVisibility: value })), prefs);
      await page.goto("http://127.0.0.1:" + server.httpServer.address().port + "/" + query);
      await page.locator("[data-pane-state]").waitFor({ timeout: 30000 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const coldCheck = async (name, predicate, prefs) => {
      const actual = await state();
      report.checks.push({ name, pass: predicate(actual) && JSON.stringify(await saved()) === JSON.stringify(prefs), detail: actual });
    };
    const globalOpen = { mode: "everywhere", everywhere: true, byOwner: {} };
    await cold(globalOpen);
    await coldCheck("cold global open restores one scoped SAIPEN tab without changing preferences", (s) => !s.collapsed && s.visible.length === 1 && s.visible[0].type === "saipen" && s.visible[0].workspaceKey === "/fixture/a", globalOpen);
    await page.reload(); await page.locator("[data-pane-state]").waitFor();
    await coldCheck("second full-module reload keeps exactly one restored tab", (s) => !s.collapsed && s.tabs.length === 1 && s.visible.length === 1, globalOpen);
    const globalClosed = { mode: "everywhere", everywhere: false, byOwner: {} };
    await cold(globalClosed);
    await coldCheck("cold global closed creates no content", (s) => s.collapsed && s.tabs.length === 0, globalClosed);
    const sessions = { mode: "perOwner", everywhere: null, byOwner: { "session-A": true, "session-B": false } };
    await cold(sessions, "?owner=session-A");
    await coldCheck("cold session A restores open content under its own owner", (s) => !s.collapsed && s.visible.length === 1 && s.visible[0].ownerTaskId === "session-A", sessions);
    await cold(sessions, "?owner=session-B");
    await coldCheck("cold session B keeps its explicit closed answer", (s) => s.collapsed && s.tabs.length === 0, sessions);
    await cold(sessions, "?owner=session-unset&workspace=/fixture/new");
    await coldCheck("unremembered empty workspace does not inherit another session content", (s) => s.collapsed && s.tabs.length === 0, sessions);
    await cold(globalOpen, "?workspace=");
    await coldCheck("no workspace creates no default pane despite global open", (s) => s.collapsed && s.tabs.length === 0, globalOpen);
    await page.screenshot({ path: path.join(out, "pane-policy.png") });
  } catch (error) { report.error = String(error); }
  finally {
    if (browser) await browser.close();
    if (server) await server.close();
    report.pass = report.instrumentReady && !report.error && report.errors.length === 0 && report.checks.length === 16 && report.checks.every((check) => check.pass);
    await fs.writeFile(path.join(out, "receipt.json"), JSON.stringify(report, null, 2));
  }
  return report;
}
function assertState(state, collapsed) { if (state.collapsed !== collapsed || !state.tabs.includes("saipen")) throw new Error("The known-good actual pane command did not establish the fixture"); }
module.exports = { run };
