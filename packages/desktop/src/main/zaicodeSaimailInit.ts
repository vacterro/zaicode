import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SAIMAIL_CLI = "saimail-local";
const OPERATOR_SEAT = "operator";
const INIT_TIMEOUT_MS = 60_000;

interface SaimailCommandResult {
  ok?: unknown;
  detail?: unknown;
  status?: unknown;
}

function describe(stdout: string, fallback: string): string {
  try {
    const parsed = JSON.parse(stdout) as SaimailCommandResult;
    if (typeof parsed.detail === "string" && parsed.detail) return parsed.detail;
    if (typeof parsed.status === "string" && parsed.status) return parsed.status;
  } catch {
    // saimail-local 没有输出 JSON（旧版本或崩溃）：退回到进程层面的错误信息。
  }
  return fallback;
}

/**
 * Creates the operator's SAIMAIL mailbox in `workspace` with the local CLI
 * (`saimail-local init --seat operator`). Only called from an explicit click
 * in Settings -> ZAICODE -> SAIMAIL; ZAICODE never creates mailboxes on its own.
 * An existing mailbox is reported as success without touching it.
 */
export function initZaicodeSaimailWorkspace(
  workspace: string,
): Promise<{ ok: boolean; message: string }> {
  if (existsSync(join(workspace, "saimail-workspace.json"))) {
    return Promise.resolve({ ok: true, message: "Mailbox already exists." });
  }
  return new Promise((resolve) => {
    execFile(
      SAIMAIL_CLI,
      ["init", "--workspace", workspace, "--seat", OPERATOR_SEAT, "--json"],
      { timeout: INIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, message: describe(stdout, "Mailbox created.") });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          resolve({
            ok: false,
            message: `${SAIMAIL_CLI} was not found on PATH. Install SAIMAIL, then restart ZAICODE.`,
          });
          return;
        }
        resolve({
          ok: false,
          message: describe(stdout, stderr.trim().split(/\r?\n/).at(-1) || error.message),
        });
      },
    );
  });
}
