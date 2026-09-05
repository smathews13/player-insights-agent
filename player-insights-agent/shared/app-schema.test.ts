import { describe, expect, it } from 'vitest';

import {
  APP_SCHEMA,
  APP_SCHEMA_ENV,
  APP_TARGET_ENV,
  DEFAULT_APP_SCHEMA,
  LAKEBASE_ENDPOINT_ENV,
  LEGACY_APP_SCHEMA,
  appTable,
  resolveAppSchema,
} from './app-schema';

describe('the Lakebase app schema', () => {
  it('uses a Player Insights Agent-owned schema for a direct Git deployment', () => {
    expect(DEFAULT_APP_SCHEMA).toBe('player_insights_agent');
    const gitDeploy = { [LAKEBASE_ENDPOINT_ENV]: 'projects/example/branches/production' };
    expect(resolveAppSchema(gitDeploy)).toBe('player_insights_agent');
    expect(resolveAppSchema({ ...gitDeploy, [APP_SCHEMA_ENV]: '' })).toBe('player_insights_agent');
    expect(resolveAppSchema({ ...gitDeploy, [APP_SCHEMA_ENV]: '   ' })).toBe('player_insights_agent');
    // Public app.yaml still carries this legacy value. With no bundle target it
    // is a source-only deploy, not an instruction to reuse somebody else's
    // schema.
    expect(
      resolveAppSchema({
        ...gitDeploy,
        [APP_SCHEMA_ENV]: LEGACY_APP_SCHEMA,
      })
    ).toBe('player_insights_agent');
  });

  it('does not move an existing bundle deployment or its stored roles', () => {
    expect(
      resolveAppSchema({
        [APP_SCHEMA_ENV]: LEGACY_APP_SCHEMA,
        [APP_TARGET_ENV]: 'customer',
      })
    ).toBe('player_insights');
  });

  it('keeps local development and source fixtures on the legacy schema', () => {
    expect(resolveAppSchema({})).toBe('player_insights');
  });

  it('honours PLAYER_INSIGHTS_APP_SCHEMA when set', () => {
    expect(resolveAppSchema({ [APP_SCHEMA_ENV]: 'custom_schema' })).toBe('custom_schema');
  });

  it('qualifies table names against the process schema', () => {
    expect(appTable('conversations')).toBe(`${APP_SCHEMA}.conversations`);
  });
});
