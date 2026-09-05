import type { OpsCostPayload } from '../../shared/ops-contract';
import {
  organizationForEmail,
  organizationMappingsFromFilterOptions,
  sanitizeOrganizationFilterOptions,
} from '../../shared/organization-mapping';
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
  if (
    rawMonitoring.schemaRevision !== USER_MONITORING_SCHEMA_REVISION ||
    !Array.isArray(rawMonitoring.users) ||
    !Array.isArray(rawMonitoring.organizations)
  ) {
    throw new Error('user_monitoring_payload_stale');
  }
  const monitoring = rawMonitoring as unknown as UserMonitoringPayload;
  const organizations = sanitizeOrganizationFilterOptions(monitoring.organizations);
  if (monitoring.organizations.length > 0 && organizations.length === 0) {
    throw new Error('user_monitoring_payload_stale');
  }
  const organizationMappings = organizationMappingsFromFilterOptions(organizations);
  const users = monitoring.users
    .filter(
      (row) =>
        (row?.lastActive === null ||
          (typeof row?.lastActive === 'string' && Number.isFinite(Date.parse(row.lastActive)))) &&
        typeof row.email === 'string' &&
        Number.isFinite(row.questions) &&
        Number.isFinite(row.coveredDays) &&
        isRecord(row.tokenUsage)
    )
    .map((row) => ({ ...row, organization: organizationForEmail(row.email, organizationMappings) }));
  if (typeof monitoring.identityRevision !== 'string') throw new Error('user_monitoring_payload_stale');
  return {
    ...(direct ? ({ currency: 'USD' } as OpsCostPayload) : (value as unknown as OpsCostPayload)),
    userMonitoring: {
      ...monitoring,
      users,
      organizations,
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
