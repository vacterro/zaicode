import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  restoreRouteHealthSnapshot,
  serializeRouteHealthSnapshot,
  type PersistedRouteHealthSnapshot,
} from "@zcode/shared";

export class ZaicodeRouteHealthStorage {
  constructor(private readonly storageDir: string) {}

  private resolveNamespaceFile(routerNamespace: string): string {
    const safeNamespace = routerNamespace.trim().replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
    const dir = join(this.storageDir, "route-health", safeNamespace);
    const target = join(dir, "snapshot.json");
    const resolvedTarget = resolve(target);
    const resolvedRoot = resolve(this.storageDir);
    if (!resolvedTarget.startsWith(resolvedRoot)) {
      throw new Error(`Invalid storage path traversal for namespace ${routerNamespace}`);
    }
    return resolvedTarget;
  }

  public saveSnapshot(routerNamespace = "default"): {
    success: boolean;
    filePath?: string;
    error?: string;
  } {
    try {
      const filePath = this.resolveNamespaceFile(routerNamespace);
      const snapshot = serializeRouteHealthSnapshot(routerNamespace);
      const tmpPath = `${filePath}.${Date.now()}.tmp`;

      mkdirSync(dirname(filePath), { recursive: true });
      const serialized = JSON.stringify(snapshot, null, 2);
      writeFileSync(tmpPath, serialized, "utf8");

      // Explicit readback verification
      const readback = readFileSync(tmpPath, "utf8");
      const parsed = JSON.parse(readback) as PersistedRouteHealthSnapshot;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
        throw new Error("Route health snapshot validation failed on readback");
      }

      // Atomic commit
      renameSync(tmpPath, filePath);
      if (!existsSync(filePath)) {
        throw new Error("Committed snapshot file missing after rename");
      }

      return { success: true, filePath };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorMsg };
    }
  }

  public loadSnapshot(
    routerNamespace = "default",
    now = Date.now(),
  ): {
    success: boolean;
    snapshot?: PersistedRouteHealthSnapshot;
    error?: string;
  } {
    try {
      const filePath = this.resolveNamespaceFile(routerNamespace);
      if (!existsSync(filePath)) {
        return { success: true };
      }

      const content = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(content) as PersistedRouteHealthSnapshot;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
        throw new Error("Route health snapshot version or records invalid");
      }

      // Restore into circuit breaker state with cooldown recovery
      restoreRouteHealthSnapshot(parsed, now);
      return { success: true, snapshot: parsed };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorMsg };
    }
  }
}
