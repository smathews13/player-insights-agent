import { describe, expect, it } from 'vitest';
import { APP_SCHEMA } from '../../shared/app-schema';
import { LATER_MIGRATIONS } from './migrations';

describe('service-principal status migration', () => {
  it('keeps idempotent v36 stable-link evidence before later additive migrations', () => {
    const migration = LATER_MIGRATIONS.find((entry) => entry.version === 36);
    expect(migration?.name).toBe('service principal connection evidence');
    expect(LATER_MIGRATIONS[LATER_MIGRATIONS.length - 3]?.version).toBe(36);
    expect(LATER_MIGRATIONS[LATER_MIGRATIONS.length - 2]?.version).toBe(37);
    expect(LATER_MIGRATIONS[LATER_MIGRATIONS.length - 1]?.version).toBe(38);
    const sql = migration?.statements.join('\n') ?? '';
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS definition_id TEXT');
    expect(sql).toContain('sp_personas_definition_idx');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1');
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${APP_SCHEMA}.sp_persona_status`);
    expect(sql).not.toMatch(/client_secret|access_token|token|secret_value/i);
  });
});
