import { describe, expect, it } from 'vitest';
import { LATER_MIGRATIONS } from './migrations';

describe('settings migration safety', () => {
  const migration = LATER_MIGRATIONS.find((entry) => entry.name === 'versioned app settings');

  it('adds conflict metadata without rewriting any saved preference document', () => {
    expect(migration).toBeDefined();
    const sql = migration?.statements.join('\n') ?? '';
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS revision');
    expect(sql).toContain('experimental_settings');
    expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/);
  });

  it('does not seed Experimental defaults during migration or startup', () => {
    const sql = migration?.statements.join('\n') ?? '';
    expect(sql).not.toMatch(/\bINSERT\b/);
    expect(sql).not.toContain('benchmarkLab');
    expect(sql).not.toContain('forecasting');
  });
});
