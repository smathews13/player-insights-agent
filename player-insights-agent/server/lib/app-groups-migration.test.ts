import { describe, expect, it } from 'vitest';
import { LATER_MIGRATIONS } from './migrations';

describe('Teams migration', () => {
  it('follows the prior PIA schema and creates the versioned settings table', () => {
    const migration = LATER_MIGRATIONS.find((entry) => entry.name === 'monitoring teams');
    expect(migration?.version).toBe(42);
    expect(migration?.statements.join('\n')).toContain('app_groups');
    expect(migration?.statements.join('\n')).toContain('revision BIGINT');
  });
});
