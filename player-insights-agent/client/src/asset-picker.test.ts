import { describe, expect, it } from 'vitest';

import {
  BROWSE_GRANT_ACTION,
  BROWSE_GRANT_PROMPT,
  BROWSE_TYPE_INSTEAD,
  BROWSE_UNAVAILABLE_CHIP,
  NO_NAME_REPORTED,
  PICKER_FIELDS,
  PICKER_TOP,
  alreadyHeld,
  applyPick,
  browseEmptyNote,
  browsePageUrl,
  browseTransportFailure,
  browseUrl,
  cursorKind,
  cursorTrail,
  filterItems,
  initialCursor,
  namesOpaqueIds,
  orderPickerItems,
  pickerForField,
  pickerRowText,
  rowActions,
  twoPartName,
} from './asset-picker';
import type { AssetPickerSpec } from './asset-picker';
import type { BrowseItem } from '../../shared/browse-contract';
import { SINGLE_SCHEMA_LABEL, WHOLE_CATALOG_LABEL } from '../../shared/data-catalog-scope';
import { connectedResource } from '../../shared/deployment-config';

/**
 * What a picker browses, and what a pick actually stores.
 *
 * These are the decisions in the feature, as against its markup. Three of them
 * are wrong in a way nobody notices from a screenshot: a pick that replaces a
 * declared read scope instead of adding to it, a `data_catalogs` entry stored as
 * a bare catalog when the reader chose one schema, and a refusal rendered as an
 * empty list. Each is asserted here rather than through composed markup, which is
 * also why they live in a pure module in the first place.
 */

function item(over: Partial<BrowseItem> = {}): BrowseItem {
  return { id: '', label: '', secondary: '', expandable: false, ...over };
}

const NOTEBOOK_SPEC: AssetPickerSpec = {
  field: 'notebook-path',
  levels: ['notebooks'],
  pickAt: 'last',
  multi: false,
  title: 'Workspace notebooks',
  typeLabel: 'Notebook path',
  typeNote: '',
};

function spec(field: string): AssetPickerSpec {
  const found = pickerForField(field);
  if (!found) throw new Error(`no picker for ${field}`);
  return found;
}

describe('which fields get a browser', () => {
  it('names a real resource for every picker', () => {
    for (const field of PICKER_FIELDS) {
      expect(connectedResource(field), field).toBeTruthy();
    }
  });

  it('browses nothing for a value with no list behind it', () => {
    // The AI Gateway route is a three-value routing mode and the answer length
    // limit is a number. Neither has a list.
    expect(pickerForField('llm-gateway')).toBeNull();
    expect(pickerForField('max-output-tokens')).toBeNull();
  });

  it('still maps experiment-id, so Apps having no MLflow scope is an unavailable list rather than a missing control', () => {
    const experiment = pickerForField('experiment-id');
    expect(experiment).not.toBeNull();
    expect(experiment?.levels).toEqual(['experiments']);
    expect(experiment?.typeNote).toBe('');
  });

  it('offers no notebook picker, because no editable field takes a path', () => {
    // The route exists and works. The row that reads "Notebook declarations
    // table" holds a TABLE, and a notebook picker for it would produce a value
    // this app cannot read.
    for (const field of PICKER_FIELDS) {
      expect(spec(field).levels, field).not.toContain('notebooks');
    }
  });

  it('gives every field a text label, so typing is never unlabelled', () => {
    for (const field of PICKER_FIELDS) {
      expect(spec(field).typeLabel.length, field).toBeGreaterThan(0);
    }
  });

  it('only offers a browser for a real Connections resource', () => {
    // Option B unlocked every padlock for admins: a picker on an app-redeploy
    // or model-version row records an intention, it does not require
    // stageable/runtime. The guard is that the field is a known resource, not
    // that it applies immediately.
    for (const field of PICKER_FIELDS) {
      expect(connectedResource(field), field).toBeTruthy();
    }
  });

  it('maps Lakebase, volume, VS and experiment fields to their chains', () => {
    expect(spec('lakebase').levels).toEqual(['lakebase-projects', 'lakebase-branches', 'lakebase-databases']);
    expect(spec('assets-volume').levels).toEqual(['catalogs', 'schemas', 'volumes']);
    expect(spec('semantic-index-endpoint').levels).toEqual(['vector-search-endpoints']);
    expect(spec('semantic-index').levels).toEqual(['vector-search-endpoints', 'vector-search-indexes']);
  });
});

describe('warehouse ordering', () => {
  it('puts running warehouses first without hiding stopped warehouses', () => {
    const ordered = orderPickerItems('warehouses', [
      item({ id: 'stopped', secondary: 'STOPPED' }),
      item({ id: 'running', secondary: 'RUNNING' }),
      item({ id: 'starting', secondary: 'STARTING' }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['running', 'stopped', 'starting']);
  });
});

describe('the drill-down chain', () => {
  it('walks catalogs to schemas to tables for a three-part name', () => {
    const tables = spec('notebook-declaration');
    expect(cursorKind(tables, PICKER_TOP)).toBe('catalogs');
    expect(cursorKind(tables, { catalog: 'analytics', schema: '' })).toBe('schemas');
    expect(cursorKind(tables, { catalog: 'analytics', schema: 'player' })).toBe('tables');
  });

  it('stays on its one list where the chain is one list long', () => {
    // A cursor carrying a catalog must not run off the end of a chain that has
    // no deeper level.
    expect(cursorKind(spec('sql-warehouse'), { catalog: 'analytics', schema: '' })).toBe('warehouses');
    expect(cursorKind(spec('genie-data'), PICKER_TOP)).toBe('genie-spaces');
    expect(cursorKind(spec('llm-endpoint'), PICKER_TOP)).toBe('serving-endpoints');
    expect(cursorKind(spec('judge-endpoint'), PICKER_TOP)).toBe('serving-endpoints');
  });

  it('asks each route for the level it is on, carrying the names below it', () => {
    expect(browseUrl('catalogs', PICKER_TOP)).toBe('/api/browse/catalogs');
    expect(browseUrl('schemas', { catalog: 'analytics', schema: '' })).toBe('/api/browse/schemas?catalog=analytics');
    expect(browseUrl('tables', { catalog: 'analytics', schema: 'player' })).toBe(
      '/api/browse/tables?catalog=analytics&schema=player'
    );
    expect(browseUrl('volumes', { catalog: 'analytics', schema: 'player' })).toBe(
      '/api/browse/volumes?catalog=analytics&schema=player'
    );
    expect(browseUrl('genie-spaces', PICKER_TOP)).toBe('/api/browse/genie-spaces');
    expect(browseUrl('serving-endpoints', PICKER_TOP)).toBe('/api/browse/serving-endpoints');
    expect(browseUrl('vector-search-endpoints', PICKER_TOP)).toBe('/api/browse/vector-search-endpoints');
    expect(browseUrl('vector-search-indexes', { catalog: 'vs-ep', schema: '' })).toBe(
      '/api/browse/vector-search-indexes?endpoint=vs-ep'
    );
    expect(browseUrl('lakebase-branches', { catalog: 'projects/demo', schema: '' })).toBe(
      '/api/browse/lakebase-branches?project=projects%2Fdemo'
    );
    expect(
      browseUrl('lakebase-databases', {
        catalog: 'projects/demo',
        schema: 'projects/demo/branches/production',
      })
    ).toBe('/api/browse/lakebase-databases?branch=projects%2Fdemo%2Fbranches%2Fproduction');
  });

  it('escapes a name that would otherwise change the query', () => {
    expect(browseUrl('schemas', { catalog: 'a b&c', schema: '' })).toBe('/api/browse/schemas?catalog=a%20b%26c');
  });

  it('adds a page token to a route that already has a query', () => {
    expect(browsePageUrl('tables', { catalog: 'a', schema: 'b' }, 'tok/1')).toBe(
      '/api/browse/tables?catalog=a&schema=b&page_token=tok%2F1'
    );
    expect(browsePageUrl('catalogs', PICKER_TOP, 'tok')).toBe('/api/browse/catalogs?page_token=tok');
  });
});

describe('where a browser opens', () => {
  it('opens on the schemas of the catalog a table value already names', () => {
    // A reader changing a table almost always wants a sibling of the one there.
    expect(initialCursor(spec('notebook-declaration'), { current: 'analytics.player.sessions' })).toEqual({
      catalog: 'analytics',
      schema: 'player',
    });
  });

  it('opens Lakebase inside an already-chosen project and branch', () => {
    expect(
      initialCursor(spec('lakebase'), {
        current: 'projects/demo/branches/production/databases/databricks-postgres',
      })
    ).toEqual({
      catalog: 'projects/demo',
      schema: 'projects/demo/branches/production',
    });
  });

  it('takes the catalog from the row beside it when the value is a bare schema', () => {
    // The App schema row stores `player`, which says nothing about a catalog.
    expect(initialCursor(spec('schema'), { current: 'player', catalog: 'analytics' })).toEqual({
      catalog: 'analytics',
      schema: '',
    });
  });

  it('opens at the top when nothing says which catalog', () => {
    expect(initialCursor(spec('schema'), { current: '', catalog: '' })).toEqual(PICKER_TOP);
    expect(initialCursor(spec('catalog'), { current: 'analytics' })).toEqual(PICKER_TOP);
  });

  it('opens a list field at the top, so both blast radii stay visible', () => {
    // data_catalogs offers a whole catalog and a single schema as two different
    // picks. Opening inside a catalog would show only the narrower one.
    expect(initialCursor(spec('catalog-allowlist'), { current: 'analytics.player', catalog: 'analytics' })).toEqual(
      PICKER_TOP
    );
    expect(initialCursor(spec('catalog-denylist'), { current: 'raw_*', catalog: 'analytics' })).toEqual(PICKER_TOP);
  });

  it('always offers the way back to the top of a chain it opened inside', () => {
    const trail = cursorTrail(spec('notebook-declaration'), {
      catalog: 'analytics',
      schema: 'player',
    });
    expect(trail.map((step) => step.label)).toEqual(['All catalogs', 'analytics', 'analytics.player']);
    expect(trail[0].cursor).toEqual(PICKER_TOP);
  });

  it('draws no trail for a field with one list', () => {
    expect(cursorTrail(spec('sql-warehouse'), PICKER_TOP)).toEqual([]);
    expect(cursorTrail(spec('catalog'), PICKER_TOP)).toEqual([]);
  });
});

describe('what a row offers', () => {
  it('opens a catalog and takes a schema for the App schema field', () => {
    const schema = spec('schema');
    const atTop = rowActions(schema, PICKER_TOP, item({ id: 'analytics', label: 'analytics' }));
    expect(atTop).toHaveLength(1);
    expect(atTop[0].kind).toBe('open');

    const inside = rowActions(
      schema,
      { catalog: 'analytics', schema: '' },
      item({ id: 'player', label: 'player', secondary: 'analytics.player' })
    );
    expect(inside).toHaveLength(1);
    expect(inside[0]).toMatchObject({ kind: 'pick', value: 'player' });
  });

  it('stores the whole three-part name when a table is taken', () => {
    const actions = rowActions(
      spec('notebook-declaration'),
      { catalog: 'analytics', schema: 'player' },
      item({ id: 'analytics.player.sessions', label: 'sessions', secondary: 'MANAGED' })
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'pick', value: 'analytics.player.sessions' });
  });

  /**
   * THE BLAST RADIUS IS THE POINT OF THE data_catalogs PICKER.
   *
   * A bare catalog name grants every non-system schema in it; a two-part name
   * grants one. A picker that offered only one of those, or offered both without
   * saying which was which, would leave a customer unsure what they opened up.
   */
  it('offers a catalog row as both a whole-catalog scope and a door', () => {
    const actions = rowActions(spec('catalog-allowlist'), PICKER_TOP, item({ id: 'analytics', label: 'analytics' }));
    expect(actions.map((action) => action.kind)).toEqual(['open', 'pick']);
    expect(actions[1]).toMatchObject({ value: 'analytics', note: WHOLE_CATALOG_LABEL });
  });

  it('stores the two-part name for a single-schema read scope', () => {
    const actions = rowActions(
      spec('catalog-allowlist'),
      { catalog: 'analytics', schema: '' },
      item({ id: 'player', label: 'player', secondary: 'analytics.player' })
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ value: 'analytics.player', note: SINGLE_SCHEMA_LABEL });
  });

  it('labels the two data_catalogs picks with the words the page already uses', () => {
    expect(WHOLE_CATALOG_LABEL).toBe('every non-system schema');
    expect(SINGLE_SCHEMA_LABEL).toBe('this schema only');
  });

  it('prefers the name the workspace reported over one assembled from a cursor', () => {
    // full_name is what data_catalogs is matched against. Assembling a name from
    // a cursor is the fallback, for an answer that omitted it.
    expect(twoPartName({ catalog: 'analytics', schema: '' }, item({ id: 'player', secondary: 'main.player' }))).toBe(
      'main.player'
    );
    expect(twoPartName({ catalog: 'analytics', schema: '' }, item({ id: 'player', secondary: '' }))).toBe(
      'analytics.player'
    );
  });
});

describe('workspace notebook navigation', () => {
  it('opens beside the configured notebook and builds hierarchical routes', () => {
    expect(initialCursor(NOTEBOOK_SPEC, { current: '/Shared/demos/player-insights' })).toEqual({
      catalog: '/Shared/demos',
      schema: '',
    });
    expect(browseUrl('notebooks', PICKER_TOP)).toBe('/api/browse/notebooks');
    expect(browseUrl('notebooks', { catalog: '/Shared/demos', schema: '' })).toBe(
      '/api/browse/notebooks?path=%2FShared%2Fdemos'
    );
    expect(cursorTrail(NOTEBOOK_SPEC, { catalog: '/Shared/demos', schema: '' }).map((step) => step.label)).toEqual([
      'Notebook home',
      'Workspace root',
      'Shared',
      'demos',
    ]);
  });

  it('opens folders and selects only notebook rows', () => {
    expect(
      rowActions(
        NOTEBOOK_SPEC,
        { catalog: '/Shared', schema: '' },
        item({ id: '/Shared/demos', label: 'demos', expandable: true })
      )
    ).toEqual([{ kind: 'open', label: 'Open', cursor: { catalog: '/Shared/demos', schema: '' } }]);
    expect(
      rowActions(
        NOTEBOOK_SPEC,
        { catalog: '/Shared/demos', schema: '' },
        item({ id: '/Shared/demos/player-insights', label: 'player-insights' })
      )
    ).toEqual([{ kind: 'pick', label: 'Use', value: '/Shared/demos/player-insights', note: '' }]);
  });
});

describe('what a pick does to the value already there', () => {
  it('replaces a single value', () => {
    expect(applyPick(spec('sql-warehouse'), 'old-id', 'new-id')).toBe('new-id');
    expect(applyPick(spec('schema'), 'player', 'sessions')).toBe('sessions');
  });

  /**
   * A LIST GAINS AN ENTRY. Replacing here would silently drop a declared read
   * scope, and the operator would find out when the agent stopped being able to
   * query something.
   */
  it('adds to a list rather than replacing it', () => {
    expect(applyPick(spec('catalog-allowlist'), 'analytics, shared.reference', 'main')).toBe(
      'analytics, shared.reference, main'
    );
    expect(applyPick(spec('catalog-denylist'), 'raw_*', 'analytics.player.scratch')).toBe(
      'raw_*, analytics.player.scratch'
    );
  });

  it('adds an entry once', () => {
    expect(applyPick(spec('catalog-allowlist'), 'analytics, main', 'analytics')).toBe('analytics, main');
  });

  it('starts a list from empty', () => {
    expect(applyPick(spec('catalog-allowlist'), '', 'analytics')).toBe('analytics');
    expect(applyPick(spec('catalog-allowlist'), '  ', 'analytics')).toBe('analytics');
  });

  it('says when a row is already taken, so its button can rest', () => {
    expect(alreadyHeld(spec('catalog-allowlist'), 'analytics, main', 'main')).toBe(true);
    expect(alreadyHeld(spec('catalog-allowlist'), 'analytics, main', 'other')).toBe(false);
    expect(alreadyHeld(spec('sql-warehouse'), 'wh-1', 'wh-1')).toBe(true);
    expect(alreadyHeld(spec('sql-warehouse'), 'wh-1', 'wh-2')).toBe(false);
  });
});

describe('what a row is called', () => {
  /**
   * NEVER A BARE ID AS THE ONLY LABEL. The two kinds whose id is opaque are the
   * whole reason the picker helps: an operator knows a Genie space by its title
   * and the setting stores a uuid.
   */
  it('prints the name with its identifier under it', () => {
    expect(pickerRowText('genie-spaces', item({ id: '01ef', label: 'Player data' }))).toEqual({
      primary: 'Player data',
      identifier: '01ef',
      secondary: '',
    });
    expect(
      pickerRowText('warehouses', item({ id: 'abc123', label: 'Shared serverless', secondary: 'RUNNING' }))
    ).toEqual({ primary: 'Shared serverless', identifier: 'abc123', secondary: 'RUNNING' });
  });

  it('says a name was not reported rather than passing the id off as one', () => {
    const row = pickerRowText('warehouses', item({ id: 'abc123', label: 'abc123', secondary: 'STOPPED' }));
    expect(row.primary).toBe('abc123');
    expect(row.secondary).toContain(NO_NAME_REPORTED);
    expect(row.secondary).toContain('STOPPED');
  });

  it('does not claim a missing name where the id IS the name', () => {
    // A catalog, a schema and a serving endpoint are named by their identifier.
    for (const kind of ['catalogs', 'schemas', 'serving-endpoints'] as const) {
      expect(namesOpaqueIds(kind)).toBe(false);
      expect(pickerRowText(kind, item({ id: 'analytics', label: 'analytics' })).secondary).toBe('');
    }
  });

  it('shows a table by its short name with the full one beside it', () => {
    expect(pickerRowText('tables', item({ id: 'analytics.player.sessions', label: 'sessions' }))).toMatchObject({
      primary: 'sessions',
      identifier: 'analytics.player.sessions',
    });
  });
});

describe('narrowing a long list', () => {
  const rows = [
    item({ id: 'analytics.player.sessions', label: 'sessions', secondary: 'MANAGED' }),
    item({ id: 'analytics.player.installs', label: 'installs', secondary: 'VIEW' }),
  ];

  it('matches a name, an identifier or the aside', () => {
    expect(filterItems(rows, 'sess')).toHaveLength(1);
    expect(filterItems(rows, 'ANALYTICS')).toHaveLength(2);
    expect(filterItems(rows, 'view')).toHaveLength(1);
    expect(filterItems(rows, '')).toHaveLength(2);
  });
});

describe('the three outcomes, kept apart', () => {
  /**
   * The contract's whole value is spent here or nowhere. An empty answer, a
   * refusal and a broken call have to read as three different things, and the one
   * that must never look like the others is the refusal: nothing was established
   * about which assets exist.
   */
  it('offers the permission rather than reporting a fault', () => {
    expect(BROWSE_GRANT_PROMPT).toBe('Grant these to enable browsing');
    expect(BROWSE_UNAVAILABLE_CHIP).toBe('Not carried');
    // Not the gate's words for a required shortfall, and not a claim about grants.
    expect(BROWSE_UNAVAILABLE_CHIP).not.toMatch(/missing/i);
    expect(BROWSE_GRANT_ACTION).toBe('');
  });

  it('says nothing was established, so an absence is not read as an answer', () => {
    expect(BROWSE_TYPE_INSTEAD).toMatch(/Nothing was established/);
  });

  it('reads an empty list as an answer about the workspace', () => {
    expect(browseEmptyNote('catalogs')).toBe('No catalogs are visible to your sign-in.');
    expect(browseEmptyNote('schemas')).toMatch(/in this catalog/);
    expect(browseEmptyNote('tables')).toMatch(/in this schema/);
    expect(browseEmptyNote('warehouses')).toMatch(/SQL warehouse/);
    expect(browseEmptyNote('genie-spaces')).toMatch(/Genie space/);
    expect(browseEmptyNote('serving-endpoints')).toMatch(/serving endpoint/);
    for (const kind of ['catalogs', 'schemas', 'tables', 'warehouses'] as const) {
      expect(browseEmptyNote(kind), kind).not.toMatch(/permission|refus|scope/i);
    }
  });

  it('reports a fetch that threw as failed, never as an empty list', () => {
    const failure = browseTransportFailure('catalogs', 'network down');
    expect(failure.status).toBe('failed');
    expect(failure.status).not.toBe('unavailable');
    if (failure.status === 'failed') {
      expect(failure.detail).toMatch(/nothing was established/i);
      expect(failure.error).toBe('network down');
    }
  });
});

describe('the copy rules the page keeps', () => {
  const strings = [
    BROWSE_GRANT_PROMPT,
    BROWSE_UNAVAILABLE_CHIP,
    BROWSE_GRANT_ACTION,
    BROWSE_TYPE_INSTEAD,
    ...PICKER_FIELDS.flatMap((field) => [spec(field).title, spec(field).typeLabel, spec(field).typeNote]),
  ];

  it('uses no em dash anywhere', () => {
    for (const line of strings) {
      expect(line, line).not.toMatch(/—|–/);
    }
  });
});
