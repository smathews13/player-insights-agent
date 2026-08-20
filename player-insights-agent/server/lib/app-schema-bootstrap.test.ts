import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Deploy-from-Git schema continuity', () => {
  it('keeps the existing schema owned by the unchanged app role', async () => {
    vi.stubEnv('LAKEBASE_ENDPOINT', 'projects/example/branches/production');
    vi.stubEnv('PLAYER_INSIGHTS_TARGET', '');
    vi.stubEnv('PLAYER_INSIGHTS_APP_SCHEMA', 'player_insights');
    vi.resetModules();

    const { preserveOwnedAppSchema } = await import('./app-schema-bootstrap');
    const schema = await preserveOwnedAppSchema({
      query: vi.fn().mockResolvedValue({
        rows: [
          { nspname: 'player_insights_greenfield' },
          { nspname: 'astrolabe' },
        ],
      }),
    });
    const { APP_SCHEMA } = await import('../../shared/app-schema');

    expect(schema).toBe('player_insights_greenfield');
    expect(APP_SCHEMA).toBe('player_insights_greenfield');
  });

  it('uses astrolabe for a new Git app with no existing owned store', async () => {
    vi.stubEnv('LAKEBASE_ENDPOINT', 'projects/example/branches/production');
    vi.stubEnv('PLAYER_INSIGHTS_TARGET', '');
    vi.stubEnv('PLAYER_INSIGHTS_APP_SCHEMA', 'player_insights');
    vi.resetModules();

    const { preserveOwnedAppSchema } = await import('./app-schema-bootstrap');
    const schema = await preserveOwnedAppSchema({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    });

    expect(schema).toBe('astrolabe');
  });
});
