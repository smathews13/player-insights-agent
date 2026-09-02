import type { OpsCostPayload } from '../../shared/ops-contract';
import { USER_MONITORING_SCHEMA_REVISION, type UserMonitoringPayload } from '../../shared/user-monitoring-contract';
import type { SpendByUserPayload } from '../../shared/user-spend-contract';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function decodeUserMonitoringCostPayload(value: unknown): OpsCostPayload {
  if (!isRecord(value)) {
    throw new Error('user_monitoring_payload_missing');
  }
  const direct = value.schemaRevision === USER_MONITORING_SCHEMA_REVISION;
  const rawMonitoring = direct ? value : value.userMonitoring;
  if (!isRecord(rawMonitoring)) throw new Error('user_monitoring_payload_missing');
  if (rawMonitoring.schemaRevision !== USER_MONITORING_SCHEMA_REVISION || !Array.isArray(rawMonitoring.users)) {
    throw new Error('user_monitoring_payload_stale');
  }
  const monitoring = rawMonitoring as unknown as UserMonitoringPayload;
  const users = monitoring.users.filter(
    (row) =>
      typeof row?.lastActive === 'string' &&
      Number.isFinite(Date.parse(row.lastActive)) &&
      Number.isFinite(row.questions) &&
      Number.isFinite(row.coveredDays)
  );
  return {
    ...(direct ? ({ currency: 'USD' } as OpsCostPayload) : (value as unknown as OpsCostPayload)),
    userMonitoring: {
      ...monitoring,
      users,
    },
  };
}

export function decodeUserSpendPayload(value: unknown): OpsCostPayload {
  if (!isRecord(value) || !Array.isArray(value.users) || !isRecord(value.reconciliation)) {
    throw new Error('user_spend_payload_missing');
  }
  return {
    currency: 'USD',
    spendByUser: value as unknown as SpendByUserPayload,
  } as OpsCostPayload;
}
