import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { APP_SCHEMA } from '../../shared/app-schema';
import { ADMIN_AUDIT_TABLE } from './admin-roles-schema';
import type { LakebaseReader } from './lakebase-store';
import type { ResourceTagSummary } from './resource-tagging';

export const RESOURCE_TAG_RESULT_ID = 'resource-tags-current-result';
export const RESOURCE_TAG_RESULT_MAX_BYTES = 64 * 1024;

const StoredResultSchema = z.object({
  kind: z.string().max(80),
  name: z.string().max(1_024),
  label: z.string().max(1_200),
  support: z.enum(['supported', 'unsupported', 'not-applicable']),
  billingAttribution: z.boolean(),
  status: z.enum(['tagged', 'already-correct', 'permission-required', 'failed', 'unsupported', 'not-applicable']),
  detail: z.string().max(2_000),
  nextAction: z.string().max(2_000),
  requiredScope: z.string().max(100).optional(),
  identity: z.enum(['obo', 'app-service-principal']).optional(),
  technicalDetail: z.string().max(2_000).optional(),
});

const StoredSummarySchema = z.object({
  headline: z.string().max(500),
  supportedTotal: z.number().int().nonnegative(),
  supportedCovered: z.number().int().nonnegative(),
  tagged: z.number().int().nonnegative(),
  alreadyCorrect: z.number().int().nonnegative(),
  supportedFailed: z.number().int().nonnegative(),
  permissionRequired: z.number().int().nonnegative(),
  unsupported: z.number().int().nonnegative(),
  notApplicable: z.number().int().nonnegative(),
  results: z.array(StoredResultSchema).max(32),
  updatedAt: z.string().max(100),
});

const READ = `SELECT value
  FROM ${APP_SCHEMA}.deployment_settings
  WHERE resource_id = $1`;

const WRITE = `INSERT INTO ${APP_SCHEMA}.deployment_settings
    (resource_id, value, intent, note, updated_by, updated_at)
  VALUES ($1, $2, 'active', 'Current Resource Tags result', $3, now())
  ON CONFLICT (resource_id) DO UPDATE
    SET value = EXCLUDED.value,
        intent = EXCLUDED.intent,
        note = EXCLUDED.note,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
  RETURNING resource_id`;

/**
 * Delete the display state and write the minimal audit row in one statement.
 * A failed statement commits neither half, so the prior result remains visible.
 */
export const CLEAR_RESOURCE_TAG_RESULT = `WITH deleted AS (
    DELETE FROM ${APP_SCHEMA}.deployment_settings
    WHERE resource_id = $1
    RETURNING resource_id
  ), audited AS (
    INSERT INTO ${ADMIN_AUDIT_TABLE} (id, actor, action, subject, detail)
    VALUES ($2, $3, 'resource-tags-cleared', 'resource-tags',
      'Cleared the saved Resource Tags result. Applied Databricks tags were not removed.')
    RETURNING id
  )
  SELECT EXISTS (SELECT 1 FROM deleted) AS removed,
         EXISTS (SELECT 1 FROM audited) AS audited`;

function parseSummary(value: unknown): ResourceTagSummary | null {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > RESOURCE_TAG_RESULT_MAX_BYTES) return null;
  try {
    return StoredSummarySchema.parse(JSON.parse(value)) as ResourceTagSummary;
  } catch {
    return null;
  }
}

export async function readResourceTagResult(store: LakebaseReader): Promise<ResourceTagSummary | null> {
  const result = await store.lakebase.query(READ, [RESOURCE_TAG_RESULT_ID]);
  return parseSummary(result.rows[0]?.value);
}

export async function writeResourceTagResult(
  store: LakebaseReader,
  summary: ResourceTagSummary,
  actor: string
): Promise<void> {
  let serialized: string;
  try {
    serialized = JSON.stringify(StoredSummarySchema.parse(summary));
  } catch {
    throw new Error('the Resource Tags result exceeded its bounded storage budget');
  }
  if (Buffer.byteLength(serialized, 'utf8') > RESOURCE_TAG_RESULT_MAX_BYTES) {
    throw new Error('the Resource Tags result exceeded its bounded storage budget');
  }
  const result = await store.lakebase.query(WRITE, [RESOURCE_TAG_RESULT_ID, serialized, actor]);
  if (result.rows.length === 0) throw new Error('the Resource Tags result was not saved');
}

export async function clearResourceTagResult(store: LakebaseReader, actor: string): Promise<boolean> {
  const result = await store.lakebase.query(CLEAR_RESOURCE_TAG_RESULT, [RESOURCE_TAG_RESULT_ID, randomUUID(), actor]);
  return result.rows[0]?.removed === true;
}
