/** Add persisted ZAICODE route intent without changing the frozen v4 schema. */
export const ZAICODE_ROUTING_BACKEND_MIGRATION_SQL = `
  ALTER TABLE zaicode_agents
  ADD COLUMN backend TEXT NOT NULL DEFAULT 'direct';
`;
