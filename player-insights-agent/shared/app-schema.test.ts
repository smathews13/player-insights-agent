import { describe, expect, it } from 'vitest';

import {
  APP_SCHEMA,
  APP_SCHEMA_ENV,
  DEFAULT_APP_SCHEMA,
  appTable,
  resolveAppSchema,
} from './app-schema';

describe('the Lakebase app schema', () => {
  it('defaults to player_insights so existing installs do not silently move', () => {
    expect(DEFAULT_APP_SCHEMA).toBe('player_insights');
    expect(resolveAppSchema({})).toBe('player_insights');
    expect(resolveAppSchema({ [APP_SCHEMA_ENV]: '' })).toBe('player_insights');
    expect(resolveAppSchema({ [APP_SCHEMA_ENV]: '   ' })).toBe('player_insights');
  });

  it('honours PLAYER_INSIGHTS_APP_SCHEMA when set', () => {
    expect(resolveAppSchema({ [APP_SCHEMA_ENV]: 'custom_schema' })).toBe('custom_schema');
  });

  it('qualifies table names against the process schema', () => {
    expect(appTable('conversations')).toBe(`${APP_SCHEMA}.conversations`);
  });
});
