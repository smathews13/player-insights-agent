import { describe, expect, it, vi } from 'vitest';

import {
  ACTIVE_MINUTES_PER_DAY_QUERY,
  APP_ACTIVITY_DDL,
  RECORD_APP_ACTIVITY_QUERY,
  recordAppActivityMinute,
  validIanaTimeZone,
} from './app-activity';

describe('first-party app activity', () => {
  it('stores only authenticated identity and a server-derived minute', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await recordAppActivityMinute({ lakebase: { query } }, 'User@Example.test');

    expect(query).toHaveBeenCalledWith(RECORD_APP_ACTIVITY_QUERY, ['User@Example.test']);
    expect(RECORD_APP_ACTIVITY_QUERY).toContain("date_trunc('minute', now())");
    expect(RECORD_APP_ACTIVITY_QUERY).toContain('ON CONFLICT (user_email, active_minute) DO NOTHING');
    expect(RECORD_APP_ACTIVITY_QUERY).not.toMatch(/content|question|token|session/i);
  });

  it('uses an additive table with one row per user and minute', () => {
    expect(APP_ACTIVITY_DDL).toContain('CREATE TABLE IF NOT EXISTS');
    expect(APP_ACTIVITY_DDL).toContain('PRIMARY KEY (user_email, active_minute)');
    expect(APP_ACTIVITY_DDL).not.toMatch(/ALTER TABLE/i);
    expect(ACTIVE_MINUTES_PER_DAY_QUERY).toContain('COUNT(*)::int');
    expect(ACTIVE_MINUTES_PER_DAY_QUERY).toContain('active_minute AT TIME ZONE $1');
    expect(ACTIVE_MINUTES_PER_DAY_QUERY).toContain('MIN(recorded_from) AS recorded_from');
  });

  it('accepts configured and browser IANA zones but rejects arbitrary SQL input', () => {
    expect(validIanaTimeZone('America/Los_Angeles')).toBe('America/Los_Angeles');
    expect(validIanaTimeZone("UTC'); DROP TABLE x; --")).toBe('');
  });
});
