import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { relative } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const product = resolve(here, "../../../zcode");
const require = createRequire(resolve(product, "package.json"));
const { build } = require("esbuild");
const stubs = {
  useZaicodeSubOutbox: "export function useZaicodeSubOutbox(){return globalThis.fixture.outbox}",
  zaicodeAuditStore: "export const useZaicodeAuditStore = selector => selector({smartMode:globalThis.fixture.auto});",
  zaicodeStore: `export const useZaicodeStore = selector => selector({autoRun:globalThis.fixture.autopilot});
    useZaicodeStore.getState=()=>({refreshAutoRun:async services=>services?services.jobs.getAutoRun():false});`,
  toast: "export function toast(){}",
  zaicodeAutostart: `export const ZAICODE_AUTOSTART_AGENT_PREFIX='agent:'; export const ZAICODE_AUTOSTART_INAPP_ENGINE='pool:start';
    export const useZaicodeAutostartJobs=()=>globalThis.fixture.jobs;
    export const decideZaicodeAutostartJob=()=>({state:'waiting-time',dueAt:Date.now()+7200000,eventId:'next',reason:''});
    export function addZaicodeAutostartJob(){} export function runZaicodeAutostartNow(){}
    export function updateZaicodeAutostartJob(){} export function removeZaicodeAutostartJob(){} export function readZaicodeQueueServices(){return null}`,
  zaicodeEngines: "export function readZaicodeCurrentWorkspace(){return {path:'V:/fixture/a'}}; export function readZaicodeEnginesState(){return {limits:{},accounts:[]}}; export function useZaicodeEngines(){return {accounts:[]}}; export function refreshZaicodeEngineLimits(){}; export function projectNameOf(){return 'fixture'}",
  zaicodeActions: "export function openZaicodeWorkspaceView(){}; export function openZaicodeSettings(){}",
  zaicodeHighlights: "export const useZaicodeLights = selector=>selector({highlights:{meterPrepared:{}}}); export function zaicodeHighlightAttrs(){return {}};",
  zaicodeIconSlots: "export function ZaicodeIcon(){return null}",
  zaicodeNotifications: "export function notifyZaicode(){}",
  zaicodeWorkers: "export async function launchZaicodeWorker(){throw new Error('unexpected worker route')}",
  zaicodeSoundBus: "export function playZaicodeSound(){}",
  zaicodeSaipen: "export const ZAICODE_SAIPEN_START_COMMAND='/goal cc all'; export const useZaicodeFreshSession={getState:()=>({open(){globalThis.fixture.launches++}})}",
  zaicodeDefaultModel: "export function readZaicodeDefaultModel(){return null}",
  zaicodeProjectSwitch: "export function syncZaicodeDisabledProjects(){}; export function isZaicodeProjectDisabled(){return false}",
  useSettingService: "export function useSettings(){return {settings:{},update:async()=>{}}}",
  TabStoreProvider: "export function useTabStore(selector){return selector({tabs:[]})}",
  useServices: "export function useServices(){throw new Error('unexpected service consumer')}",
  settingsNavigation: "export function setPendingSettingsSection(){}",
  ZaicodeLimitViews: "export function ZaicodeAccountLimits(){return null}; export function useZaicodeClock(){return Date.now()}",
  zaicodeRouter: "export function useZaicodeRouter(){return {}}",
  useZaicodeRouterAutoSetup: "export function runZaicodeRouterSetup(){}",
  zaicodeRouterSetup: "export function useZaicodeRouterSetup(){return {}}",
  zaicodeSaimail: "export function useZaicodeSaimailDesk(){return {}}",
  zaicodeSessionNav: "export function openZaicodeSession(){}; export function useZaicodeSessionNav(){return {waiting:[]}}",
  zaicodeScheduleRun: `export const ZAICODE_INAPP_RUNNER_RANK=1;
    export async function clearZaicodeBeforeRun(){return []}; export async function continueZaicodeMarked(){return {runs:[],lines:[]}};
    export function orderZaicodeScheduleTargets(targets){return targets}; export function zaicodeHomeRows(){return []}; export function zaicodeTargetIdle(){return true}; export function zaicodeEngineRank(){return 1};
    export async function startZaicodeInMain(){globalThis.fixture.launches++;return {runs:[{jobId:'scheduled-run',workspaceKey:'V:/fixture/a',at:Date.now()}],lines:['fixture started']}};
    export async function stopZaicodeSessionRun(){globalThis.fixture.stops++; return true}`,
};
const result = await build({
  entryPoints: [resolve(here, "harness.tsx")], bundle: true, write: false, format: "iife", platform: "browser",
  absWorkingDir: product, nodePaths: [resolve(product, "node_modules"), resolve(product, "packages/ui/node_modules")],
  alias: { "@": resolve(product, "packages/ui/src"), "react": dirname(require.resolve("react/package.json")), "react-dom": dirname(require.resolve("react-dom/package.json")) },
  define: { "process.env.NODE_ENV": '"development"', "process.env.ZCODE_ZAICODE_MODE": '"1"' },
  plugins: [{ name: "projection-fixtures", setup(build) {
    build.onResolve({ filter: /(?:^|\/)(useZaicodeSubOutbox|zaicodeAuditStore|zaicodeStore|toast|zaicodeAutostart|zaicodeEngines|zaicodeActions|zaicodeHighlights|zaicodeIconSlots|zaicodeNotifications|zaicodeWorkers|zaicodeSoundBus|zaicodeSaipen|zaicodeDefaultModel|zaicodeProjectSwitch|zaicodeScheduleRun|useSettingService|TabStoreProvider|useServices|settingsNavigation|ZaicodeLimitViews|zaicodeRouter|useZaicodeRouterAutoSetup|zaicodeRouterSetup|zaicodeSaimail|zaicodeSessionNav)\.js$/ }, args => {
      const name = args.path.split("/").at(-1).slice(0, -3);
      return { path: name, namespace: "fixture" };
    });
    build.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: stubs[args.path], loader: "js" }));
    if (process.env.T186_SUBJECT) build.onLoad({ filter: /\.(?:ts|tsx)$/ }, args => {
      const path = relative(product, args.path).replaceAll("\\", "/");
      if (!path.startsWith("packages/ui/src/")) return;
      const contents = execFileSync("git", ["-C", product, "show", `${process.env.T186_SUBJECT}:${path}`], { encoding: "utf8" });
      return { contents, loader: path.endsWith(".tsx") ? "tsx" : "ts" };
    });
  } }],
});
const page = `<!doctype html><meta charset="utf-8"><style>body{font:14px Verdana;background:#1a1810;color:#d4c89a;padding:24px}main{display:grid;gap:24px}button{margin:6px;padding:8px;background:#332e22;color:#d4c89a;border:1px solid #75663d}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}[role=tooltip]{background:#332e22;color:#d4c89a;padding:5px;border:1px solid #f0d060}</style><div id="root"></div><script src="/fixture.js"></script>`;
createServer((req, res) => {
  res.setHeader("Content-Type", req.url === "/fixture.js" ? "application/javascript" : "text/html; charset=utf-8");
  res.end(req.url === "/fixture.js" ? result.outputFiles[0].contents : page);
}).listen(4186, "127.0.0.1", () => console.log("T186 fixture http://127.0.0.1:4186"));
