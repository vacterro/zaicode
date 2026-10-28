/**
 * ZAICODE runtime delegation channel (T-10), host side.
 *
 * A running coordinator job gets a folder of its own — one folder per RUN, not
 * per job (T-247), so a leftover request from an earlier attempt of the same job
 * can never be claimed by a later one. The agent asks for a helper by writing
 * `<name>.json` there (its ordinary file tool is the tool call); the host claims
 * the file by renaming it, hands the request to the job service (which alone
 * decides: depth 1, budget, roles, current run), and answers in
 * `<name>.result.json`. When a helper finishes, its outcome lands as
 * `<childJobId>.done.json` in the folder of the run that asked. The folder is a
 * request carrier only: the queue stays the one owner of every job.
 *
 * A claim is a rename, so it survives what the answer write does not: a host
 * killed between the two leaves a `<name>.taken` nobody would ever look at
 * again. That is recovered by failing it explicitly — `unprocessed_after_restart` —
 * in the run's own folder when the run starts again (`open`), and for attempts
 * that never come back by `sweepOrphans()`, which the host runs once at startup.
 * Re-delegating instead would need an idempotency key the carrier does not have,
 * and could create a second child for a request whose child already existed.
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ZaicodeJob } from "@zcode/shared";

export interface ZaicodeDelegationGateway {
  delegateFromRun(input: { parentJobId: string; runId: string; request: unknown }): Promise<
    { ok: true; child: ZaicodeJob } | { ok: false; reason: string; detail: string }
  >;
}

const SCAN_INTERVAL_MS = 1500;
const MAX_REQUEST_BYTES = 64 * 1024;
/** A switched-off host leaves claims behind; this long is long enough that a live scan's claim→answer window is never swept. */
const ORPHAN_GRACE_MS = 30_000;
const JSON_SUFFIX = ".json";
const TAKEN_SUFFIX = ".taken";
const RESULT_SUFFIX = ".result.json";
const DONE_SUFFIX = ".done.json";
const UNPROCESSED_REASON = "unprocessed_after_restart";

/** A job id as a folder / file name (ids look like `zaicode-job:<uuid>`). */
export function zaicodeSpoolName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
}

/** `<name>.json` files that are requests (not our own answers or claims). */
export function isZaicodeDelegationRequestFile(name: string): boolean {
  return name.endsWith(JSON_SUFFIX) && !name.endsWith(RESULT_SUFFIX) && !name.endsWith(DONE_SUFFIX);
}

/** `<name>.taken` files: claimed, answer not written yet (or never). */
function isZaicodeClaimFile(name: string): boolean {
  return name.endsWith(TAKEN_SUFFIX);
}

interface Watch {
  parentJobId: string;
  timer: ReturnType<typeof setInterval>;
  scanning: boolean;
}

export class ZaicodeDelegationSpool {
  private readonly watches = new Map<string, Watch>();
  private readonly childDirs = new Map<string, string>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private fenced = false;

  constructor(
    private readonly root: string,
    private readonly logWarn: (message: string, error?: unknown) => void,
  ) {}

  /** The folder of one RUN of a job (`<parent>__<run>`): attempts never share one. */
  dirFor(parentJobId: string, runId: string): string {
    return join(this.root, `${zaicodeSpoolName(parentJobId)}__${zaicodeSpoolName(runId)}`);
  }

  /** Opens the folder for one run and starts answering requests in it. Returns the folder. */
  async open(parentJobId: string, runId: string, gateway: ZaicodeDelegationGateway): Promise<string> {
    const dir = this.dirFor(parentJobId, runId);
    await mkdir(dir, { recursive: true });
    this.close(parentJobId);
    // This folder belongs to this run alone, so a claim without an answer here is
    // a leftover from a crash, never something a live scan is still working on.
    await this.failClaimedWithoutAnswer(dir, { graceMs: 0 });
    const watch: Watch = {
      parentJobId,
      scanning: false,
      timer: setInterval(() => {
        if (watch.scanning) return;
        watch.scanning = true;
        this.track(this.scan(dir, parentJobId, runId, gateway).finally(() => {
          watch.scanning = false;
        }));
      }, SCAN_INTERVAL_MS),
    };
    watch.timer.unref?.();
    this.watches.set(dir, watch);
    return dir;
  }

  /** Stops answering for this parent — every run of it (its run ended). Children still report into the folder. */
  close(parentJobId: string): void {
    for (const [dir, watch] of this.watches) {
      if (watch.parentJobId !== parentJobId) continue;
      clearInterval(watch.timer);
      this.watches.delete(dir);
    }
  }

  /**
   * Fences the spool and waits for scans already in flight: after this resolves no
   * answer is being written, and no later scan starts. The instance is spent
   * afterwards — the host builds a new one when it needs a channel again.
   */
  async dispose(): Promise<void> {
    this.fenced = true;
    for (const watch of this.watches.values()) clearInterval(watch.timer);
    this.watches.clear();
    // A snapshot: tracked promises remove themselves from the set as they settle.
    await Promise.allSettled(Array.from(this.inFlight));
  }

  /** Fails claims left behind by runs that never came back. Called once at host startup. */
  async sweepOrphans(graceMs = ORPHAN_GRACE_MS): Promise<number> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => null);
    if (!entries) return 0;
    let failed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      failed += await this.failClaimedWithoutAnswer(join(this.root, entry.name), { graceMs });
    }
    return failed;
  }

  /** One pass over the folder; exposed for tests (the timer calls it). */
  async scan(dir: string, parentJobId: string, runId: string, gateway: ZaicodeDelegationGateway): Promise<number> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return 0;
    }
    let handled = 0;
    for (const name of names.filter(isZaicodeDelegationRequestFile).sort()) {
      if (this.fenced) break;
      const base = name.slice(0, -JSON_SUFFIX.length);
      const claimed = join(dir, `${base}${TAKEN_SUFFIX}`);
      try {
        // Claim first: a second scan (or a second host) cannot answer the same request twice.
        await rename(join(dir, name), claimed);
      } catch {
        continue;
      }
      handled += 1;
      let answer: Record<string, unknown>;
      try {
        const text = await readFile(claimed, "utf8");
        if (text.length > MAX_REQUEST_BYTES) throw new Error(`request larger than ${MAX_REQUEST_BYTES} bytes`);
        const request: unknown = JSON.parse(text);
        const result = await gateway.delegateFromRun({ parentJobId, runId, request });
        answer = result.ok
          ? { ok: true, childJobId: result.child.id, status: result.child.status, title: result.child.title }
          : { ok: false, reason: result.reason, detail: result.detail };
        if (result.ok) this.childDirs.set(result.child.id, dir);
      } catch (error) {
        answer = { ok: false, reason: "invalid_request", detail: error instanceof Error ? error.message : String(error) };
      }
      // The fence is the shutdown contract: nothing is written once dispose() began.
      if (this.fenced) break;
      await this.writeAnswer(dir, base, answer);
    }
    return handled;
  }

  /** A helper reached a final state: tell the folder of the run that asked for it. */
  async reportChild(child: ZaicodeJob): Promise<void> {
    const parentJobId = child.parentJobId;
    if (!parentJobId) return;
    const dir = await this.dirForChild(child, parentJobId);
    if (!dir) {
      this.logWarn(
        `ZAICODE delegation outcome has no folder to land in for ${child.id} (parent ${parentJobId}); the helper's own report is the result`,
      );
      return;
    }
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${zaicodeSpoolName(child.id)}${DONE_SUFFIX}`),
        `${JSON.stringify(
          {
            childJobId: child.id,
            title: child.title,
            status: child.status,
            ...(child.sessionId ? { sessionId: child.sessionId } : {}),
            ...(child.resultSummary ? { summary: child.resultSummary } : {}),
            ...(child.error ? { error: child.error } : {}),
            at: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    } catch (error) {
      this.logWarn(`ZAICODE delegation outcome not written for ${child.id}`, error);
    }
  }

  private track<T>(promise: Promise<T>): void {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise));
  }

  private async writeAnswer(dir: string, base: string, answer: Record<string, unknown>): Promise<void> {
    try {
      await writeFile(
        join(dir, `${base}${RESULT_SUFFIX}`),
        `${JSON.stringify({ ...answer, at: new Date().toISOString() }, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      this.logWarn(`ZAICODE delegation answer not written: ${dir}/${base}`, error);
    }
  }

  /**
   * Every `<name>.taken` without its answer is a request claimed but never processed.
   * Failing it explicitly is the whole recovery: the coordinator sees why, and the
   * carrier never invents a second child for a request that may already have one.
   */
  private async failClaimedWithoutAnswer(dir: string, options: { graceMs: number }): Promise<number> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return 0;
    }
    const present = new Set(names);
    let failed = 0;
    for (const name of names.filter(isZaicodeClaimFile).sort()) {
      const base = name.slice(0, -TAKEN_SUFFIX.length);
      if (present.has(`${base}${RESULT_SUFFIX}`)) continue;
      if (options.graceMs > 0) {
        const claimedAt = await stat(join(dir, name)).then((info) => info.mtimeMs).catch(() => null);
        // Unreadable or too young to judge: leave it for the next sweep.
        if (claimedAt === null || Date.now() - claimedAt < options.graceMs) continue;
      }
      await this.writeAnswer(dir, base, {
        ok: false,
        reason: UNPROCESSED_REASON,
        detail:
          "this request was claimed but never answered before the host stopped; it was not executed — write it again if you still need the helper",
      });
      failed += 1;
    }
    return failed;
  }

  /** The run folder a child's outcome belongs to: remembered, or derived from the answer naming it. */
  private async dirForChild(child: ZaicodeJob, parentJobId: string): Promise<string | null> {
    const known = this.childDirs.get(child.id);
    if (known) return known;
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => null);
    if (!entries) return null;
    const prefix = `${zaicodeSpoolName(parentJobId)}__`;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const dir = join(this.root, entry.name);
      if (await this.answerNamesChild(dir, child.id)) return dir;
    }
    return null;
  }

  private async answerNamesChild(dir: string, childJobId: string): Promise<boolean> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return false;
    }
    for (const name of names.filter((candidate) => candidate.endsWith(RESULT_SUFFIX))) {
      try {
        const answer = JSON.parse(await readFile(join(dir, name), "utf8")) as { childJobId?: unknown };
        if (answer.childJobId === childJobId) return true;
      } catch {
        // An unreadable answer is not a match; it is already visible as a file.
      }
    }
    return false;
  }
}
