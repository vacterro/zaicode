import { app, type WebContents } from "electron";
import { statSync } from "node:fs";
import {
  ZAICODE_SUBCHAT_ARG_PROMPT_MAX,
  ZAICODE_SUBCHAT_ARG_PROMPT_VENDORS,
  buildZaicodeSubchatInvocation,
  isZaicodeSubchatVendor,
  zaicodeSubchatAutoModel,
  zaicodeSubchatUnavailableReason,
  type ZaicodeSubchatEvent,
} from "@zcode/shared";
import { writeZaicodePromptFile } from "./zaicodePromptFiles.js";
import { getZaicodeEnginesState, killZaicodeProcessTree, zaicodeCliCommand } from "./zaicodeEngines.js";
import { startZaicodeSubchatProcess, type ZaicodeSubchatProcess } from "./zaicodeSubchatProcess.js";

/**
 * ZAICODE subscription chat, main-process half (T-51): runs one chat turn as
 * the account's own CLI in headless mode and streams parsed events to the
 * window that asked. No terminal, no worker record, no PTY.
 *
 * The renderer names only an account id, a project folder, the prompt and
 * the session to resume; the executable, its home and its flags come from
 * main's own engines state, so a renderer can never choose what runs.
 * A turn stops on Stop, when its window closes, or when ZAICODE quits; only
 * the process tree this module started is ever killed.
 */

export const ZAICODE_SUBCHAT_EVENT_CHANNEL = "zaicode:subchat-event";

const PROMPT_MAX_CHARS = 200_000;
const TURN_ID_PATTERN = /^[A-Za-z0-9:_-]{1,96}$/;

const turns = new Map<string, ZaicodeSubchatProcess>();
let quitHookInstalled = false;

export interface ZaicodeSubchatTurnRequest {
  turnId: string;
  accountId: string;
  projectPath: string;
  prompt: string;
  sessionId: string | null;
}

export function readZaicodeSubchatTurnRequest(raw: unknown): ZaicodeSubchatTurnRequest {
  const value = (raw ?? {}) as Record<string, unknown>;
  if (typeof value.turnId !== "string" || !TURN_ID_PATTERN.test(value.turnId)) throw new TypeError("Expected a turn id");
  if (typeof value.accountId !== "string" || !value.accountId) throw new TypeError("Expected an account id");
  if (typeof value.projectPath !== "string" || !value.projectPath) throw new TypeError("Expected a project folder");
  if (typeof value.prompt !== "string" || !value.prompt.trim()) throw new TypeError("Expected a prompt");
  return {
    turnId: value.turnId,
    accountId: value.accountId,
    projectPath: value.projectPath,
    prompt: value.prompt.slice(0, PROMPT_MAX_CHARS),
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function childEnv(changes: Record<string, string | null>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

function installQuitHook(): void {
  if (quitHookInstalled) return;
  quitHookInstalled = true;
  app.once("will-quit", () => {
    for (const turn of turns.values()) turn.stop();
    turns.clear();
  });
}

/** Starts one turn; events arrive on ZAICODE_SUBCHAT_EVENT_CHANNEL, the last one is always `result`. */
export async function runZaicodeSubchatTurn(
  request: ZaicodeSubchatTurnRequest,
  sender: WebContents,
): Promise<{ ok: boolean; message: string }> {
  if (turns.has(request.turnId)) return { ok: false, message: "This turn is already running." };
  const engines = getZaicodeEnginesState();
  const account = engines.accounts.find((item) => item.id === request.accountId);
  if (!account) return { ok: false, message: "That subscription is no longer discovered on this machine." };
  const unavailable = zaicodeSubchatUnavailableReason(account);
  if (unavailable || !account.cli || !isZaicodeSubchatVendor(account.vendor)) {
    return { ok: false, message: unavailable ?? `${account.label} cannot chat inside ZAICODE.` };
  }
  if (!isDirectory(request.projectPath)) return { ok: false, message: `Project folder not found: ${request.projectPath}` };
  // Antigravity / ZCode read the prompt only from the command line (SRC-048): a long one goes via a file.
  let promptFile: string | null = null;
  if (ZAICODE_SUBCHAT_ARG_PROMPT_VENDORS.includes(account.vendor) && request.prompt.length > ZAICODE_SUBCHAT_ARG_PROMPT_MAX) {
    const written = await writeZaicodePromptFile(request.prompt);
    if (!written.ok) {
      return {
        ok: false,
        message: `The prompt is too long for ${account.label}'s command line and could not be written to a file: ${written.message}`,
      };
    }
    promptFile = written.path;
  }
  if (turns.has(request.turnId)) return { ok: false, message: "This turn is already running." };
  // Antigravity: the pool that still has quota (SRC-048), not the CLI's default Gemini one when that is spent.
  const model = zaicodeSubchatAutoModel(account.vendor, engines.limits[account.id]?.windows);
  const invocation = buildZaicodeSubchatInvocation(account, {
    prompt: request.prompt,
    sessionId: request.sessionId,
    yolo: engines.config.workerYolo,
    model,
    promptFile,
  });
  if (!invocation) return { ok: false, message: `${account.label} cannot chat inside ZAICODE.` };

  const command = zaicodeCliCommand(account.cli, invocation.args);
  const send = (raw: ZaicodeSubchatEvent) => {
    // A CLI that does not name its model (Antigravity) still shows the one ZAICODE asked for.
    const event = raw.type === "session" && !raw.model && model ? { ...raw, model } : raw;
    if (!sender.isDestroyed()) sender.send(ZAICODE_SUBCHAT_EVENT_CHANNEL, { turnId: request.turnId, event });
  };
  const turn = startZaicodeSubchatProcess({
    file: command.file,
    args: command.args,
    cwd: request.projectPath,
    env: childEnv(invocation.env),
    stdin: invocation.stdin,
    vendor: account.vendor,
    short: account.short,
    onEvent: send,
    kill: killZaicodeProcessTree,
  });
  installQuitHook();
  turns.set(request.turnId, turn);
  const stopOnClose = () => turn.stop();
  sender.once("destroyed", stopOnClose);
  void turn.done.then(() => {
    turns.delete(request.turnId);
    if (!sender.isDestroyed()) sender.removeListener("destroyed", stopOnClose);
  });
  return { ok: true, message: model ? `${account.short} is answering (${model})` : `${account.short} is answering` };
}

/** Stops a running turn (its whole process tree). False when no such turn runs. */
export function cancelZaicodeSubchatTurn(turnId: unknown): boolean {
  if (typeof turnId !== "string") return false;
  const turn = turns.get(turnId);
  if (!turn) return false;
  turn.stop();
  return true;
}
