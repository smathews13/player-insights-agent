import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { USER_MONITORING_SCHEMA_REVISION } from '../../shared/user-monitoring-contract';
import { decodeUserMonitoringCostPayload } from './user-monitoring-payload';

const MONITORING_SOURCE = readFileSync(new URL('./MonitoringPage.tsx', import.meta.url), 'utf8');

function payload(revision = USER_MONITORING_SCHEMA_REVISION) {
  return {
    state: 'ready',
    userMonitoring: {
      schemaRevision: revision,
      users: [
        { email: 'active@example.test', lastActive: '2026-09-01T12:00:00Z' },
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
    expect(decoded.userMonitoring?.users.map((row) => row.email)).toEqual(['active@example.test']);
  });

  it('validates cached responses while retaining valid profile-to-browser back navigation', () => {
    expect(MONITORING_SOURCE).toContain('retained = decode(cached.data)');
    expect(MONITORING_SOURCE).toContain('panelCache.delete(scopedKey)');
    expect(MONITORING_SOURCE).toContain('decodeUserMonitoringCostPayload');
    expect(MONITORING_SOURCE).toContain('USER_MONITORING_SCHEMA_REVISION');
  });
});
