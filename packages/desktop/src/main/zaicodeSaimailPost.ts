import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ZAICODE_SAIMAIL_DESK_SEAT,
  ZAICODE_SAIMAIL_OPERATOR_ALIAS,
  evaluateZaicodeSaimailPost,
  zaicodeSaimailDeskAlias,
  zaicodeSaimailDeskIsStale,
  type ZaicodeSaimailFacts,
  type ZaicodeSaimailPeerFacts,
  type ZaicodeSaimailPostAction,
  type ZaicodeSaimailPostResult,
  type ZaicodeSaimailPostStatus,
  type ZaicodeSaimailRefusedFacts,
  type ZaicodeSaimailWorkspaceFacts,
} from "@zcode/shared";

/**
 * The ZAICODE side of the SAIMAIL post office: it looks at the operator's
 * mailbox and the agents' desk, pairs them in both directions with the local
 * CLI, and proves a letter really arrives. Reading is plain files (public data
 * only, no key); every write goes through `saimail-local` itself, never through
 * a hand-edited peers.json.
 */

const CLI_TIMEOUT_MS = 60_000;
const WORKSPACE_FILE = "saimail-workspace.json";
const SEAT_PATTERN = /^[\w.-]{1,64}$/;

export interface SaimailCliResult {
  /** The executable is not on PATH. */
  missing: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}
export type SaimailCliRunner = (args: readonly string[]) => Promise<SaimailCliResult>;

export function saimailCliName(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZAICODE_SAIMAIL_CLI?.trim() || "saimail-local";
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const runSaimailCli: SaimailCliRunner = (args) =>
  new Promise((resolve) => {
    execFile(
      saimailCliName(),
      [...args],
      {
        timeout: CLI_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        // A folder with a non-ASCII name must come back as UTF-8, not the console code page.
        env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { code?: string | number }) | null;
        resolve({
          missing: failure?.code === "ENOENT",
          code: failure ? (typeof failure.code === "number" ? failure.code : 1) : 0,
          stdout,
          stderr,
          json: parseJson(stdout),
        });
      },
    );
  });

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return parseJson(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function readPeers(root: string): ZaicodeSaimailPeerFacts[] {
  const recipients = readJsonFile(join(root, "peers.json"))?.recipients;
  if (!recipients || typeof recipients !== "object") return [];
  const peers: ZaicodeSaimailPeerFacts[] = [];
  for (const [alias, entry] of Object.entries(recipients as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    peers.push({
      alias,
      seat: text(record.seat),
      recipientKid: text(record.recipient_kid),
      senderKid: text(record.sender_kid),
      addedAt: text(record.added_at),
    });
  }
  return peers;
}

function readRefused(root: string): ZaicodeSaimailRefusedFacts[] {
  const directory = join(root, "mail", "quarantine");
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const refused: ZaicodeSaimailRefusedFacts[] = [];
  for (const name of names) {
    const file = join(directory, name, "reason.json");
    const reason = text(readJsonFile(file)?.reason);
    if (!reason) continue;
    let atMs: number | null = null;
    try {
      atMs = statSync(file).mtimeMs;
    } catch {
      atMs = null;
    }
    refused.push({ id: name, reason, atMs });
  }
  return refused;
}

function countUnread(root: string, seat: string): number {
  try {
    return readdirSync(join(root, "mail", "inbox", seat), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

/** What one SAIMAIL folder says about itself. Public files only; a folder that is not a mailbox reads as `exists: false`. */
export function readSaimailWorkspaceFacts(root: string): ZaicodeSaimailWorkspaceFacts {
  const record = readJsonFile(join(root, WORKSPACE_FILE));
  const seat = text(record?.seat);
  if (!record || record.schema !== "SAIMAIL_LOCAL_WORKSPACE_1" || !seat || !SEAT_PATTERN.test(seat)) {
    return { path: root, exists: false, seat: null, recipientKid: null, senderKid: null, peers: [], unread: 0, refused: [] };
  }
  return {
    path: root,
    exists: true,
    seat,
    recipientKid: text(record.recipient_kid),
    senderKid: text(record.sender_kid),
    peers: readPeers(root),
    unread: countUnread(root, seat),
    refused: readRefused(root),
  };
}

export async function readSaimailCliFacts(run: SaimailCliRunner): Promise<ZaicodeSaimailFacts["cli"]> {
  const result = await run(["--version"]);
  if (result.missing) return { found: false, version: null };
  const first = result.stdout.split(/\r?\n/)[0]?.trim();
  return { found: result.code === 0, version: result.code === 0 && first ? first : null };
}

/**
 * A folder the operator typed may be relative or end in a slash; the CLI and the
 * peer registry both need one absolute spelling of it, or a "peer workspace" would
 * resolve against whatever directory the app happened to start in.
 */
export function absoluteSaimailPath(path: string): string {
  return resolve(path.trim());
}

export async function getZaicodeSaimailPostStatus(input: {
  operatorPath: string | null;
  deskPath: string;
  run?: SaimailCliRunner;
}): Promise<ZaicodeSaimailPostStatus> {
  const run = input.run ?? runSaimailCli;
  return evaluateZaicodeSaimailPost({
    cli: await readSaimailCliFacts(run),
    operator: input.operatorPath ? readSaimailWorkspaceFacts(absoluteSaimailPath(input.operatorPath)) : null,
    desk: readSaimailWorkspaceFacts(absoluteSaimailPath(input.deskPath)),
  });
}

export interface ZaicodeSaimailActionResult {
  ok: boolean;
  message: string;
}

function describe(result: SaimailCliResult, fallback: string): string {
  const detail = text(result.json?.detail) ?? text(result.json?.status);
  if (detail) return detail;
  const line = result.stderr.trim().split(/\r?\n/).at(-1);
  return line || fallback;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/\D/g, "").slice(0, 14);
}

/**
 * Makes the desk and pairs it with the operator mailbox in both directions.
 * Idempotent: a second run finds everything registered and changes nothing. A
 * desk that holds an old key of a recreated operator mailbox is moved aside
 * (kept, never deleted) and rebuilt, because its letters could not be opened.
 */
export async function pairZaicodeSaimail(input: {
  operatorPath: string;
  deskPath: string;
  run?: SaimailCliRunner;
  now?: Date;
}): Promise<ZaicodeSaimailActionResult> {
  const run = input.run ?? runSaimailCli;
  const operatorPath = absoluteSaimailPath(input.operatorPath);
  const deskPath = absoluteSaimailPath(input.deskPath);
  const operator = readSaimailWorkspaceFacts(operatorPath);
  if (!operator.exists) return { ok: false, message: "Your mailbox does not exist yet. Create it first." };
  const version = await run(["--version"]);
  if (version.missing) {
    return { ok: false, message: `${saimailCliName()} was not found on PATH. Install SAIMAIL, then restart ZAICODE.` };
  }

  let desk = readSaimailWorkspaceFacts(deskPath);
  if (desk.exists && zaicodeSaimailDeskIsStale(operator, desk)) {
    renameSync(deskPath, `${deskPath}.stale-${stamp(input.now ?? new Date())}`);
    desk = readSaimailWorkspaceFacts(deskPath);
  }
  mkdirSync(dirname(deskPath), { recursive: true });
  if (!desk.exists) {
    const created = await run(["init", "--workspace", deskPath, "--seat", ZAICODE_SAIMAIL_DESK_SEAT, "--json"]);
    if (created.code !== 0 || created.json?.ok !== true) {
      return { ok: false, message: `Could not create the agent desk: ${describe(created, "saimail-local init failed")}` };
    }
    desk = readSaimailWorkspaceFacts(deskPath);
    if (!desk.exists) return { ok: false, message: "The agent desk was created but cannot be read back." };
  }

  const cards = mkdtempSync(join(dirname(deskPath), "cards-"));
  try {
    const operatorCard = join(cards, "operator.card.json");
    const deskCard = join(cards, "desk.card.json");
    for (const [workspace, card, who] of [
      [operatorPath, operatorCard, "your mailbox"],
      [deskPath, deskCard, "the agent desk"],
    ] as const) {
      const exported = await run(["identity", "--workspace", workspace, "--export-card", card, "--json"]);
      if (exported.code !== 0 || !existsSync(card)) {
        return { ok: false, message: `Could not read the public identity of ${who}: ${describe(exported, "saimail-local identity failed")}` };
      }
    }

    // The desk must be able to address the operator ...
    const deskSide = await run([
      "recipient", "add", "--workspace", deskPath, "--alias", ZAICODE_SAIMAIL_OPERATOR_ALIAS,
      "--card", operatorCard, "--peer-workspace", operatorPath, "--json",
    ]);
    if (deskSide.json?.ok !== true) {
      return { ok: false, message: `The desk could not register your mailbox: ${describe(deskSide, "saimail-local recipient add failed")}` };
    }
    // ... and the operator's post office must accept the desk's key, or the letter is refused on arrival.
    let operatorSide = await run([
      "recipient", "add", "--workspace", operatorPath, "--alias", zaicodeSaimailDeskAlias(desk.recipientKid, 0),
      "--card", deskCard, "--peer-workspace", deskPath, "--json",
    ]);
    if (operatorSide.json?.ok !== true && operatorSide.json?.status === "RECIPIENT_CONFLICT") {
      operatorSide = await run([
        "recipient", "add", "--workspace", operatorPath, "--alias", zaicodeSaimailDeskAlias(desk.recipientKid, 1),
        "--card", deskCard, "--peer-workspace", deskPath, "--json",
      ]);
    }
    if (operatorSide.json?.ok !== true) {
      return { ok: false, message: `Your mailbox could not register the desk: ${describe(operatorSide, "saimail-local recipient add failed")}` };
    }
  } finally {
    rmSync(cards, { recursive: true, force: true });
  }

  const status = evaluateZaicodeSaimailPost({
    cli: { found: true, version: null },
    operator: readSaimailWorkspaceFacts(operatorPath),
    desk: readSaimailWorkspaceFacts(deskPath),
  });
  return status.deskReady
    ? { ok: true, message: "Paired. Agents can write to you now, and your mailbox accepts them." }
    : { ok: false, message: "Both sides registered, but the check still fails; open the checks below." };
}

/** Sends one letter from the desk to the operator and confirms it landed in the unread folder. */
export async function sendZaicodeSaimailTestLetter(input: {
  operatorPath: string;
  deskPath: string;
  run?: SaimailCliRunner;
  now?: Date;
}): Promise<ZaicodeSaimailActionResult> {
  const run = input.run ?? runSaimailCli;
  const operatorPath = absoluteSaimailPath(input.operatorPath);
  const deskPath = absoluteSaimailPath(input.deskPath);
  const operator = readSaimailWorkspaceFacts(operatorPath);
  const desk = readSaimailWorkspaceFacts(deskPath);
  const status = evaluateZaicodeSaimailPost({ cli: { found: true, version: null }, operator, desk });
  if (!status.deskReady) return { ok: false, message: "Not paired yet. Use Set up delivery first." };

  const when = (input.now ?? new Date()).toISOString();
  const sent = await run([
    "send", "--workspace", deskPath, "--to", ZAICODE_SAIMAIL_OPERATOR_ALIAS,
    "--kind", "PERSONAL_MESSAGE", "--topic", "zaicode-check",
    "--claim", `ZAICODE test letter ${when}. If the envelope in the title bar lights up, agent letters reach you.`,
    "--json",
  ]);
  if (sent.missing) return { ok: false, message: `${saimailCliName()} was not found on PATH.` };
  const outcome = text(sent.json?.status);
  const delivery = sent.json?.delivery as { reason?: unknown } | undefined;
  if (outcome === "QUARANTINED") {
    return { ok: false, message: `Refused on arrival: ${text(delivery?.reason) ?? "unknown reason"}. Run Set up delivery again.` };
  }
  if (outcome !== "ACCEPTED") return { ok: false, message: `Not delivered: ${describe(sent, "saimail-local send failed")}` };

  const envelopeId = text((sent.json?.message as { envelope_id?: unknown } | undefined)?.envelope_id)?.replace(/^sha256:/, "");
  const landed = Boolean(envelopeId) && existsSync(join(operatorPath, "mail", "inbox", operator.seat ?? "", envelopeId!));
  return landed
    ? { ok: true, message: "Delivered. The envelope in the title bar shows the letter within a few seconds." }
    : { ok: false, message: "The post office accepted the letter but it is not in your unread folder." };
}

let busy = false;

/**
 * The one entry the Settings buttons use. Serialised, because two pairings at
 * once would both try to create the desk, and never throwing across the IPC
 * boundary: a locked folder or a full disk becomes a message the operator can read.
 */
export async function runZaicodeSaimailPostAction(input: {
  action: ZaicodeSaimailPostAction;
  operatorPath: string | null;
  deskPath: string;
  run?: SaimailCliRunner;
  now?: Date;
}): Promise<ZaicodeSaimailPostResult> {
  const statusOf = () => getZaicodeSaimailPostStatus({ operatorPath: input.operatorPath, deskPath: input.deskPath, run: input.run });
  if (!input.operatorPath) return { ok: false, message: "Choose your mailbox folder and create it first.", status: await statusOf() };
  if (busy) return { ok: false, message: "Another SAIMAIL action is still running.", status: await statusOf() };
  busy = true;
  try {
    const outcome =
      input.action === "pair"
        ? await pairZaicodeSaimail({ operatorPath: input.operatorPath, deskPath: input.deskPath, run: input.run, now: input.now })
        : await sendZaicodeSaimailTestLetter({ operatorPath: input.operatorPath, deskPath: input.deskPath, run: input.run, now: input.now });
    return { ...outcome, status: await statusOf() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), status: await statusOf() };
  } finally {
    busy = false;
  }
}
