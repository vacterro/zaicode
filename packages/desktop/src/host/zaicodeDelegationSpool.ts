/**
 * ZAICODE runtime delegation channel (T-10), host side.
 *
 * A running coordinator job gets a folder of its own. The agent asks for a
 * helper by writing `<name>.json` there (its ordinary file tool is the tool
 * call); the host claims the file by renaming it, hands the request to the
 * job service (which alone decides: depth 1, budget, roles, current run),
 * and answers in `<name>.result.json`. When a helper finishes, its outcome
 * lands as `<childJobId>.done.json` in the same folder. The folder is a
 * request carrier only: the queue stays the one owner of every job.
 */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ZaicodeJob } from "@zcode/shared";

export interface ZaicodeDelegationGateway {
  delegateFromRun(input: { parentJobId: string; runId: string; request: unknown }): Promise<
    { ok: true; child: ZaicodeJob } | { ok: false; reason: string; detail: string }
  >;
}

const SCAN_INTERVAL_MS = 1500;
const MAX_REQUEST_BYTES = 64 * 1024;

/** A job id as a folder / file name (ids look like `zaicode-job:<uuid>`). */
export function zaicodeSpoolName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
}

/** `<name>.json` files that are requests (not our own answers or claims). */
export function isZaicodeDelegationRequestFile(name: string): boolean {
  return name.endsWith(".json") && !name.endsWith(".result.json") && !name.endsWith(".done.json");
}

export class ZaicodeDelegationSpool {
  private readonly watches = new Map<string, { timer: ReturnType<typeof setInterval>; scanning: boolean }>();

  constructor(
    private readonly root: string,
    private readonly logWarn: (message: string, error?: unknown) => void,
  ) {}

  dirFor(parentJobId: string): string {
    return join(this.root, zaicodeSpoolName(parentJobId));
  }

  /** Opens the folder for one run and starts answering requests in it. Returns the folder. */
  async open(parentJobId: string, runId: string, gateway: ZaicodeDelegationGateway): Promise<string> {
    const dir = this.dirFor(parentJobId);
    await mkdir(dir, { recursive: true });
    this.close(parentJobId);
    const watch = {
      scanning: false,
      timer: setInterval(() => {
        if (watch.scanning) return;
        watch.scanning = true;
        void this.scan(dir, parentJobId, runId, gateway).finally(() => {
          watch.scanning = false;
        });
      }, SCAN_INTERVAL_MS),
    };
    watch.timer.unref?.();
    this.watches.set(parentJobId, watch);
    return dir;
  }

  /** Stops answering for this parent (its run ended). Children still report into the folder. */
  close(parentJobId: string): void {
    const watch = this.watches.get(parentJobId);
    if (!watch) return;
    clearInterval(watch.timer);
    this.watches.delete(parentJobId);
  }

  dispose(): void {
    for (const watch of this.watches.values()) clearInterval(watch.timer);
    this.watches.clear();
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
      const base = name.slice(0, -".json".length);
      const claimed = join(dir, `${base}.taken`);
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
      } catch (error) {
        answer = { ok: false, reason: "invalid_request", detail: error instanceof Error ? error.message : String(error) };
      }
      try {
        await writeFile(join(dir, `${base}.result.json`), `${JSON.stringify({ ...answer, at: new Date().toISOString() }, null, 2)}\n`, "utf8");
      } catch (error) {
        this.logWarn(`ZAICODE delegation answer not written: ${dir}/${base}`, error);
      }
    }
    return handled;
  }

  /** A helper reached a final state: tell the parent's folder (it may already be closed; the folder stays). */
  async reportChild(child: ZaicodeJob): Promise<void> {
    if (!child.parentJobId) return;
    const dir = this.dirFor(child.parentJobId);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${zaicodeSpoolName(child.id)}.done.json`),
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
}
