import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  rebaseZaicodeRouterModels,
  type ZaicodeRouterCall,
  type ZaicodeRouterResponse,
  type ZaicodeRouterSnapshotInfo,
} from "@zcode/shared";

type Caller = (call: ZaicodeRouterCall) => Promise<ZaicodeRouterResponse>;
type Target = { url: string; dataDir: string };
type Pool = { id: string; name: string; models: string[]; kind?: string };
interface Snapshot {
  version: 1;
  createdAt: string;
  label: string;
  kind: "automatic" | "preset";
  combos: Pool[];
  id: string;
}

const queues = new Map<string, Promise<unknown>>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const root = (target: Target) =>
  join(target.dataDir, "zaicode-recovery", digest(target.url).slice(0, 16));
const failure = (message: string, status = 503): ZaicodeRouterResponse => ({
  ok: false,
  status,
  data: null,
  message,
});

function pools(data: unknown): Pool[] {
  const rows = (data as { combos?: unknown } | null)?.combos;
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) =>
        !row ||
        typeof row.id !== "string" ||
        typeof row.name !== "string" ||
        !Array.isArray(row.models) ||
        !row.models.every((id: unknown) => typeof id === "string"),
    )
  ) {
    throw new Error("9router returned an invalid pool list; the last good list is preserved.");
  }
  // 历史只保留恢复模型列表所需字段；凭据及未知路由字段不能进备份或 renderer。
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    models: [...row.models],
    ...(typeof row.kind === "string" ? { kind: row.kind } : {}),
  }));
}

function decode(text: string): Snapshot {
  if (text.length > 10_000_000) throw new Error("Recovery snapshot is too large.");
  const value = JSON.parse(text) as Snapshot;
  const { id, ...content } = value;
  if (
    content.version !== 1 ||
    (content.kind !== "automatic" && content.kind !== "preset") ||
    typeof content.label !== "string" ||
    typeof content.createdAt !== "string" ||
    !Number.isFinite(Date.parse(content.createdAt)) ||
    digest(content) !== id
  )
    throw new Error("Recovery checksum is invalid.");
  pools(content);
  return value;
}

async function history(target: Target): Promise<{ snapshots: Snapshot[]; unreadable: number }> {
  let files: string[];
  try {
    files = await readdir(root(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { snapshots: [], unreadable: 0 };
    throw error;
  }
  const snapshots: Snapshot[] = [];
  let unreadable = 0;
  for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
    try {
      const snapshot = decode(await readFile(join(root(target), file), "utf8"));
      if (file !== `${snapshot.id}.json`) throw new Error("Recovery identity mismatch.");
      snapshots.push(snapshot);
    } catch {
      unreadable++;
    }
  }
  snapshots.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { snapshots, unreadable };
}

function info(snapshot: Snapshot): ZaicodeRouterSnapshotInfo {
  return {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    label: snapshot.label,
    kind: snapshot.kind,
    pools: snapshot.combos.length,
    models: snapshot.combos.reduce((sum, pool) => sum + pool.models.length, 0),
  };
}

async function save(target: Target, combos: Pool[], label?: string): Promise<Snapshot | null> {
  if (!combos.length) return null;
  const previous = await history(target);
  if (!label) {
    const latest = previous.snapshots.find((snapshot) => snapshot.kind === "automatic");
    if (latest && digest(latest.combos) === digest(combos)) return latest;
  }
  const content = {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    label: label ?? "Automatic backup",
    kind: label ? ("preset" as const) : ("automatic" as const),
    combos,
  };
  const snapshot = { ...content, id: digest(content) };
  const serialized = JSON.stringify(snapshot);
  if (serialized.length > 10_000_000)
    throw new Error("Pool history exceeds the recovery size limit; no edit was made.");
  await mkdir(root(target), { recursive: true, mode: 0o700 });
  const temporary = join(root(target), `${snapshot.id}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(root(target), `${snapshot.id}.json`));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  if (!label) {
    const old = previous.snapshots
      .filter((item) => item.kind === "automatic" && item.id !== snapshot.id)
      .slice(49);
    await Promise.all(
      old.map((item) => unlink(join(root(target), `${item.id}.json`)).catch(() => undefined)),
    );
  }
  return snapshot;
}

async function readPools(call: Caller): Promise<Pool[]> {
  const result = await call({ method: "GET", path: "/api/combos" });
  if (!result.ok) throw new Error(result.message || `9router answered ${result.status}`);
  return pools(result.data);
}

async function execute(
  request: ZaicodeRouterCall,
  target: Target,
  call: Caller,
): Promise<ZaicodeRouterResponse> {
  if (request.path === "/zaicode/recovery" && request.method === "GET") {
    const found = await history(target);
    return {
      ok: true,
      status: 200,
      data: { snapshots: found.snapshots.map(info), unreadable: found.unreadable },
      message: "",
    };
  }
  if (request.path === "/zaicode/recovery/snapshot" && request.method === "POST") {
    const label = (request.body as { label?: unknown } | null)?.label;
    if (typeof label !== "string" || !label.trim() || label.trim().length > 100)
      return failure("Name the preset (1–100 characters).", 400);
    const snapshot = await save(target, await readPools(call), label.trim());
    return snapshot
      ? { ok: true, status: 201, data: info(snapshot), message: "Preset saved." }
      : failure("There are no pools to save.", 400);
  }
  if (request.path === "/zaicode/recovery/restore" && request.method === "POST") {
    const id = (request.body as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
      return failure("Choose a valid recovery snapshot.", 400);
    let snapshot: Snapshot;
    try {
      snapshot = decode(await readFile(join(root(target), `${id}.json`), "utf8"));
    } catch {
      return failure("The selected backup is missing or damaged; choose another backup.", 409);
    }
    if (snapshot.id !== id) return failure("Recovery identity mismatch.", 409);
    await save(target, await readPools(call));
    let restored = 0;
    for (const saved of snapshot.combos) {
      const current = await readPools(call);
      const existing = current.find((pool) => pool.id === saved.id || pool.name === saved.name);
      const result = await call(
        existing
          ? { method: "PUT", path: `/api/combos/${existing.id}`, body: { models: saved.models } }
          : {
              method: "POST",
              path: "/api/combos",
              body: {
                name: saved.name,
                models: saved.models,
                ...(saved.kind ? { kind: saved.kind } : {}),
              },
            },
      );
      if (!result.ok)
        return failure(
          `Restored ${restored} pool(s); ${saved.name}: ${result.message || result.status}`,
          result.status || 503,
        );
      restored++;
    }
    return { ok: true, status: 200, data: { restored }, message: `Restored ${restored} pool(s).` };
  }
  if (request.path.startsWith("/zaicode/")) return failure("Unknown recovery action.", 400);
  const changesPool = request.method !== "GET" && /^\/api\/combos(?:\/[^/]+)?$/.test(request.path);
  let admitted = request;
  if (changesPool) {
    const current = await readPools(call);
    await save(target, current);
    if (request.baselineModels !== undefined) {
      const desired = (request.body as { models?: unknown } | null)?.models;
      if (
        !Array.isArray(desired) ||
        !desired.every((id) => typeof id === "string") ||
        Object.keys(request.body as object).some((key) => key !== "models")
      )
        return failure("A model-list intent must contain only model IDs.", 400);
      const pool = current.find((item) => request.path === `/api/combos/${item.id}`);
      if (!pool) return failure("This pool was deleted in 9router. Refresh before editing.", 409);
      const models = rebaseZaicodeRouterModels(request.baselineModels, desired, pool.models);
      if (!models)
        return failure("The model order changed in 9router. Refresh and repeat the move.", 409);
      admitted = { method: request.method, path: request.path, body: { models } };
    }
  }
  const result = await call(admitted);
  if (request.method === "GET" && request.path === "/api/combos" && result.ok) {
    let rows: Pool[];
    try {
      rows = pools(result.data);
    } catch (error) {
      return failure((error as Error).message, 502);
    }
    try {
      await save(target, rows);
    } catch {
      return {
        ...result,
        message: "Pool history could not be saved; edits require a working backup directory.",
      };
    }
  }
  return result;
}

/** One admission queue for each captured endpoint/data directory, shared by UI and maintenance. */
export function callZaicodeRouterWithRecovery(
  request: ZaicodeRouterCall,
  target: Target,
  call: Caller,
): Promise<ZaicodeRouterResponse> {
  const relevant =
    request.path.startsWith("/zaicode/") || /^\/api\/combos(?:\/[^/]+)?$/.test(request.path);
  if (!relevant) return call(request);
  const key = `${target.url}\0${target.dataDir}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const operation = previous
    .then(() => execute(request, target, call))
    .catch((error: unknown) =>
      failure(
        `Pool recovery/admission refused: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  queues.set(key, operation);
  void operation.then(() => {
    if (queues.get(key) === operation) queues.delete(key);
  });
  return operation;
}
