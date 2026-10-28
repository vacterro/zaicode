import {
  isZaicodeSaimailEnvelopeId,
  parseZaicodeSaimailOpenedLetter,
  parseZaicodeSaimailReadLetterList,
  zaicodeSaimailOpenCommand,
  type ZaicodeSaimailLetterState,
  type ZaicodeSaimailOpenedLetter,
  type ZaicodeSaimailReadLetterList,
} from "@zcode/shared";
import { absoluteSaimailPath, runSaimailCli, type SaimailCliRunner } from "./zaicodeSaimailPost.js";

/**
 * The operator's letter reader: thin shell over the canonical `saimail-local`
 * commands (`inbox --state READ`, `open`, `reopen`). The CLI stays the only
 * thing that decrypts, transitions durable read state, or reopens; this file
 * adds no crypto, no read-state bookkeeping and no storage. Plaintext lives in
 * the command's stdout and the IPC reply, never in a file.
 */

export async function listZaicodeSaimailReadLetters(input: {
  workspace: string | null;
  run?: SaimailCliRunner;
}): Promise<ZaicodeSaimailReadLetterList> {
  if (!input.workspace) return { ok: false, letters: [], message: "Choose your mailbox folder in Settings first." };
  const run = input.run ?? runSaimailCli;
  const result = await run(["inbox", "--workspace", absoluteSaimailPath(input.workspace), "--state", "READ", "--json"]);
  if (result.missing) {
    return { ok: false, letters: [], message: "saimail-local was not found on PATH. Install SAIMAIL, then restart ZAICODE." };
  }
  return parseZaicodeSaimailReadLetterList(result.json);
}

export async function openZaicodeSaimailLetter(input: {
  workspace: string | null;
  envelopeId: string;
  state: ZaicodeSaimailLetterState;
  run?: SaimailCliRunner;
}): Promise<ZaicodeSaimailOpenedLetter> {
  if (!input.workspace) {
    return { ok: false, state: null, body: null, message: "Choose your mailbox folder in Settings first." };
  }
  if (!isZaicodeSaimailEnvelopeId(input.envelopeId)) {
    return { ok: false, state: null, body: null, message: "Not a valid envelope id." };
  }
  const run = input.run ?? runSaimailCli;
  const command = zaicodeSaimailOpenCommand(input.state);
  const result = await run([
    command,
    "--workspace",
    absoluteSaimailPath(input.workspace),
    "--envelope",
    input.envelopeId,
    "--json",
  ]);
  if (result.missing) {
    return { ok: false, state: null, body: null, message: "saimail-local was not found on PATH. Install SAIMAIL, then restart ZAICODE." };
  }
  return parseZaicodeSaimailOpenedLetter(result.json);
}
