/**
 * T-374 / Quick3 Batch: durable typed execution relationships on zaicode_jobs.
 *
 * Persists campaignId, batchId, waveId, and attempt directly on the job row
 * instead of fragile parsing from the mutable job title. A title edit can
 * never remove the batch pause fence.
 */
export const ZAICODE_AUDIT_METADATA_MIGRATION_SQL = `
  ALTER TABLE zaicode_jobs ADD COLUMN audit_metadata_json TEXT;
`;
