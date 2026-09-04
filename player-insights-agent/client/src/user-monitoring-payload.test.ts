import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { USER_MONITORING_SCHEMA_REVISION } from '../../shared/user-monitoring-contract';
import { organizationForEmail } from '../../shared/organization-mapping';
import { decodeUserMonitoringCostPayload } from './user-monitoring-payload';

const MONITORING_SOURCE = readFileSync(new URL('./MonitoringPage.tsx', import.meta.url), 'utf8');

function payload(revision = USER_MONITORING_SCHEMA_REVISION) {
  return {
    state: 'ready',
    userMonitoring: {
      schemaRevision: revision,
      identityRevision: '2026-09-01T12:00:00Z',
      organizations: [{ ...organizationForEmail('person@example.com'), count: 1 }],
      users: [
        {
          email: 'active@engineering.databricks.com',
          lastActive: '2026-09-01T12:00:00Z',
          questions: 4,
          coveredDays: 7,
          tokenUsage: { totalTokens: 100, coveredRuns: 2, coveredQuestions: 1 },
        },
        {
          email: 'rostered-without-activity@example.test',
          lastActive: null,
          questions: 0,
          coveredDays: 0,
          tokenUsage: { totalTokens: null, coveredRuns: null, coveredQuestions: null },
        },
        { email: 'legacy@example.test', lastActive: '' },
      ],
    },
  };
}

describe('User Monitoring response decoding', () => {
  it('rejects a stale pre-fix response so it cannot enter the panel cache', () => {
    expect(() => decodeUserMonitoringCostPayload(payload(USER_MONITORING_SCHEMA_REVISION - 1))).toThrow(
      'user_monitoring_payload_stale'
    );
  });

  it('keeps valid timestamped rows and drops a malformed legacy row defensively', () => {
    const decoded = decodeUserMonitoringCostPayload(payload());
    expect(decoded.userMonitoring?.users.map((row) => row.email)).toEqual([
      'active@engineering.databricks.com',
      'rostered-without-activity@example.test',
    ]);
  });

  it('preserves canonical organization options and counts through the decoder', () => {
    const value = payload();
    value.userMonitoring.organizations = [{ ...organizationForEmail('person@example.com'), count: 4 }];
    const decoded = decodeUserMonitoringCostPayload(value);
    expect(decoded.userMonitoring?.organizations).toEqual([
      expect.objectContaining({ id: 'databricks', name: 'Databricks', logoKey: 'databricks', count: 4 }),
    ]);
  });

  it('rejects malformed organization facets instead of silently rendering All as zero', () => {
    const value = payload();
    value.userMonitoring.organizations = [{ ...organizationForEmail('person@example.com'), count: Number.NaN }];
    expect(() => decodeUserMonitoringCostPayload(value)).toThrow('user_monitoring_payload_stale');
  });

  it('re-derives the canonical organization when a cached row is decoded', () => {
    const cached = payload();
    (cached.userMonitoring.users[0] as Record<string, unknown>).organization =
      organizationForEmail('spoof@studio2games.example');
    const decoded = decodeUserMonitoringCostPayload(cached);
    expect(decoded.userMonitoring?.users[0]?.organization).toMatchObject({
      id: 'databricks',
      name: 'Databricks',
      logoKey: 'databricks',
    });
  });

  it('accepts the fast endpoint direct payload without routing through Cost', () => {
    const direct = decodeUserMonitoringCostPayload(payload().userMonitoring);
    expect(direct.userMonitoring?.users.map((row) => row.email)).toEqual([
      'active@engineering.databricks.com',
      'rostered-without-activity@example.test',
    ]);
    expect(MONITORING_SOURCE).toContain('`/api/monitoring/user-spend?${userBrowserParams.toString()}`');
    expect(MONITORING_SOURCE).toContain('`/api/monitoring/user-spend/${encodeURIComponent(drawer.person)}?');
    expect(MONITORING_SOURCE).not.toContain('drawer.person ? `/api/ops/cost?');
    expect(MONITORING_SOURCE).not.toContain('userBrowserKey ? `/api/ops/cost?');
  });

  it('validates cached responses while retaining valid profile-to-browser back navigation', () => {
    expect(MONITORING_SOURCE).toContain('retained = decode(cached.data)');
    expect(MONITORING_SOURCE).toContain('panelCache.delete(scopedKey)');
    expect(MONITORING_SOURCE).toContain('decodeUserMonitoringCostPayload');
    expect(MONITORING_SOURCE).toContain('USER_MONITORING_SCHEMA_REVISION');
    expect(MONITORING_SOURCE).toContain('cached.identityRevision !== identityRevision');
  });
});
