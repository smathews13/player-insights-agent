import { describe, expect, it } from 'vitest';
import { databricksLink, normalizeWorkspaceHost, workspacePath } from './databricks-links';

const HOST = 'https://example-workspace.invalid';

describe('normalizeWorkspaceHost', () => {
  it('accepts the four shapes DATABRICKS_HOST is written in', () => {
    expect(normalizeWorkspaceHost('example.invalid')).toBe('https://example.invalid');
    expect(normalizeWorkspaceHost('https://example.invalid')).toBe('https://example.invalid');
    expect(normalizeWorkspaceHost('https://example.invalid/')).toBe('https://example.invalid');
    expect(normalizeWorkspaceHost('  https://example.invalid//  ')).toBe('https://example.invalid');
  });

  it('reports nothing rather than a scheme with no host', () => {
    expect(normalizeWorkspaceHost('')).toBe('');
    expect(normalizeWorkspaceHost('   ')).toBe('');
    expect(normalizeWorkspaceHost(undefined)).toBe('');
    expect(normalizeWorkspaceHost(null)).toBe('');
  });
});

describe('workspacePath', () => {
  it('builds a path for each object it knows', () => {
    expect(workspacePath({ kind: 'serving-endpoint', name: 'an-endpoint' })).toBe('/ml/endpoints/an-endpoint');
    expect(workspacePath({ kind: 'genie-space', spaceId: '01ab' })).toBe('/genie/rooms/01ab');
    expect(workspacePath({ kind: 'sql-warehouse', warehouseId: 'wh1' })).toBe('/sql/warehouses/wh1');
    expect(workspacePath({ kind: 'catalog', catalog: 'a_catalog' })).toBe('/explore/data/a_catalog');
    expect(workspacePath({ kind: 'schema', catalog: 'a_catalog', schema: 'a_schema' })).toBe('/explore/data/a_catalog/a_schema');
    expect(workspacePath({ kind: 'experiment', experimentId: '123' })).toBe('/ml/experiments/123');
    expect(workspacePath({ kind: 'vector-index', index: 'a.b.c' })).toBe('/explore/data/a/b/c');
    expect(workspacePath({ kind: 'table', table: 'a_catalog.a_schema.a_table' })).toBe('/explore/data/a_catalog/a_schema/a_table');
  });

  it('refuses to build a path from a missing identifier', () => {
    expect(workspacePath({ kind: 'serving-endpoint', name: '' })).toBeNull();
    expect(workspacePath({ kind: 'genie-space', spaceId: '  ' })).toBeNull();
    expect(workspacePath({ kind: 'sql-warehouse', warehouseId: '' })).toBeNull();
    expect(workspacePath({ kind: 'catalog', catalog: '' })).toBeNull();
    expect(workspacePath({ kind: 'experiment', experimentId: '' })).toBeNull();
  });

  // A schema path with an empty catalog segment resolves to a different object,
  // which is worse than no link: it works, and it is wrong.
  it('refuses a schema path with only half a name', () => {
    expect(workspacePath({ kind: 'schema', catalog: 'a_catalog', schema: '' })).toBeNull();
    expect(workspacePath({ kind: 'schema', catalog: '', schema: 'a_schema' })).toBeNull();
  });

  it('refuses an index name that is not three levels', () => {
    expect(workspacePath({ kind: 'vector-index', index: 'b.c' })).toBeNull();
    expect(workspacePath({ kind: 'vector-index', index: 'c' })).toBeNull();
    expect(workspacePath({ kind: 'vector-index', index: 'a.b.c.d' })).toBeNull();
    expect(workspacePath({ kind: 'vector-index', index: '' })).toBeNull();
  });

  // The commonest thing an answer cites is the tail of a name -- prose says
  // `gold_title_daily_summary`, not the catalog it lives in -- and that tail
  // addresses no workspace object. Two levels resolve to the schema, which is a
  // working link to the wrong page, so both are refused and the identifier is
  // rendered without a link instead.
  it('refuses a table name that is not three levels', () => {
    expect(workspacePath({ kind: 'table', table: 'a_schema.a_table' })).toBeNull();
    expect(workspacePath({ kind: 'table', table: 'a_table' })).toBeNull();
    expect(workspacePath({ kind: 'table', table: 'a.b.c.d' })).toBeNull();
    expect(workspacePath({ kind: 'table', table: '' })).toBeNull();
  });

  it('escapes an identifier rather than pasting it into a path', () => {
    expect(workspacePath({ kind: 'serving-endpoint', name: 'a/b' })).toBe('/ml/endpoints/a%2Fb');
    expect(workspacePath({ kind: 'catalog', catalog: 'a b' })).toBe('/explore/data/a%20b');
  });

  /**
   * A model is browsed under a `models/` segment, not at the bare three-level
   * path a table uses. Without it the link resolves to a table of that name --
   * usually nothing, occasionally somebody else's table.
   */
  it('opens a registered model under the models segment', () => {
    expect(workspacePath({ kind: 'registered-model', model: 'a_catalog.a_schema.an_agent' })).toBe(
      '/explore/data/models/a_catalog/a_schema/an_agent'
    );
  });

  it('opens the served version of a model, which is where its artifacts are', () => {
    expect(workspacePath({ kind: 'model-version', model: 'a_catalog.a_schema.an_agent', version: '3' })).toBe(
      '/explore/data/models/a_catalog/a_schema/an_agent/version/3'
    );
  });

  // `/version/` with nothing after it is a 404 dressed as a link. The model page
  // lists every version, so it is the honest destination for an unknown one.
  it('falls back to the model when no version is known', () => {
    expect(workspacePath({ kind: 'model-version', model: 'a_catalog.a_schema.an_agent', version: '' })).toBe(
      '/explore/data/models/a_catalog/a_schema/an_agent'
    );
    expect(workspacePath({ kind: 'model-version', model: 'a_catalog.a_schema.an_agent', version: '  ' })).toBe(
      '/explore/data/models/a_catalog/a_schema/an_agent'
    );
  });

  it('refuses a model name that is not three levels', () => {
    expect(workspacePath({ kind: 'registered-model', model: 'a_schema.an_agent' })).toBeNull();
    expect(workspacePath({ kind: 'registered-model', model: 'an_agent' })).toBeNull();
    expect(workspacePath({ kind: 'registered-model', model: '' })).toBeNull();
    expect(workspacePath({ kind: 'model-version', model: 'an_agent', version: '3' })).toBeNull();
  });
});

describe('databricksLink', () => {
  it('joins the host to the path', () => {
    expect(databricksLink(HOST, { kind: 'genie-space', spaceId: '01ab' })).toBe(`${HOST}/genie/rooms/01ab`);
  });

  it('normalises the host it was handed', () => {
    expect(databricksLink('example-workspace.invalid/', { kind: 'genie-space', spaceId: '01ab' })).toBe(`${HOST}/genie/rooms/01ab`);
  });

  // The rule the whole module exists for. A link built without a host lands the
  // reader in a workspace that is not theirs, and a dead link teaches people the
  // page is decorative.
  it('is null with no host, however complete the object', () => {
    expect(databricksLink('', { kind: 'genie-space', spaceId: '01ab' })).toBeNull();
    expect(databricksLink('   ', { kind: 'sql-warehouse', warehouseId: 'wh1' })).toBeNull();
  });

  it('is null with a host and no identifier', () => {
    expect(databricksLink(HOST, { kind: 'sql-warehouse', warehouseId: '' })).toBeNull();
  });

  it('opens a cited table in Catalog Explorer', () => {
    // The link the source row under an answer offers. It is the object the
    // answer says it read, in the workspace the app was told it runs in.
    expect(databricksLink(HOST, { kind: 'table', table: 'a_catalog.a_schema.gold_title_daily_summary' })).toBe(`${HOST}/explore/data/a_catalog/a_schema/gold_title_daily_summary`
    );
  });
});
