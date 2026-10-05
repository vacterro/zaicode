import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export interface ZaicodeBuildIdentity {
  appVersion?: string;
  buildCommitId?: string;
  sourceRevision?: string;
  buildTime?: string;
  updateChannel?: string;
  runtimePackageIdentity?: string;
  workingTreeDirty?: boolean;
  sourceFingerprint?: string;
}
export interface ZaicodeRuntimePaths {
  executablePath: string;
  resourcesPath: string;
  packaged: boolean;
}
interface LocalSource {
  revision: string;
  dirty: boolean;
  newer?: boolean;
  fingerprint?: string;
}
export interface ZaicodeRuntimeIdentity extends ZaicodeRuntimePaths {
  schemaVersion: 1;
  version: string;
  sourceRevision: string;
  buildTimestamp: string;
  updateChannel: string;
  runtimePackageIdentity: string;
  sourceFingerprint: string;
  workingTreeDirty: boolean | null;
  source: {
    status:
      | "MATCH"
      | "SOURCE_NEWER"
      | "SOURCE_DIFFERENT"
      | "SOURCE_DIRTY"
      | "SOURCE_UNAVAILABLE"
      | "METADATA_UNAVAILABLE"
      | "METADATA_INCOMPLETE"
      | "UNVERIFIED_DIRTY_BUILD";
    revision: string | null;
    dirty: boolean | null;
  };
}
const value = (input: unknown) =>
  typeof input === "string" && input.trim() ? input.trim() : "unknown";

/** 包内 revision 不得被 checkout 的 HEAD 替代；脏构建只有完整源码指纹一致才算匹配。 */
export function projectZaicodeRuntimeIdentity(
  metadata: ZaicodeBuildIdentity | null,
  runtime: ZaicodeRuntimePaths,
  source: LocalSource | null,
): ZaicodeRuntimeIdentity {
  const revision = value(metadata?.sourceRevision ?? metadata?.buildCommitId);
  const fingerprint = value(metadata?.sourceFingerprint);
  const dirty = typeof metadata?.workingTreeDirty === "boolean" ? metadata.workingTreeDirty : null;
  let status: ZaicodeRuntimeIdentity["source"]["status"];
  if (!metadata) status = "METADATA_UNAVAILABLE";
  else if (
    !/^[a-f0-9]{40}$/.test(revision) ||
    !/^zaicode-[a-f0-9]{64}$/.test(value(metadata.runtimePackageIdentity)) ||
    !/^[a-f0-9]{64}$/.test(fingerprint) ||
    dirty === null ||
    !Number.isFinite(Date.parse(value(metadata.buildTime)))
  )
    status = "METADATA_INCOMPLETE";
  else if (!source) status = "SOURCE_UNAVAILABLE";
  else if (source.revision !== revision)
    status = source.newer ? "SOURCE_NEWER" : "SOURCE_DIFFERENT";
  else if (source.fingerprint && source.fingerprint === fingerprint) status = "MATCH";
  else if (source.dirty) status = "SOURCE_DIRTY";
  else if (source.fingerprint && source.fingerprint !== fingerprint) status = "SOURCE_DIFFERENT";
  else if (dirty) status = "UNVERIFIED_DIRTY_BUILD";
  else status = "MATCH";
  return {
    ...runtime,
    schemaVersion: 1,
    version: value(metadata?.appVersion),
    sourceRevision: revision,
    buildTimestamp: value(metadata?.buildTime),
    updateChannel: value(metadata?.updateChannel),
    runtimePackageIdentity: value(metadata?.runtimePackageIdentity),
    sourceFingerprint: fingerprint,
    workingTreeDirty: dirty,
    source: { status, revision: source?.revision ?? null, dirty: source?.dirty ?? null },
  };
}

const execute = promisify(execFile);
const SOURCE_ROOTS = [
  "packages",
  "apps",
  "scripts",
  "spec",
  "specs",
  "config",
  "patches",
  "package.json",
  "pnpm-lock.yaml",
  "architecture-policy.yaml",
];

/** Same sorted byte-hash format as the metadata producer; bounded async IO, never stages files. */
async function sourceFingerprint(cwd: string, revision: string, listed: string): Promise<string> {
  const files = [...new Set(listed.split("\0").filter(Boolean))].sort();
  const hash = createHash("sha256").update(revision);
  for (let offset = 0; offset < files.length; offset += 32) {
    const names = files.slice(offset, offset + 32);
    const digests = await Promise.all(
      names.map(async (name) => {
        try {
          return createHash("sha256")
            .update(await readFile(join(cwd, name)))
            .digest("hex");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "ABSENT";
          throw error;
        }
      }),
    );
    names.forEach((name, index) => hash.update(`\0${name}\0${digests[index]}`));
  }
  return hash.digest("hex");
}

/** No network, source mutation, inference or package swap; unavailable Git is explicit. */
export async function readZaicodeRuntimeIdentity(
  input: ZaicodeRuntimePaths & { metadataPath: string; installRoot: string | null },
): Promise<ZaicodeRuntimeIdentity> {
  let metadata: ZaicodeBuildIdentity | null = null;
  try {
    const parsed: unknown = JSON.parse(await readFile(input.metadataPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      metadata = parsed as ZaicodeBuildIdentity;
  } catch {
    /* 未知元数据必须显示未知，不能从工作树补造。 */
  }
  let source: LocalSource | null = null;
  if (input.installRoot) {
    const cwd = join(input.installRoot, "zcode");
    const git = async (args: string[]) =>
      (
        await execute("git", args, {
          cwd,
          windowsHide: true,
          timeout: 3000,
          maxBuffer: 32 * 1_048_576,
        })
      ).stdout;
    try {
      const revision = (await git(["rev-parse", "HEAD"])).trim();
      const dirty = Boolean(
        (
          await git(["status", "--porcelain", "--untracked-files=normal", "--", ...SOURCE_ROOTS])
        ).trim(),
      );
      let newer = false;
      const packagedRevision = value(metadata?.sourceRevision);
      if (/^[a-f0-9]{40}$/.test(packagedRevision) && revision !== packagedRevision) {
        try {
          await git(["merge-base", "--is-ancestor", packagedRevision, revision]);
          newer = true;
        } catch {
          /* Different or unknown source remains different, never guessed newer. */
        }
      }
      const fingerprint =
        revision === packagedRevision && (dirty || metadata?.workingTreeDirty === true)
          ? await sourceFingerprint(
              cwd,
              revision,
              await git([
                "ls-files",
                "-z",
                "--cached",
                "--others",
                "--exclude-standard",
                "--",
                ...SOURCE_ROOTS,
              ]),
            )
          : undefined;
      source = { revision, dirty, newer, fingerprint };
    } catch {
      /* Source checkout is optional in an installed package; failed probes never claim parity. */
    }
  }
  return projectZaicodeRuntimeIdentity(
    metadata,
    {
      executablePath: input.executablePath,
      resourcesPath: input.resourcesPath,
      packaged: input.packaged,
    },
    source,
  );
}
