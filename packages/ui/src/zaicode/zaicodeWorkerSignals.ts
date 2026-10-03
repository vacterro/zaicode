/** Terminal observations are advisory; only an owned live run can act on them. */
export interface ZaicodeWorkerLimitSignal {
  window: "five_hour" | "weekly";
  resetText: string | null;
  line: string;
}

const SCAN_CHARS = 4000;
// eslint-disable-next-line no-control-regex -- terminal protocol bytes
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;
// eslint-disable-next-line no-control-regex -- cursor-forward represents spaces
const CURSOR_FORWARD = /\u001b\[\d*C/g;
const RESET = /(?:resets?|reset at|try again in)\s+([^\n·∙|]{1,48})/i;
const FOLDER = /do you trust the (?:files|contents) (?:in|of) this (?:folder|directory)|is this a project you created or one you trust|yes,? i trust this folder|trust this folder\?|yes,? allow codex to work in this folder/i;
const VENDOR_LIMITS: Record<string, RegExp> = {
  claude: /(?:you['’]ve |you have )?hit your (?:(?:session|weekly|daily|5-hour|five-hour|monthly)\s*)?limit|(?:claude usage|5-hour|weekly|session) limit reached|you['’]ve reached your [^\n]{0,30}limit/i,
  codex: /(?:you['’]ve |you have )hit your usage limit|usage limit reached/i,
  antigravity: /(?:you have |you['’]ve )?exhausted your (?:model )?(?:capacity|quota)|model quota (?:limit )?exceeded|you have reached the quota limit for/i,
  zcode: /usage limit reached|subscription quota exhausted|coding plan limit reached|you have reached your usage limit/i,
};

export function stripZaicodeAnsi(text: string): string {
  // 重绘清屏废弃旧菜单；跨 chunk 的 ANSI 在整段缓存上解析。
  const clear = text.lastIndexOf("\x1b[2J");
  return text.slice(clear < 0 ? 0 : clear).replace(CURSOR_FORWARD, " ").replace(ANSI, "").replace(/\r\n?/g, "\n");
}

function findAtLineStart(pattern: RegExp, text: string): RegExpExecArray | null {
  const global = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
  for (let match = global.exec(text); match; match = global.exec(text)) {
    if (!/[A-Za-zЀ-ӿ]/.test(text.slice(text.lastIndexOf("\n", match.index) + 1, match.index))) return match;
  }
  return null;
}

/** Select the affirmative choice from the observed menu, never assume Enter means yes. */
export function detectZaicodeTrustInput(tail: string): string | null {
  const text = stripZaicodeAnsi(tail).slice(-SCAN_CHARS);
  const hooks = findAtLineStart(/hooks need review/i, text);
  const folder = findAtLineStart(FOLDER, text);
  if (!hooks && !folder) return null;
  const menu = text.slice(hooks?.index ?? folder!.index);
  const choices = [...menu.matchAll(/^[^\w\n]*?([>❯›▸])?\s*(\d+)\.\s*([^\n]+)/gm)];
  const selected = choices.find((choice) => Boolean(choice[1]));
  const affirmative = choices.find((choice) => hooks ? /^trust all and continue\b/i.test(choice[3]!) : /^yes\b/i.test(choice[3]!));
  if (selected && affirmative) {
    const delta = choices.indexOf(affirmative) - choices.indexOf(selected);
    return (delta < 0 ? "\x1b[A" : "\x1b[B").repeat(Math.abs(delta)) + "\r";
  }
  // Codex 有时只打印当前已选中的肯定选项，没有完整问题标题。
  return !hooks && folder && choices.some((choice) => choice[1] && /^yes\b/i.test(choice[3]!)) ? "\r" : null;
}

export function detectZaicodeVendorLimit(vendor: string | null, tail: string): ZaicodeWorkerLimitSignal | null {
  const pattern = vendor ? VENDOR_LIMITS[vendor] : undefined;
  if (!pattern) return null;
  const text = stripZaicodeAnsi(tail).slice(-SCAN_CHARS);
  const match = findAtLineStart(pattern, text);
  if (!match) return null;
  const lineStart = text.lastIndexOf("\n", match.index) + 1;
  const lineEnd = text.indexOf("\n", match.index);
  const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim();
  return { window: /weekly|week/i.test(line) ? "weekly" : "five_hour", resetText: RESET.exec(text.slice(match.index))?.[1]?.trim() ?? null, line };
}

/** Compatibility probe; the live watcher always supplies its actual vendor. */
export function detectZaicodeWorkerSignals(tail: string, vendor?: string | null): { trust: boolean; limit: ZaicodeWorkerLimitSignal | null } {
  const text = stripZaicodeAnsi(tail);
  return {
    trust: detectZaicodeTrustInput(text) !== null || findAtLineStart(FOLDER, text) !== null,
    limit: vendor !== undefined ? detectZaicodeVendorLimit(vendor, text) : Object.keys(VENDOR_LIMITS).map((name) => detectZaicodeVendorLimit(name, text)).find(Boolean) ?? null,
  };
}
