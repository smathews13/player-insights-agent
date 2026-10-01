import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a one-off operator script, deliberately outside the tsconfig projects.
import {
  APPKIT_CACHE_SCHEMA,
  appSchemaGrantStatements,
  foreignAppkitCacheOwners,
  quoteIdent,
} from './grant-app-db-access.mjs';

/**
 * The AppKit cache remediation is ownership, not privileges.
 *
 * A deployer who only runs `GRANT USAGE, CREATE ON SCHEMA appkit` still fails
 * later CREATE INDEX steps. The grant script drops a misowned cache-only schema
 * so the app recreates and owns it. These cases are the lease against regressing
 * that decision back into a privilege grant.
 */
describe('foreignAppkitCacheOwners', () => {
  const appRole = 'app-service-principal-client-id';

  it('accepts an absent schema or one fully owned by this App', () => {
    expect(foreignAppkitCacheOwners('', [], appRole)).toEqual([]);
    expect(foreignAppkitCacheOwners(appRole, [appRole], appRole)).toEqual([]);
  });

  it('reports every foreign schema or table owner without authorizing a drop', () => {
    expect(foreignAppkitCacheOwners('astrolabe-role', [appRole, 'other-app-role'], appRole)).toEqual([
      'astrolabe-role',
      'other-app-role',
    ]);
  });

  it('names the cache schema appkit, not the app data schema', () => {
    expect(APPKIT_CACHE_SCHEMA).toBe('appkit');
  });

  it('never drops the fixed AppKit schema owned by another App', () => {
    expect(readFileSync(new URL('./grant-app-db-access.mjs', import.meta.url), 'utf8')).not.toContain(
      'DROP SCHEMA IF EXISTS'
    );
  });
});

describe('quoteIdent', () => {
  it('quotes Postgres identifiers and doubles embedded quotes', () => {
    expect(quoteIdent('appkit')).toBe('"appkit"');
    expect(quoteIdent('weird"name')).toBe('"weird""name"');
  });
});

describe('appSchemaGrantStatements', () => {
  const role = '"app-service-principal-client-id"';

  it('leaves an absent schema for the app role to create and own', () => {
    expect(appSchemaGrantStatements(false, 'fresh_schema', role)).toEqual([]);
  });

  it('grants access to an existing schema without creating it as the operator', () => {
    const statements = appSchemaGrantStatements(true, 'existing_schema', role);
    expect(statements).not.toHaveLength(0);
    expect(statements.join('\n')).toContain('GRANT USAGE, CREATE ON SCHEMA "existing_schema"');
    expect(statements.join('\n')).not.toContain('CREATE SCHEMA');
  });
});
