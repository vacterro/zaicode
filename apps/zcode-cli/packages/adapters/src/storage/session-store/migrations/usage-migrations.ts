import { PROVIDER_MODEL_SELECTION_MIGRATION_SQL } from "./0020-provider-model-selection.js";
import { OFFICIAL_GLM_SELECTION_MIGRATION_SQL } from "./0021-official-glm-selection.js";
import { BACKFILLED_SESSION_REASONING_MIGRATION_SQL } from "./0022-backfilled-session-reasoning.js";
import { STATISTICS_COMPLETION_INDEXES_MIGRATION_SQL } from "./0023-statistics-completion-indexes.js";

// 新增统计索引不能让旧迁移注册表超过行数门限；只移动注册项，历史 SQL 与顺序不变。
export const SESSION_USAGE_MIGRATIONS = [
  { appVersion: "0.16.5", id: "0020_provider_model_selection", sql: PROVIDER_MODEL_SELECTION_MIGRATION_SQL },
  { appVersion: "0.16.5", id: "0021_official_glm_selection", sql: OFFICIAL_GLM_SELECTION_MIGRATION_SQL },
  { appVersion: "0.16.5", id: "0022_backfilled_session_reasoning", sql: BACKFILLED_SESSION_REASONING_MIGRATION_SQL },
  { appVersion: "0.16.9", id: "0023_statistics_completion_indexes", sql: STATISTICS_COMPLETION_INDEXES_MIGRATION_SQL },
] as const;
