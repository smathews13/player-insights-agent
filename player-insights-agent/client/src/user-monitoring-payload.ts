import type { OpsCostPayload } from '../../shared/ops-contract';
import { USER_MONITORING_SCHEMA_REVISION, type UserMonitoringPayload } from '../../shared/user-monitoring-contract';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function decodeUserMonitoringCostPayload(value: unknown): OpsCostPayload {
  if (!isRecord(value) || !isRecord(value.userMonitoring)) {
    throw new Error('user_monitoring_payload_missing');
  }
  const monitoring = value.userMonitoring as unknown as UserMonitoringPayload;
  if (monitoring.schemaRevision !== USER_MONITORING_SCHEMA_REVISION || !Array.isArray(monitoring.users)) {
    throw new Error('user_monitoring_payload_stale');
  }
  const users = monitoring.users.filter(
    (row) => typeof row?.lastActive === 'string' && Number.isFinite(Date.parse(row.lastActive))
  );
  return {
    ...(value as unknown as OpsCostPayload),
    userMonitoring: {
      ...monitoring,
      users,
    },
  };
}
