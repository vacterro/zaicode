import type { IFileService } from "@zcode/services";

/**
 * Shared filesystem primitives for the drift capture center.
 *
 * Every helper here is deliberately small and side-effect free so the capture
 * batch, the review pack exporter and the tests can share one truth about
 * paths, digests and atomic writes.
 */

export const MAX_INDEX_BYTES = 256 * 1024;
export const MAX_REDACT_BYTES = 8 * 1024 * 1024;
/** A batch manifest is read whole; past this size it is a broken vault, not a document. */
export const MAX_JSON_BYTES = 64 * 1024 * 1024;

export type CaptureFiles = Pick<
  IFileService,
  | "writeTextFile"
  | "writeTextFileAtomic"
  | "sha256File"
  | "stat"
  | "readTextFile"
  | "readFileRange"
>;

export type PackFiles = Pick<
  IFileService,
  | "writeTextFile"
  | "writeTextFileAtomic"
  | "sha256File"
  | "stat"
  | "readTextFile"
  | "readFileRange"
  | "copyFile"
  | "createZipArchive"
>;

export interface SourceManifest {
  batchId: string;
  createdAt: string;
  status: "CAPTURING" | "COMPLETE" | "PARTIAL" | "FAILED";
  projects?: unknown[];
  discovery?: {
    status?: string;
    failedProjects?: number;
    selectedProjects?: unknown[];
  };
  perSessionResults?: Array<{
    sessionId: string;
    projectPath?: string;
    outputPath?: string;
    /** Digest of the published evidence, absent on pre-T-395 manifests. */
    sha256?: string;
    state?: string;
  }>;
}

/**
 * UTF-8 byte length of a string without allocating the encoded copy.
 *
 * The capture needs the expected size of the evidence file to prove that the
 * bytes on disk are the whole text; a second full-size buffer in the renderer
 * is exactly what the bounded-memory rule forbids.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // A high surrogate is a code point only when a low surrogate follows.
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function joinPath(...parts: string[]): string {
  const [head, ...rest] = parts;
  return [
    (head ?? "").replace(/[\\/]+$/, ""),
    ...rest.map((part) => part.replace(/^[\\/]+|[\\/]+$/g, "")),
  ]
    .filter((part, index) => index === 0 || part.length > 0)
    .join("/");
}

export async function writeJson(
  fileService: CaptureFiles,
  path: string,
  value: unknown,
  overwrite = true,
): Promise<{ path: string; size: number }> {
  return fileService.writeTextFileAtomic({
    path,
    content: `${JSON.stringify(value, null, 2)}\n`,
    overwrite,
  });
}

export async function readText(
  fileService: Pick<IFileService, "readTextFile">,
  path: string,
  length = MAX_INDEX_BYTES,
): Promise<string | undefined> {
  const slice = await fileService.readTextFile({ path, length });
  if (slice.isBinary || !slice.content) return undefined;
  return slice.content;
}

export async function readJson<T>(
  fileService: Pick<IFileService, "readTextFile">,
  path: string,
): Promise<T | undefined> {
  try {
    const content = await readText(fileService, path);
    return content ? (JSON.parse(content) as T) : undefined;
  } catch {
    return undefined;
  }
}

export type DriftDocumentErrorCode = "READ_FAILED" | "TOO_LARGE" | "MALFORMED";

export class DriftDocumentError extends Error {
  constructor(
    readonly code: DriftDocumentErrorCode,
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "DriftDocumentError";
  }
}

/**
 * Read a whole JSON document without the 256 KiB index slice.
 *
 * `readJson` above is deliberately forgiving: it serves optional side files
 * where "absent" and "unreadable" mean the same thing. A batch manifest is
 * different — mistaking a large-but-valid manifest for a missing one makes a
 * resume recapture everything, so truncation, invalid UTF-8 and malformed JSON
 * are distinct, fatal errors here, and only a genuinely absent file yields
 * `undefined`.
 */
export async function readJsonExact<T>(
  fileService: Pick<IFileService, "stat" | "readFileRange">,
  path: string,
  options: { maxBytes?: number } = {},
): Promise<T | undefined> {
  let fileStat: Awaited<ReturnType<IFileService["stat"]>>;
  try {
    fileStat = await fileService.stat({ path });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new DriftDocumentError("READ_FAILED", `Cannot stat ${path}`, path);
  }
  if (fileStat.type !== "file") {
    throw new DriftDocumentError("READ_FAILED", `Not a file: ${path}`, path);
  }
  const maxBytes = options.maxBytes ?? MAX_JSON_BYTES;
  const size = fileStat.size ?? 0;
  if (size > maxBytes) {
    throw new DriftDocumentError(
      "TOO_LARGE",
      `${path} is ${size} bytes, above the ${maxBytes} byte limit`,
      path,
    );
  }
  let content: string;
  try {
    content = await readFullText(fileService, path, size);
  } catch {
    throw new DriftDocumentError("READ_FAILED", `Cannot read ${path}`, path);
  }
  try {
    return content.trim() ? (JSON.parse(content) as T) : undefined;
  } catch {
    throw new DriftDocumentError("MALFORMED", `Malformed JSON in ${path}`, path);
  }
}

export function sanitize(name: string): string {
  // eslint-disable-next-line no-control-regex -- Windows forbids control chars in file names.
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80) || "project";
}

export function shortHash(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export function listPackFiles(partCount: number): string[] {
  if (partCount <= 1) {
    return ["index.md", "manifest.json", "missing-sources.md", "checksums.sha256.txt", "verify.mjs"];
  }
  return [
    "index.md",
    "manifest.json",
    "missing-sources.md",
    ...Array.from({ length: partCount }, (_, i) => `part-${String(i + 1).padStart(2, "0")}`),
  ];
}

export function parentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "." : normalized.slice(0, index);
}

export function relativeInside(root: string, path: string): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith(`${normalizedRoot}/`)
    ? normalized.slice(normalizedRoot.length + 1)
    : normalized;
}

export function sessionDirOf(relativeEvidence: string): string {
  const slash = relativeEvidence.lastIndexOf("/");
  return slash === -1 ? "" : relativeEvidence.slice(0, slash + 1);
}

/**
 * Identity of a resumable session.
 *
 * A session id alone is not unique: the same id can exist in two workspaces,
 * and skipping the wrong one leaves a hole in the batch that nothing reports.
 */
export function resumeSessionKey(workspacePath: string, sessionId: string): string {
  return `${workspacePath.replace(/\\/g, "/").toLowerCase()}\u0000${sessionId}`;
}

export async function readFullText(
  fileService: Pick<IFileService, "readFileRange" | "stat">,
  path: string,
  expectedSize: number,
): Promise<string> {
  const chunk = 256 * 1024;
  const bytes = new Uint8Array(expectedSize);
  let offset = 0;
  while (offset < bytes.length) {
    const part = await fileService.readFileRange({
      path,
      offset,
      length: Math.min(chunk, bytes.length - offset),
    });
    if (part.byteLength === 0) throw new Error("Evidence changed during export");
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  const after = await fileService.stat({ path });
  if ((after.size ?? -1) !== expectedSize) throw new Error("Evidence changed during export");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export const VERIFY_SCRIPT = `import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
let failures = 0;
for (const session of manifest.sessions ?? []) {
  const target = join(root, session.evidence);
  const bytes = await readFile(target);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const ok = digest === session.sha256;
  if (!ok) failures += 1;
  console.log((ok ? "OK   " : "FAIL ") + session.evidence);
}
if (failures > 0) {
  console.error(failures + " file(s) failed digest verification");
  process.exit(1);
}
console.log("All " + (manifest.sessions ?? []).length + " evidence file(s) verified");
`;
