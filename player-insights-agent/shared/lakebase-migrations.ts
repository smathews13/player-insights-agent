export const LAKEBASE_MIGRATION_STATUSES = [
  'up_to_date',
  'update_required',
  'blocked',
  'unavailable',
  'ahead',
] as const;

export type LakebaseMigrationStatus = (typeof LAKEBASE_MIGRATION_STATUSES)[number];

export interface PendingLakebaseMigration {
  version: number;
  name: string;
}

/**
 * The browser-safe migration readiness contract.
 *
 * It deliberately contains no SQL, Postgres role, connection value, exception,
 * or statement-level failure. Those remain in server logs; this payload gives
 * an administrator only the state and safe next action needed by Connections.
 */
export interface LakebaseMigrationReadiness {
  schema: string;
  currentVersion: number | null;
  targetVersion: number;
  pendingCount: number;
  pending: PendingLakebaseMigration[];
  status: LakebaseMigrationStatus;
  canApply: boolean;
  checkedAt: string;
  detail: string;
  action: string;
  appliedCount?: number;
}

export function isLakebaseMigrationReadiness(value: unknown): value is LakebaseMigrationReadiness {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.schema === 'string' &&
    (candidate.currentVersion === null ||
      (typeof candidate.currentVersion === 'number' && Number.isInteger(candidate.currentVersion))) &&
    typeof candidate.targetVersion === 'number' &&
    Number.isInteger(candidate.targetVersion) &&
    typeof candidate.pendingCount === 'number' &&
    Number.isInteger(candidate.pendingCount) &&
    Array.isArray(candidate.pending) &&
    candidate.pending.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>).version === 'number' &&
        Number.isInteger((entry as Record<string, unknown>).version) &&
        typeof (entry as Record<string, unknown>).name === 'string'
    ) &&
    LAKEBASE_MIGRATION_STATUSES.includes(candidate.status as LakebaseMigrationStatus) &&
    typeof candidate.canApply === 'boolean' &&
    typeof candidate.checkedAt === 'string' &&
    typeof candidate.detail === 'string' &&
    typeof candidate.action === 'string' &&
    (candidate.appliedCount === undefined ||
      (typeof candidate.appliedCount === 'number' && Number.isInteger(candidate.appliedCount)))
  );
}
