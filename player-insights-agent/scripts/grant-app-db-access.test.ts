import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a one-off operator script, deliberately outside the tsconfig projects.
import {
  APPKIT_CACHE_SCHEMA,
  quoteIdent,
  shouldDropAppkitCacheSchema,
} from './grant-app-db-access.mjs';

/**
 * The AppKit cache remediation is ownership, not privileges.
 *
 * A deployer who only runs `GRANT USAGE, CREATE ON SCHEMA appkit` still fails
 * later CREATE INDEX steps. The grant script drops a misowned cache-only schema
 * so the app recreates and owns it. These cases are the lease against regressing
 * that decision back into a privilege grant.
 */
describe('shouldDropAppkitCacheSchema', () => {
  const appRole = 'app-service-principal-client-id';

  it('drops when the schema has no tables yet (absent or empty)', () => {
    expect(shouldDropAppkitCacheSchema([], appRole)).toBe(true);
  });

  it('drops when any cache table is owned by another role', () => {
    expect(shouldDropAppkitCacheSchema(['developer@example.com'], appRole)).toBe(true);
    expect(shouldDropAppkitCacheSchema([appRole, 'developer@example.com'], appRole)).toBe(true);
  });

  it('keeps the schema only when every cache table is already owned by the app', () => {
    expect(shouldDropAppkitCacheSchema([appRole], appRole)).toBe(false);
    expect(shouldDropAppkitCacheSchema([appRole, appRole], appRole)).toBe(false);
  });

  it('names the cache schema appkit, not the app data schema', () => {
    expect(APPKIT_CACHE_SCHEMA).toBe('appkit');
  });
});

describe('quoteIdent', () => {
  it('quotes Postgres identifiers and doubles embedded quotes', () => {
    expect(quoteIdent('appkit')).toBe('"appkit"');
    expect(quoteIdent('weird"name')).toBe('"weird""name"');
  });
});
