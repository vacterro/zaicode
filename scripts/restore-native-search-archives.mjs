#!/usr/bin/env node
/** Explicit recovery for source-only mirrors; packaging itself never downloads. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import { get } from "node:https";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  NATIVE_SEARCH_DEPENDENCIES_DIR,
  resolveNativeSearchPrebuiltPlan,
} from "./native-search-tools-config.mjs";
import { resolveRemoteNativeSearchPrebuiltPlan } from "./remote-native-search-tools-config.mjs";

export const ARCHIVE_SOURCE_REVISION = "a7b8af79d6819f356275488aa2d40c4416cc8613";
const SOURCE_ROOT = `https://raw.githubusercontent.com/vacterro/zaicode/${ARCHIVE_SOURCE_REVISION}/apps/zcode-cli/dependencies/native-search/`;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function checkedRelativePath(path) {
  if (typeof path !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path)
      || path.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Unsafe native search archive path");
  }
  return path;
}

export function resolveArchiveRequests({ platform, arch, all = false, remote = false } = {}) {
  if (all && (platform || arch || remote)) throw new Error("--all cannot select a single target");
  const plans = [];
  if (all) {
    for (const targetPlatform of ["darwin", "linux", "win32"]) {
      for (const targetArch of ["arm64", "x64"]) {
        plans.push(resolveNativeSearchPrebuiltPlan({ platform: targetPlatform, arch: targetArch }));
        if (targetPlatform === "darwin") {
          plans.push(resolveRemoteNativeSearchPrebuiltPlan({ platform: targetPlatform, arch: targetArch }));
        }
      }
    }
  } else {
    const resolver = remote ? resolveRemoteNativeSearchPrebuiltPlan : resolveNativeSearchPrebuiltPlan;
    plans.push(resolver({ platform, arch }));
  }
  const declared = JSON.parse(readFileSync(
    resolve(import.meta.dirname, "../third-party/native-search/sources.json"), "utf8",
  )).archives;
  const inventory = new Map(declared.map((item) => [item.archive, item.sha256]));
  const requests = new Map();
  for (const plan of plans) {
    for (const artifact of plan.artifacts) {
      const path = checkedRelativePath(relative(NATIVE_SEARCH_DEPENDENCIES_DIR, artifact.archivePath).split(sep).join("/"));
      if (inventory.get(path) !== artifact.archiveSha256) {
        throw new Error(`Native search inventory/config pin mismatch: ${path}`);
      }
      if (requests.has(path) && requests.get(path).sha256 !== artifact.archiveSha256) {
        throw new Error(`Conflicting native search archive pins: ${path}`);
      }
      requests.set(path, { path, sha256: artifact.archiveSha256 });
    }
  }
  return [...requests.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function statIfPresent(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function checkDirectoryChain(path) {
  const parent = dirname(path);
  if (parent !== path) checkDirectoryChain(parent);
  const stat = statIfPresent(path);
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw new Error(`Unsafe native search directory: ${path}`);
  }
}

function checkDestination(root, descriptor) {
  const path = checkedRelativePath(descriptor.path);
  if (!/^[a-f0-9]{64}$/.test(descriptor.sha256)) throw new Error("Invalid native search archive SHA-256");
  const destination = resolve(root, path);
  const rel = relative(root, destination);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Native search archive escaped its dependency directory");
  }
  checkDirectoryChain(dirname(destination));
  const stat = statIfPresent(destination);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    throw new Error(`Unsafe native search archive: ${path}`);
  }
  if (stat && sha256(readFileSync(destination)) !== descriptor.sha256) {
    throw new Error(`Existing native search archive checksum mismatch: ${path}; preserve it for inspection`);
  }
  return { ...descriptor, destination, present: Boolean(stat) };
}

function downloadPinnedArchive(url) {
  return new Promise((resolveDownload, reject) => {
    // No credentials, redirects or mirror fallback. The URL has one fixed origin/revision.
    const request = get(url, { headers: { "User-Agent": "ZAICODE-source-archive-recovery" } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Native search archive HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_ARCHIVE_BYTES) response.destroy(new Error("Native search archive exceeds size limit"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolveDownload(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.setTimeout(30_000, () => request.destroy(new Error("Native search archive request timed out")));
    request.on("error", reject);
  });
}

function ensureDirectory(path) {
  checkDirectoryChain(path);
  if (statIfPresent(path)) return;
  const parent = dirname(path);
  if (parent !== path) ensureDirectory(parent);
  try { mkdirSync(path); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  checkDirectoryChain(path);
}

/** Low-level injection permits offline fixture tests; the CLI always resolves committed pins. */
export async function restoreArchiveSet(descriptors, {
  dependenciesDir = NATIVE_SEARCH_DEPENDENCIES_DIR,
  download = downloadPinnedArchive,
} = {}) {
  const root = resolve(dependenciesDir);
  const paths = new Set();
  const initial = descriptors.map((descriptor) => {
    if (paths.has(descriptor.path)) throw new Error("Duplicate native search archive path");
    paths.add(descriptor.path);
    return checkDestination(root, descriptor);
  });
  const pending = [];
  // Check every response before creating directories or writing any missing archive.
  for (const descriptor of initial.filter((item) => !item.present)) {
    const bytes = await download(SOURCE_ROOT + descriptor.path);
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ARCHIVE_BYTES || sha256(bytes) !== descriptor.sha256) {
      throw new Error(`Downloaded native search archive checksum mismatch: ${descriptor.path}`);
    }
    pending.push({ ...descriptor, bytes });
  }
  const beforeWrite = initial.map((descriptor) => checkDestination(root, descriptor));
  const restored = [];
  for (const descriptor of pending) {
    if (beforeWrite.find((item) => item.path === descriptor.path).present) continue;
    ensureDirectory(dirname(descriptor.destination));
    const current = checkDestination(root, descriptor);
    if (current.present) continue;
    const temporary = resolve(dirname(descriptor.destination), `.restore-${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, descriptor.bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      checkDestination(root, descriptor);
      // An atomic no-clobber link refuses any file that appeared concurrently.
      linkSync(temporary, descriptor.destination);
      restored.push(descriptor.path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (statIfPresent(temporary)) unlinkSync(temporary);
    }
  }
  for (const descriptor of initial) {
    if (!checkDestination(root, descriptor).present) throw new Error("Native search archive recovery incomplete");
  }
  return { sourceRevision: ARCHIVE_SOURCE_REVISION, restored, verified: initial.map((item) => item.path) };
}

export async function restoreNativeSearchArchives(options = {}) {
  return restoreArchiveSet(resolveArchiveRequests(options));
}

function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === "--all" || argument === "--remote") options[argument.slice(2)] = true;
    else if (argument === "--platform" || argument === "--arch") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
      options[argument.slice(2)] = value;
    } else throw new Error(`Unknown archive recovery option: ${argument}`);
  }
  return options;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await restoreNativeSearchArchives(parseOptions(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
