/* ZAICODE agent 定义仓库：zaicode_agents 的 sqlite schema 与读写。
   与 tasks-index.sqlite 同库同属主，仓储模式与 OffPeakTaskRepo 保持一致。
   只做存储与持久化校验：损坏行不静默消失，而是与列表一起返回诊断。 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  modelSelectionSchema,
  zaicodeAgentDefinitionSchema,
  zaicodeAgentToolPolicySchema,
  type ZaicodeAgentDefinition,
  type ZaicodeAgentDiagnostic,
  type ZaicodeAgentListResult,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
import { readZaicodePersistedJson } from "./zaicodePersistedJson.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

interface ZaicodeAgentRow {
  agent_id: string;
  name: string;
  role: string;
  instructions: string;
  enabled: number;
  model_selection: string | null;
  provider_ref: string | null;
  model_ref: string | null;
  reasoning_effort: string | null;
  tool_policy_json: string;
  backend: string;
  template_id: string | null;
  created_at: number;
  updated_at: number;
}

function rowToDefinition(
  row: ZaicodeAgentRow,
): { definition: ZaicodeAgentDefinition } | { diagnostic: ZaicodeAgentDiagnostic } {
  const modelSelection = readZaicodePersistedJson(
    "model_selection",
    row.model_selection,
    modelSelectionSchema,
  );
  if ("malformed" in modelSelection) {
    return {
      diagnostic: {
        agentId: row.agent_id,
        code: "invalid-definition",
        message: modelSelection.malformed,
      },
    };
  }
  const toolPolicy = readZaicodePersistedJson(
    "tool_policy_json",
    row.tool_policy_json,
    zaicodeAgentToolPolicySchema,
  );
  if ("malformed" in toolPolicy) {
    return {
      diagnostic: {
        agentId: row.agent_id,
        code: "invalid-definition",
        message: toolPolicy.malformed,
      },
    };
  }
  const candidate = {
    id: row.agent_id,
    name: row.name,
    role: row.role,
    instructions: row.instructions,
    enabled: row.enabled === 1,
    modelSelection: modelSelection.value,
    providerRef: row.provider_ref ?? undefined,
    modelRef: row.model_ref ?? undefined,
    reasoningEffort: row.reasoning_effort ?? undefined,
    toolPolicy: toolPolicy.value ?? {},
    backend: row.backend,
    templateId: row.template_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  const parsed = zaicodeAgentDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      diagnostic: {
        agentId: row.agent_id,
        code: "invalid-definition",
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
      },
    };
  }
  return { definition: parsed.data };
}

function serializeModelSelection(
  selection: ZaicodeAgentDefinition["modelSelection"],
): string | null {
  return selection ? JSON.stringify(modelSelectionSchema.parse(selection)) : null;
}

export class ZaicodeAgentRepo {
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private initializationGeneration = 0;
  private readonly resolvedDbPath: string | null;

  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  private resolveDbPath(): string {
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

  async ensureReady(): Promise<void> {
    const path = this.resolveDbPath();
    if (this.dbPath && this.dbPath !== path) this.close();
    if (!this.initializePromise) {
      const generation = this.initializationGeneration;
      this.initializePromise = this.initialize(path, generation).catch((error) => {
        if (generation === this.initializationGeneration) this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    this.initializationGeneration += 1;
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string, generation: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    // T-252 / W2-005 — close 使旧 await 失效；旧初始化不得打开句柄或关闭新初始化。
    if (generation !== this.initializationGeneration)
      throw new Error("ZaicodeAgentRepo initialization_cancelled: closed during startup");
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    if (isTasksStoragePrepared(path, this.db)) return;
    if (!isTasksStorageMigrated(path, this.db)) runTasksDatabaseMigrations(this.db);
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) throw new Error("ZaicodeAgentRepo 未初始化：请先 await ensureReady()");
    return this.db;
  }

  async list(): Promise<ZaicodeAgentListResult> {
    const rows = this.getDatabase()
      .prepare("SELECT * FROM zaicode_agents ORDER BY created_at ASC")
      .all() as unknown as ZaicodeAgentRow[];
    const agents: ZaicodeAgentDefinition[] = [];
    const diagnostics: ZaicodeAgentDiagnostic[] = [];
    for (const row of rows) {
      const result = rowToDefinition(row);
      if ("definition" in result) agents.push(result.definition);
      else diagnostics.push(result.diagnostic);
    }
    return { agents, diagnostics };
  }

  async get(agentId: string): Promise<ZaicodeAgentDefinition | null> {
    const row = this.getDatabase()
      .prepare("SELECT * FROM zaicode_agents WHERE agent_id = ?")
      .get(agentId) as ZaicodeAgentRow | undefined;
    if (!row) return null;
    const result = rowToDefinition(row);
    return "definition" in result ? result.definition : null;
  }

  async create(definition: ZaicodeAgentDefinition): Promise<void> {
    const validated = zaicodeAgentDefinitionSchema.parse(definition);
    this.getDatabase()
      .prepare(
        `INSERT INTO zaicode_agents (
          agent_id, name, role, instructions, enabled, model_selection, provider_ref,
          model_ref, reasoning_effort, tool_policy_json, backend, template_id, created_at, updated_at
        ) VALUES (
          @agentId, @name, @role, @instructions, @enabled, @modelSelection, @providerRef,
          @modelRef, @reasoningEffort, @toolPolicyJson, @backend, @templateId, @createdAt, @updatedAt
        )`,
      )
      .run({
        agentId: validated.id,
        name: validated.name,
        role: validated.role,
        instructions: validated.instructions,
        enabled: validated.enabled ? 1 : 0,
        modelSelection: serializeModelSelection(validated.modelSelection),
        providerRef: validated.providerRef ?? null,
        modelRef: validated.modelRef ?? null,
        reasoningEffort: validated.reasoningEffort ?? null,
        toolPolicyJson: JSON.stringify(validated.toolPolicy),
        backend: validated.backend,
        templateId: validated.templateId ?? null,
        createdAt: validated.createdAt,
        updatedAt: validated.updatedAt,
      });
  }

  async update(definition: ZaicodeAgentDefinition): Promise<void> {
    const validated = zaicodeAgentDefinitionSchema.parse(definition);
    this.getDatabase()
      .prepare(
        `UPDATE zaicode_agents SET
          name = @name,
          role = @role,
          instructions = @instructions,
          enabled = @enabled,
          model_selection = @modelSelection,
          provider_ref = @providerRef,
          model_ref = @modelRef,
          reasoning_effort = @reasoningEffort,
          tool_policy_json = @toolPolicyJson,
          backend = @backend,
          template_id = @templateId,
          updated_at = @updatedAt
        WHERE agent_id = @agentId`,
      )
      .run({
        agentId: validated.id,
        name: validated.name,
        role: validated.role,
        instructions: validated.instructions,
        enabled: validated.enabled ? 1 : 0,
        modelSelection: serializeModelSelection(validated.modelSelection),
        providerRef: validated.providerRef ?? null,
        modelRef: validated.modelRef ?? null,
        reasoningEffort: validated.reasoningEffort ?? null,
        toolPolicyJson: JSON.stringify(validated.toolPolicy),
        backend: validated.backend,
        templateId: validated.templateId ?? null,
        updatedAt: validated.updatedAt,
      });
  }

  async remove(agentId: string): Promise<boolean> {
    const result = this.getDatabase()
      .prepare("DELETE FROM zaicode_agents WHERE agent_id = ?")
      .run(agentId);
    return Number(result.changes) > 0;
  }
}
