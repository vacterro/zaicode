import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(moduleDir, "..");
const workspaceRoot = path.resolve(desktopRoot, "../..");

const { build } = require(path.resolve(workspaceRoot, "node_modules/esbuild/lib/main.js"));

const { getBuildMetadata } = await import(
  pathToFileURL(path.resolve(desktopRoot, "scripts/build-metadata.mjs")).href
);
const { resolveDesktopProductFlavor } = await import(
  pathToFileURL(path.resolve(desktopRoot, "scripts/desktop-product-identity.mjs")).href
);
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(path.resolve(workspaceRoot, "scripts/builtin-provider-config.mjs")).href
);

function pickProductEndpointEnv(env) {
  const keys = [
    "ZCODE_BASE_URL",
    "ZCODE_ENDPOINT_ORIGIN",
    "BIGMODEL_API_BASE_URL",
    "ZAI_OAUTH_ORIGIN",
    "ZAI_BUSINESS_BASE_URL",
    "ZAI_OAUTH_CLIENT_ID",
    "ZAI_OAUTH_APP_ID",
  ];
  return Object.fromEntries(
    keys.flatMap((key) => (env[key]?.trim() ? [[key, env[key].trim()]] : [])),
  );
}

function loadEnvFiles() {
  const vars = {};
  const files = [
    path.resolve(workspaceRoot, ".env"),
    path.resolve(workspaceRoot, ".env.local"),
    process.env.NODE_ENV === "production"
      ? path.resolve(workspaceRoot, ".env.production")
      : path.resolve(workspaceRoot, ".env.development"),
  ];
  for (const file of files) {
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2].trim();
      }
    }
  }
  return { ...vars, ...process.env };
}

function resolveSharedDefines() {
  const env = loadEnvFiles();
  const buildMetadata = getBuildMetadata();
  const zcodeEnv = process.env.ZCODE_ENV || "test";
  const zcodeProductFlavor = resolveDesktopProductFlavor({ ...process.env, ZCODE_ENV: zcodeEnv });

  return {
    __ZCODE_VERSION__: JSON.stringify(buildMetadata.appVersion),
    __ZCODE_COMMIT__: JSON.stringify(buildMetadata.buildCommitId),
    __ZCODE_BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
    __ZCODE_ENV__: JSON.stringify(zcodeEnv),
    __ZCODE_ENDPOINT_ENV__: JSON.stringify(pickProductEndpointEnv(env)),
    __ZCODE_PRODUCT_FLAVOR__: JSON.stringify(zcodeProductFlavor),
    __ZCODE_CUA_HELPER_BUILD_ID__: JSON.stringify(
      process.env.ZCODE_CUA_HELPER_BUILD_ID?.trim() ?? "",
    ),
    __ZCODE_CDN_BASE_URL__: JSON.stringify(env.ZCODE_CDN_BASE_URL?.trim() || ""),
  };
}

const desktopNodeRuntimeExternals = new Set([
  "electron",
  "node-pty",
  "ssh2",
  "undici",
  "yaml",
  "node-forge",
  "yauzl",
]);

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

function resolveFileWithExt(basePath) {
  const stripped = basePath.replace(/\.(?:js|mjs|cjs)$/, "");
  const candidates = [
    basePath,
    stripped + ".ts",
    stripped + ".tsx",
    stripped + ".js",
    stripped + ".mjs",
    stripped + ".cjs",
    stripped + ".json",
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.js"),
    path.join(basePath, "index.mjs"),
    path.join(stripped, "index.ts"),
    path.join(stripped, "index.tsx"),
    path.join(stripped, "index.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        if (fs.statSync(c).isFile()) return c;
      } catch {}
    }
  }
  return null;
}

function findPackageJsonDir(startDir) {
  let cur = startDir;
  while (cur && cur !== workspaceRoot && cur !== path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, "package.json"))) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  return null;
}

function resolveExportTarget(exp) {
  if (!exp) return null;
  if (typeof exp === "string") return exp;
  if (typeof exp === "object") {
    return exp.import || exp.node || exp.default || exp.require || null;
  }
  return null;
}

function resolveWorkspacePackage(importPath) {
  const parts = importPath.split("/");
  const pkgName = parts[1];
  const subPath = parts.slice(2).join("/");
  const pkgDir = path.join(workspaceRoot, "packages", pkgName);
  if (!fs.existsSync(pkgDir)) return null;

  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    if (subPath) {
      const exportKey = "./" + subPath;
      if (pkgJson.exports && pkgJson.exports[exportKey]) {
        const target = resolveExportTarget(pkgJson.exports[exportKey]);
        if (target) {
          const resolved = resolveFileWithExt(path.resolve(pkgDir, target));
          if (resolved) return resolved;
        }
      }
      const candidate = path.join(pkgDir, "src", subPath);
      const resolved = resolveFileWithExt(candidate);
      if (resolved) return resolved;
    } else {
      if (pkgJson.exports && pkgJson.exports["."]) {
        const target = resolveExportTarget(pkgJson.exports["."]);
        if (target) {
          const resolved = resolveFileWithExt(path.resolve(pkgDir, target));
          if (resolved) return resolved;
        }
      }
      const entry = pkgJson.source || pkgJson.main || "src/index.ts";
      const resolved = resolveFileWithExt(path.resolve(pkgDir, entry));
      if (resolved) return resolved;
    }
  }
  return null;
}

export function createVacResolverPlugin(extraExternals = [], { bundleNodeModules = false } = {}) {
  const externalsSet = new Set(
    bundleNodeModules ? extraExternals : [...desktopNodeRuntimeExternals, ...extraExternals],
  );
  return {
    name: "vac-resolver-plugin",
    setup(buildContext) {
      buildContext.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") {
          return { path: args.path };
        }
        if (args.path.startsWith("node:") || nodeBuiltins.has(args.path)) {
          return { path: args.path, external: true };
        }

        const basePkg = args.path.startsWith("@")
          ? args.path.split("/").slice(0, 2).join("/")
          : args.path.split("/")[0];
        if (externalsSet.has(args.path) || externalsSet.has(basePkg)) {
          return { path: args.path, external: true };
        }

        const resolveDir = args.resolveDir || desktopRoot;

        // 1. Subpath imports starting with '#' (e.g. #src/...)
        if (args.path.startsWith("#")) {
          const pkgDir = findPackageJsonDir(resolveDir);
          if (pkgDir) {
            try {
              const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
              if (pkgJson.imports) {
                for (const [key, val] of Object.entries(pkgJson.imports)) {
                  if (key.endsWith("/*") && args.path.startsWith(key.slice(0, -1))) {
                    const relSub = args.path.slice(key.slice(0, -1).length);
                    const targetBase = val.replace(/\*$/, relSub);
                    const targetPath = path.resolve(pkgDir, targetBase);
                    const resolved = resolveFileWithExt(targetPath);
                    if (resolved) return { path: resolved };
                  } else if (key === args.path) {
                    const targetPath = path.resolve(pkgDir, val);
                    const resolved = resolveFileWithExt(targetPath);
                    if (resolved) return { path: resolved };
                  }
                }
              }
            } catch {}
          }
        }

        // 2. Relative imports
        if (args.path.startsWith(".")) {
          const fullPath = path.resolve(resolveDir, args.path);
          const resolved = resolveFileWithExt(fullPath);
          if (resolved) return { path: resolved };
        }

        // 3. Absolute paths
        if (path.isAbsolute(args.path)) {
          const resolved = resolveFileWithExt(args.path);
          if (resolved) return { path: resolved };
        }

        // 4. Workspace packages (@zcode/*)
        if (args.path.startsWith("@zcode/")) {
          const resolved = resolveWorkspacePackage(args.path);
          if (resolved) return { path: resolved };
        }

        // 5. Node modules
        if (bundleNodeModules) {
          try {
            const resolved = require.resolve(args.path, {
              paths: [resolveDir, desktopRoot, workspaceRoot],
            });
            return { path: resolved };
          } catch {
            return { path: args.path, external: true };
          }
        }

        return { path: args.path, external: true };
      });
    },
  };
}

function writeReadyMarker(target) {
  const readyMarkerNames = {
    main: ".main-build-ready",
    host: ".host-build-ready",
    preload: ".preload-build-ready",
    scheduler: ".scheduler-build-ready",
  };
  const markerPath = path.resolve(desktopRoot, "out", readyMarkerNames[target]);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`, "utf8");
}

export async function buildAllDesktopBundles({ cwd = desktopRoot } = {}) {
  const sharedDefines = resolveSharedDefines();
  const outdir = path.resolve(cwd, "out");
  for (const dir of ["main", "host", "preload", "scheduler"]) {
    fs.rmSync(path.resolve(cwd, "out", dir), { recursive: true, force: true });
  }
  fs.mkdirSync(outdir, { recursive: true });

  console.log("[build:bundles] building preload bundle ...");
  await build({
    entryPoints: {
      "preload/embeddedBrowserJavaScriptDialog": path.join(desktopRoot, "src/preload/embeddedBrowserJavaScriptDialog.ts"),
      "preload/codingPlanWebview": path.join(desktopRoot, "src/preload/codingPlanWebview.ts"),
      "preload/browserVideoRecorder": path.join(desktopRoot, "src/preload/browserVideoRecorder.ts"),
      "preload/index": path.join(desktopRoot, "src/preload/index.ts"),
      "preload/resourceManager": path.join(desktopRoot, "src/preload/resourceManager.ts"),
      "preload/cuaPermissionPanel": path.join(desktopRoot, "src/preload/cuaPermissionPanel.ts"),
      "preload/zaicodeProtrailOverlay": path.join(desktopRoot, "src/preload/zaicodeProtrailOverlay.ts"),
    },
    outdir,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    define: sharedDefines,
    keepNames: true,
    minify: true,
    sourcemap: false,
    legalComments: "none",
    plugins: [createVacResolverPlugin(["electron"], { bundleNodeModules: true })],
  });
  writeReadyMarker("preload");

  console.log("[build:bundles] building scheduler bundle ...");
  await build({
    entryPoints: {
      "scheduler/index": path.join(desktopRoot, "src/scheduler/index.ts"),
    },
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node22",
    chunkNames: "scheduler/chunk-[hash]",
    define: sharedDefines,
    keepNames: true,
    minify: true,
    sourcemap: false,
    legalComments: "none",
    plugins: [createVacResolverPlugin()],
  });
  writeReadyMarker("scheduler");

  console.log("[build:bundles] building host bundle ...");
  await build({
    entryPoints: {
      "host/index": path.join(desktopRoot, "src/host/index.ts"),
      "host/tasksStorageWorker": path.join(desktopRoot, "src/host/tasksStorageWorker.ts"),
      "host/workerTerminalBroker": path.join(workspaceRoot, "packages/services/src/terminal/workerTerminalBroker.ts"),
      "host/workerTerminalProcess": path.join(workspaceRoot, "packages/services/src/terminal/workerTerminalProcess.ts"),
    },
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node22",
    chunkNames: "host/chunk-[hash]",
    define: sharedDefines,
    keepNames: true,
    minify: true,
    sourcemap: false,
    legalComments: "none",
    plugins: [createVacResolverPlugin()],
  });
  writeReadyMarker("host");

  console.log("[build:bundles] building main bundle ...");
  await build({
    entryPoints: {
      "main/index": path.join(desktopRoot, "src/main/index.ts"),
      "main/browserWebmRecorder": path.join(desktopRoot, "src/main/browserView/electronBrowserWebmRecorder.ts"),
      "main/zcodeDataSizeWorker": path.join(desktopRoot, "src/main/zcodeDataSizeWorker.ts"),
      "main/storageScanWorker": path.join(desktopRoot, "src/main/storageScanWorker.ts"),
    },
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node22",
    chunkNames: "main/chunk-[hash]",
    define: sharedDefines,
    keepNames: true,
    minify: true,
    sourcemap: false,
    legalComments: "none",
    plugins: [createVacResolverPlugin()],
  });
  writeReadyMarker("main");

  console.log("[build:bundles] all desktop bundles compiled successfully.");
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  await buildAllDesktopBundles();
}
