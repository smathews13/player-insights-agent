import { describe, expect, it } from 'vitest';

import { SQL_QUERY_TAG_LIMIT, SQL_QUERY_TAG_TEXT_LIMIT, safeSqlTagIdentifier, sqlQueryTags } from './sql-query-tags';

describe('SQL query tags', () => {
  it('returns stable Player Insights Agent attribution within Statement Execution limits', () => {
    const tags = sqlQueryTags({
      surface: 'connections',
      tool: 'access_verification',
      operation: 'preflight',
      runId: 'run_123-abc',
      correlationId: 'request_456',
    });

    expect(tags).toEqual([
      { key: 'application', value: 'Player Insights Agent' },
      { key: 'surface', value: 'connections' },
      { key: 'tool', value: 'access_verification' },
      { key: 'operation', value: 'preflight' },
      { key: 'run_id', value: 'run_123-abc' },
      { key: 'correlation_id', value: 'request_456' },
    ]);
    expect(tags.length).toBeLessThanOrEqual(SQL_QUERY_TAG_LIMIT);
    expect(tags.every(({ key, value }) => key.length <= 128 && value.length <= 128)).toBe(true);
  });

  it('omits identifiers that the caller does not already have', () => {
    const tags = sqlQueryTags({
      surface: 'telemetry',
      tool: 'ops_telemetry',
      operation: 'exporter_read',
    });

    expect(tags.map(({ key }) => key)).toEqual(['application', 'surface', 'tool', 'operation']);
  });

  it('hashes unsafe or oversized identifiers instead of leaking their contents', () => {
    const sensitive = `analyst@example.invalid SELECT * FROM private_catalog.schema.table ${'x'.repeat(180)}`;
    const safe = safeSqlTagIdentifier(sensitive);

    expect(safe).toMatch(/^id_[a-f0-9]{64}$/);
    expect(safe.length).toBeLessThanOrEqual(SQL_QUERY_TAG_TEXT_LIMIT);
    expect(safe).not.toContain('analyst');
    expect(safe).not.toContain('private_catalog');
    expect(safeSqlTagIdentifier(sensitive)).toBe(safe);
  });
});
