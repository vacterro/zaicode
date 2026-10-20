// T-286 (SAIHANDOFF F-06): resolves the response contract in force for a session.
//
// The host never carried such a record, so a capture could show freeform English
// replies over a session whose copy-time contract pinned `reply_language: et`,
// and nothing in the record could say whether that was a violation or an
// unenforced rule. This module reads the effective documents, hashes the bytes it
// actually read, and hands them to the ONE shared decision
// (`resolveResponseContractAdmission`). It adds no rule of its own: a document it
// cannot read stays unread, and the shared resolver reports the bounded
// limitation instead of silence.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  resolveResponseContractAdmission,
  type ResponseContractAdmission,
  type ResponseContractDocuments,
} from "@zcode/shared/zcode-protocol-v4";

/** `<saipen_home>/saipen/STYLE.md` and `EXECUTION.md`; the STATE field wins over env. */
export function saipenContractHome(
  projectRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const stateHome = projectRoot ? saipenHomeFromState(join(projectRoot, ".saipen", "STATE.md")) : null;
  return stateHome ?? (env.SAIPEN_HOME?.trim() || null);
}

function saipenHomeFromState(statePath: string): string | null {
  let text: string;
  try {
    text = readFileSync(statePath, "utf8");
  } catch {
    return null;
  }
  const match = /^saipen_home:[ \t]*["']?([^"'\r\n]+)["']?[ \t]*$/m.exec(text);
  return match?.[1]?.trim() || null;
}

/** A short content hash of exactly the bytes read, so a replay can compare them. */
export function hashResponseContractDocument(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12)}`;
}

const hashCache = new Map<string, { key: string; hash: string }>();

function readDocument(path: string): { text: string; hash: string } | null {
  try {
    const stats = statSync(path);
    const key = `${stats.mtimeMs}:${stats.size}`;
    const cached = hashCache.get(path);
    if (cached && cached.key === key) {
      return { text: readFileSync(path, "utf8"), hash: cached.hash };
    }
    const text = readFileSync(path, "utf8");
    const hash = hashResponseContractDocument(text);
    // Two documents per session; the bound only stops an unbounded path key leak.
    if (hashCache.size > 32) hashCache.clear();
    hashCache.set(path, { key, hash });
    return { text, hash };
  } catch {
    return null;
  }
}

/** The effective documents as bytes, or nulls where nothing is readable. */
export function readResponseContractDocuments(input: {
  projectRoot?: string | undefined;
  env?: NodeJS.ProcessEnv;
}): ResponseContractDocuments {
  const home = saipenContractHome(input.projectRoot, input.env ?? process.env);
  if (home === null) return {};
  const stylePath = join(home, "saipen", "STYLE.md");
  const executionPath = join(home, "saipen", "EXECUTION.md");
  const style = readDocument(stylePath);
  const execution = readDocument(executionPath);
  return {
    styleRef: style ? stylePath : null,
    executionRef: execution ? executionPath : null,
    styleText: style?.text ?? null,
    executionText: execution?.text ?? null,
    styleHash: style?.hash ?? null,
    executionHash: execution?.hash ?? null,
  };
}

let admissionCache: { key: string; admission: ResponseContractAdmission } | null = null;

/**
 * The admission record for the session rooted at `projectRoot`, memoized on the
 * STATE file and both documents so a turn loop does not re-read them per input.
 */
export function resolveSessionResponseContract(input: {
  projectRoot?: string | undefined;
  env?: NodeJS.ProcessEnv;
}): ResponseContractAdmission {
  const documents = readResponseContractDocuments(input);
  const key = [
    documents.styleRef,
    documents.styleHash,
    documents.executionRef,
    documents.executionHash,
  ].join("|");
  if (admissionCache && admissionCache.key === key) return admissionCache.admission;
  const admission = resolveResponseContractAdmission(documents);
  admissionCache = { key, admission };
  return admission;
}
