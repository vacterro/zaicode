import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { isZaicodeProductMode, type Locale } from "@zcode/shared";

// ZAICODE 与本机正式版 ZCode 并排安装：此前共用 "ZCode.OpenInZCode" 键，
// ZAICODE 启动时把正式版的「Open in ZCode」改指向 ZAICODE.exe。ZAICODE 使用独立键与文案。
const UPSTREAM_MENU_KEY_NAME = "ZCode.OpenInZCode";
const ZAICODE_MENU_KEY_NAME = "ZAICODE.OpenInZAICODE";
const menuKeys = (name: string) => [
  `HKCU\\Software\\Classes\\Directory\\shell\\${name}`,
  `HKCU\\Software\\Classes\\Drive\\shell\\${name}`,
];
const MENU_LABELS: Record<Locale, string> = {
  "zh-CN": "在ZCode中打开",
  "en-US": "Open in ZCode",
};
const ZAICODE_MENU_LABELS: Record<Locale, string> = {
  "zh-CN": "在ZAICODE中打开",
  "en-US": "Open in ZAICODE",
};

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

interface WindowsOpenFolderRegistryOperation {
  args: string[];
}

function getWindowsOpenFolderMenuName(locale: Locale): string {
  const labels = isZaicodeProductMode() ? ZAICODE_MENU_LABELS : MENU_LABELS;
  return labels[locale] ?? labels["en-US"];
}

function quoteWindowsCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildWindowsOpenFolderCommand(
  executablePath: string,
  appArgs: readonly string[] = [],
): string {
  return [
    quoteWindowsCommandArg(executablePath),
    ...appArgs.map(quoteWindowsCommandArg),
    "--open-workspace",
    '"%1"',
  ].join(" ");
}

function buildWindowsOpenFolderRegistryOperations(options: {
  executablePath: string;
  appArgs?: readonly string[];
  locale: Locale;
}): WindowsOpenFolderRegistryOperation[] {
  const command = buildWindowsOpenFolderCommand(options.executablePath, options.appArgs ?? []);
  const menuName = getWindowsOpenFolderMenuName(options.locale);
  const keys = menuKeys(isZaicodeProductMode() ? ZAICODE_MENU_KEY_NAME : UPSTREAM_MENU_KEY_NAME);

  return keys.flatMap((menuKey) => [
    { args: ["add", menuKey, "/ve", "/d", menuName, "/f"] },
    { args: ["add", menuKey, "/v", "MUIVerb", "/t", "REG_SZ", "/d", menuName, "/f"] },
    { args: ["add", menuKey, "/v", "Icon", "/t", "REG_SZ", "/d", options.executablePath, "/f"] },
    { args: ["add", `${menuKey}\\command`, "/ve", "/d", command, "/f"] },
  ]);
}

function runRegAdd(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("reg.exe", [...args], {
      stdio: "ignore",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`reg.exe exited with code ${code ?? "unknown"}`));
    });
  });
}

function readRegDefault(key: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn("reg.exe", ["query", key, "/ve"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => resolvePromise(null));
    child.on("exit", (code) => resolvePromise(code === 0 ? output : null));
  });
}

/**
 * 只移除指向本 ZAICODE 可执行文件的旧「Open in ZCode」项（历史上被 ZAICODE 覆盖的那一条）；
 * 指向正式版 ZCode 的条目保持不动。
 */
async function releaseUpstreamMenuTakenByZaicode(executablePath: string): Promise<boolean> {
  const needle = executablePath.toLowerCase();
  let released = false;
  for (const key of menuKeys(UPSTREAM_MENU_KEY_NAME)) {
    const command = await readRegDefault(`${key}\\command`);
    if (!command?.toLowerCase().includes(needle)) continue;
    await runRegAdd(["delete", key, "/f"]).catch(() => undefined);
    released = true;
  }
  return released;
}

export async function installWindowsOpenFolderContextMenu(options: {
  platform: NodeJS.Platform;
  executablePath: string;
  argv: readonly string[];
  isDefaultApp: boolean;
  locale: Locale;
  logger: Logger;
}): Promise<void> {
  if (options.platform !== "win32") {
    return;
  }

  const appArgs =
    // 开发态 Windows 的 process.execPath 是 Electron 可执行文件。
    // 注册表命令必须同时带上应用入口，否则 Explorer 右键菜单只能启动空 Electron。
    options.isDefaultApp && options.argv[1] ? [resolve(options.argv[1])] : [];
  const operations = buildWindowsOpenFolderRegistryOperations({
    executablePath: options.executablePath,
    appArgs,
    locale: options.locale,
  });

  try {
    await Promise.all(operations.map((operation) => runRegAdd(operation.args)));
    const releasedUpstreamMenu = isZaicodeProductMode()
      ? await releaseUpstreamMenuTakenByZaicode(options.executablePath)
      : false;

    options.logger.info("[open-folder] Windows Explorer 右键菜单已安装或更新", {
      executablePath: options.executablePath,
      hasDefaultAppEntry: appArgs.length > 0,
      locale: options.locale,
      releasedUpstreamMenu,
    });
  } catch (error) {
    options.logger.warn("[open-folder] Windows Explorer 右键菜单安装失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
