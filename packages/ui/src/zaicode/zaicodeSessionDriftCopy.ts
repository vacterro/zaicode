import type { IFileService, IZCodeSessionService, ZCodeTaskTarget } from "@zcode/services";
import {
  formatSessionDriftEvidence,
  type SessionDriftDocument,
  type SessionDriftEvidence,
} from "./zaicodeSessionDriftFormat.js";
import { parseSaipenStateFields } from "./zaicodeSaipenDetail.js";

type Files = Pick<IFileService, "stat" | "readFileRange">;
const CHUNK_BYTES = 256 * 1024;
const MAX_CONTEXT_BYTES = 2 * 1024 * 1024;

async function readDocument(
  files: Files,
  path: string,
  now: () => number,
): Promise<SessionDriftDocument> {
  const readAt = new Date(now()).toISOString();
  try {
    const before = await files.stat({ path });
    if (before.type !== "file" || before.size === undefined)
      throw new Error("File size unavailable");
    if (before.size > MAX_CONTEXT_BYTES)
      throw new Error("Context document exceeds 2 MiB; not silently truncated");
    const bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await files.readFileRange({
        path,
        offset,
        length: Math.min(CHUNK_BYTES, bytes.length - offset),
      });
      if (chunk.byteLength === 0 || chunk.byteLength > bytes.length - offset)
        throw new Error("Context file changed during read");
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const after = await files.stat({ path });
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error("Context file changed during read");
    // readTextFile 会在字节分块边界独立解码；直接读 bytes 后一次解码，保留跨块 UTF-8。
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(hash)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return { path, readAt, sha256, content };
  } catch (error) {
    return { path, readAt, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Copy-time protocol observations stay separate from the selected session transcript.
 */
export async function readSessionDriftContext(
  files: Files,
  workspacePath: string,
  now: () => number = Date.now,
): Promise<SessionDriftDocument[]> {
  const root = workspacePath.replace(/[\\/]+$/, "");
  const project = await Promise.all([
    readDocument(files, `${root}/.saipen/STATE.md`, now),
    readDocument(files, `${root}/AGENTS.md`, now),
  ]);
  const fields = new Map(parseSaipenStateFields(project[0]?.content ?? ""));
  const home = fields
    .get("saipen_home")
    ?.replace(/\\\\/g, "\\")
    .replace(/[\\/]+$/, "");
  if (!home || !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(home)) return project;
  const version = await readDocument(files, `${home}/VERSION`, now);
  let boot = await readDocument(files, `${home}/saipen/BOOT.md`, now);
  let protocol = `${home}/saipen`;
  if (boot.error) {
    const flat = await readDocument(files, `${home}/BOOT.md`, now);
    if (flat.content !== undefined) {
      boot = flat;
      protocol = home;
    }
  }
  const paths = ["INDEX.md", "STYLE.md", "EXECUTION.md", "CORE.md"];
  const phase = fields.get("phase");
  if (phase && /^[A-Z][A-Z0-9_-]{0,32}$/.test(phase))
    paths.push(`phases/${phase.toLowerCase()}.md`);
  return [
    ...project,
    version,
    boot,
    ...(await Promise.all(paths.map((path) => readDocument(files, `${protocol}/${path}`, now)))),
  ];
}

export interface SessionDriftCopyRequest {
  target: ZCodeTaskTarget;
  sessionService: Pick<IZCodeSessionService, "readSession">;
  fileService: Files;
  writeClipboardText: (text: string) => Promise<void>;
  isCurrent: () => boolean;
  now?: () => number;
  app?: SessionDriftEvidence["app"];
}

export interface SessionDriftCopyResult {
  /** Every surviving message in the captured authoritative snapshot. */
  messages: number;
  characters: number;
}

export async function copySessionDriftEvidence(
  request: SessionDriftCopyRequest,
): Promise<SessionDriftCopyResult> {
  const now = request.now ?? Date.now;
  const requestedAt = now();
  const target = { ...request.target };
  if (!target.sessionId.trim() || !target.workspacePath.trim())
    throw new Error("Invalid selected session/workspace identity; clipboard unchanged");
  const [snapshot, context] = await Promise.all([
    // 取证读取不能触发空导入历史的回填；在等待文档 IO 前捕获一次快照，隔离持续运行后的更新。
    request.sessionService.readSession({ ...target, repairImportedHistory: false })
      .then((source) => structuredClone(source)),
    readSessionDriftContext(request.fileService, target.workspacePath, now),
  ]);
  const actual = snapshot.session;
  if (
    actual.sessionId !== target.sessionId ||
    actual.workspace.workspacePath !== target.workspacePath
  )
    throw new Error("Session/workspace identity mismatch; clipboard unchanged");
  if (
    actual.workspace.workspaceIdentity &&
    actual.workspace.workspaceIdentity !== target.workspaceIdentity
  )
    throw new Error("Workspace identity mismatch; clipboard unchanged");
  if (
    snapshot.messages.some(
      (message) =>
        message.info.sessionId !== actual.sessionId ||
        message.parts.some(
          (part) =>
            part.sessionId !== actual.sessionId || part.messageId !== message.info.messageId,
        ),
    )
  )
    throw new Error("Message identity mismatch; clipboard unchanged");
  if (!request.isCurrent())
    throw new Error("Session changed or copy cancelled; clipboard unchanged");
  const evidence: SessionDriftEvidence = {
    snapshot,
    target,
    requestedAt,
    capturedAt: now(),
    context,
    app: request.app,
  };
  const text = formatSessionDriftEvidence(evidence);
  if (!request.isCurrent())
    throw new Error("Session changed or copy cancelled; clipboard unchanged");
  await request.writeClipboardText(text);
  return { messages: snapshot.messages.length, characters: text.length };
}
