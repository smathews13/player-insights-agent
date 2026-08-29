/**
 * What the Connections tab says about a notebook and a declared asset.
 *
 * The assertions that matter are about the list and its controls. The old
 * narrative wrapper has been removed, while every declared asset and mutation
 * path remains.
 *
 * Every identifier is invented.
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ADDABLE_KINDS,
  ADD_CONNECTION_PICKERS,
  addedConnectionLabel,
  addedConnectionValue,
  CONNECTION_LIST_TITLE,
  CONNECTION_SCOPE_NOTE,
  EMPTY_SCOPES_LABEL,
  EMPTY_SCOPES_NOTE,
  comparisonBadge,
  comparisonNote,
  connectionCounts,
  connectionRowView,
  emptyScopesNote,
  forgetConnectionDetail,
  isOpaqueAssetId,
  notebookIsBlocked,
  notebookSummary,
  orderConnections,
  pickerForAddKind,
} from './declared-connection-view';
import { NotebookCard } from './NotebookCard';
import { EXPERIMENTAL_PANE_HINT } from './ExperimentalBadge';
import { notebookPathView, persistNotebookPath } from './notebook-card-state';
import { DeclaredConnectionsCard } from './DeclaredConnectionsCard';
import { connectionValueError, createDeclaredConnection, derivedConnectionKey } from './declared-connection-form';
import { DECLARABLE_KEYS, DECLARABLE_KINDS } from '../../shared/notebook-declaration';
import type { ConnectionEntry, DeclarationComparisonRow, NotebookPanel } from './connection-model';

const CARD_SOURCE = readFileSync(new URL('./DeclaredConnectionsCard.tsx', import.meta.url), 'utf8');

function comparison(overrides: Partial<DeclarationComparisonRow> = {}): DeclarationComparisonRow {
  return {
    key: 'warehouse_id',
    label: 'SQL warehouse',
    declared: 'wh-00000000000000aa',
    live: 'wh-00000000000000aa',
    flow: 'needs-model-version',
    verdict: 'agrees',
    ...overrides,
  };
}

function panel(overrides: Partial<NotebookPanel> = {}): NotebookPanel {
  return {
    location: 'customer_catalog.agent_config.declarations',
    read: {
      declaration: {
        source: '/Workspace/Users/analyst@example.invalid/insights-agent',
        revision: 'rev-41',
        publishedAt: '2026-08-17T18:00:00.000Z',
        publishedBy: 'analyst@example.invalid',
        settings: [{ key: 'warehouse_id', value: 'wh-00000000000000aa' }],
        connections: [],
      },
      failure: null,
      detail: '',
    },
    comparison: [comparison()],
    ...overrides,
  };
}

function entry(overrides: Partial<ConnectionEntry['connection']> = {}): ConnectionEntry {
  const connection = {
    id: 'roster-table',
    label: 'Title roster',
    kind: 'unity-catalog' as const,
    value: 'gamesight_share_prod.analytics.title_roster',
    note: '',
    state: 'declared' as const,
    origin: 'app' as const,
    createdAt: '2026-08-17T18:00:00.000Z',
    createdBy: 'analyst@example.invalid',
    changedAt: '2026-08-17T18:00:00.000Z',
    changedBy: 'analyst@example.invalid',
    ...overrides,
  };
  return {
    connection,
    impact: {
      headline: `Remove ${connection.label} from the assets the agent may consider.`,
      consequences: ['The agent stops being offered this asset when it chooses where to look.'],
      recoverable: true,
    },
  };
}

describe('how a published setting reads', () => {
  it('is green only when the published value is the one in use', () => {
    expect(comparisonBadge(comparison()).tone).toBe('green');
    expect(comparisonBadge(comparison({ verdict: 'pending' })).tone).not.toBe('green');
    expect(comparisonBadge(comparison({ verdict: 'refused' })).tone).not.toBe('green');
  });

  /**
   * Amber rather than red, deliberately. Red on this tab means blocked, and a
   * refused key means the deployment is working as designed.
   */
  it('does not report a refused key as a fault', () => {
    const badge = comparisonBadge(comparison({ verdict: 'refused' }));
    expect(badge.tone).toBe('amber');
    expect(badge.label).toBe('Not applied');
  });

  it('tells awaiting a model version apart from never applied', () => {
    expect(comparisonBadge(comparison({ verdict: 'pending' })).label).toMatch(/model version/);
    expect(comparisonBadge(comparison({ verdict: 'refused' })).label).not.toMatch(/model version/);
  });

  it('says nothing extra about a row that is already in use', () => {
    expect(comparisonNote(comparison())).toBe('');
    expect(comparisonNote(comparison({ verdict: 'unknown' }))).toBe('');
  });

  it('says of a refused key that publishing it changes nothing the agent may read', () => {
    const note = comparisonNote(comparison({ verdict: 'refused', flow: 'refused' }));
    expect(note).toMatch(/does not change what the agent may read/);
  });
});

describe('the notebook row', () => {
  it('counts what was published', () => {
    expect(notebookSummary(panel())).toBe('1 setting published');
  });

  it('says no notebook is connected when there is no panel at all', () => {
    expect(notebookSummary(undefined)).toMatch(/No notebook is connected/);
  });

  /**
   * Neither of these is a fault, and reading them as one is how a diagnostics page
   * stops being believed.
   */
  it('does not treat an empty table or an unconfigured one as blocked', () => {
    for (const failure of ['empty', 'not-configured', 'no-token', 'unavailable']) {
      expect.soft(notebookIsBlocked(panel({ read: { declaration: null, failure, detail: 'x' } })), failure).toBe(false);
    }
  });

  it('treats a refused read and a bad location as blocked', () => {
    for (const failure of ['refused', 'bad-location', 'unreadable']) {
      expect.soft(notebookIsBlocked(panel({ read: { declaration: null, failure, detail: 'x' } })), failure).toBe(true);
    }
  });

  it('draws nothing when the server sent no notebook panel', () => {
    expect(renderToStaticMarkup(<NotebookCard />)).toBe('');
  });

  it('shows the notebook, the revision and the published value', () => {
    const markup = renderToStaticMarkup(<NotebookCard panel={panel()} />);
    expect(markup).toContain('Experimental');
    expect(markup).toContain(`title="${EXPERIMENTAL_PANE_HINT}"`);
    expect(markup).toContain('rev-41');
    expect(markup).toMatch(/Published to[\s\S]*\/Workspace\/Users\/analyst@example.invalid\/insights-agent/);
    expect(markup).toMatch(/Path source[\s\S]*Latest published run/);
    expect(markup).not.toContain('not set');
    expect(markup).toContain('Declarations table');
    expect(markup).toContain('customer_catalog.agent_config.declarations');
    expect(markup).toContain('SQL warehouse');
  });

  it('shows configured and observed notebook paths distinctly, preferring configured', () => {
    const configured = panel({
      configuredPath: '/Shared/configured-notebook',
      observedPath: '/Shared/last-run-notebook',
    });
    expect(notebookPathView(configured)).toEqual({
      configured: '/Shared/configured-notebook',
      observed: '/Shared/last-run-notebook',
      shown: '/Shared/configured-notebook',
    });
    const markup = renderToStaticMarkup(<NotebookCard panel={configured} allowMutations onSaved={() => {}} />);
    expect(markup).toMatch(/Published to[\s\S]*\/Shared\/configured-notebook/);
    expect(markup).toMatch(/Path source[\s\S]*Saved configuration/);
    expect(markup).toMatch(/Last published by[\s\S]*\/Shared\/last-run-notebook/);
    expect(markup).toContain('Browse workspace notebooks');
  });

  it('persists a reviewed notebook path and surfaces validation failures', async () => {
    const accepted = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ path: '/Shared/accepted' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    ) as unknown as typeof fetch;
    await expect(persistNotebookPath('/Shared/accepted', accepted)).resolves.toEqual({
      ok: true,
      path: '/Shared/accepted',
    });
    expect(accepted).toHaveBeenCalledWith(
      '/api/settings/notebook-path',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ path: '/Shared/accepted' }) })
    );

    const denied = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: 'Choose a notebook, not a workspace folder.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    ) as unknown as typeof fetch;
    await expect(persistNotebookPath('/Shared/folder', denied)).resolves.toEqual({
      ok: false,
      detail: 'Choose a notebook, not a workspace folder.',
    });
  });
});

/**
 * The one empty value the two documents read oppositely.
 *
 * A notebook setting the scopes list to `[]` means no restriction. This deployment
 * reads an empty one as its own catalog, resolved to its configured schema. The tab
 * cannot reconcile that, and must not: all it owes a reader is what THIS side does,
 * at the moment the value is empty, so the silence does not read as the app having
 * ignored their notebook.
 */
describe('an empty readable-scopes list', () => {
  const declaration = panel().read.declaration;

  function published(settings: Array<{ key: string; value: string }>, emptyScopes = false) {
    return panel({
      read: {
        declaration: { ...declaration!, settings, emptyScopes },
        failure: null,
        detail: '',
      },
      comparison: [],
    });
  }

  it('says nothing when there is no notebook at all', () => {
    expect(emptyScopesNote(undefined)).toBe('');
    expect(emptyScopesNote(panel({ read: { declaration: null, failure: 'empty', detail: 'x' } }))).toBe('');
  });

  /** A line about a setting a reader never touched is what stops the card being read. */
  it('stays silent when the notebook never named the key', () => {
    expect(emptyScopesNote(published([{ key: 'warehouse_id', value: 'wh-00000000000000aa' }]))).toBe('');
  });

  /**
   * The case that bites. The key is dropped from the settings list because it
   * published no value, so without this the tab shows nothing for it and the
   * reader concludes their notebook was ignored.
   */
  it('speaks up when the notebook named the key and left it empty', () => {
    const note = emptyScopesNote(published([{ key: 'warehouse_id', value: 'wh-00000000000000aa' }], true));
    expect(note).toBe(EMPTY_SCOPES_NOTE);
  });

  it('speaks up when nothing was read for the value in use', () => {
    const withRow = panel({ comparison: [comparison({ key: 'catalog_allowlist', live: '', verdict: 'unknown' })] });
    expect(emptyScopesNote(withRow)).toBe(EMPTY_SCOPES_NOTE);
  });

  it('stays silent when both sides name a scope', () => {
    const agreeing = panel({
      comparison: [comparison({ key: 'catalog_allowlist', declared: 'a.b', live: 'a.b' })],
    });
    expect(emptyScopesNote(agreeing)).toBe('');
  });

  /**
   * It states this deployment's behaviour and stops. Narrating the notebook's
   * opposite meaning would be the app explaining someone else's file, and choosing
   * between the two meanings is the notebook owner's call, not this module's.
   */
  it('states what this side does without narrating the notebook', () => {
    expect(EMPTY_SCOPES_NOTE).toMatch(/^Empty means/);
    expect(EMPTY_SCOPES_NOTE).toMatch(/not every catalog/);
    for (const forbidden of [/no restriction/i, /unrestricted/i, /your notebook/i, /notebook means/i]) {
      expect.soft(EMPTY_SCOPES_NOTE, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('is one line, not a paragraph', () => {
    expect(EMPTY_SCOPES_NOTE.split('. ').length).toBe(1);
    expect(EMPTY_SCOPES_NOTE.length).toBeLessThan(90);
  });

  it('names the setting in the words the rest of the tab uses', () => {
    expect(EMPTY_SCOPES_LABEL).toBe(DECLARABLE_KEYS.catalog_allowlist.label);
  });

  it('renders on the card, against the setting it is about', () => {
    const markup = renderToStaticMarkup(
      <NotebookCard panel={published([{ key: 'warehouse_id', value: 'wh-00000000000000aa' }], true)} />
    );
    expect(markup).toContain(EMPTY_SCOPES_NOTE);
    expect(markup).toContain(EMPTY_SCOPES_LABEL);
  });

  it('is absent from the card when neither side reads empty', () => {
    const markup = renderToStaticMarkup(<NotebookCard panel={panel()} />);
    expect(markup).not.toContain(EMPTY_SCOPES_NOTE);
  });
});

describe('the list of assets the agent may consider', () => {
  it('removes the narrative wrapper without losing declared assets', () => {
    const markup = renderToStaticMarkup(
      <DeclaredConnectionsCard entries={[entry()]} allowMutations onChanged={() => {}} />
    );
    expect(markup).toContain('Title roster');
    expect(markup).not.toContain(CONNECTION_LIST_TITLE);
    expect(markup).not.toContain(CONNECTION_SCOPE_NOTE);
    expect(markup).not.toContain('plane-card-head');
  });

  it('uses the standard accordion row and persisted provenance', () => {
    const markup = renderToStaticMarkup(<DeclaredConnectionsCard entries={[entry()]} onChanged={() => {}} />);
    expect(markup).toContain('connection-row-summary');
    expect(markup).toContain('connection-row-detail');
    expect(markup).toContain('Added by');
    expect(markup).toContain('analyst@example.invalid');
    expect(markup).toContain('dateTime="2026-08-17T18:00:00.000Z"');
  });

  it('labels legacy rows without inventing a creator or date', () => {
    const markup = renderToStaticMarkup(
      <DeclaredConnectionsCard entries={[entry({ createdAt: undefined, createdBy: undefined })]} onChanged={() => {}} />
    );
    expect(markup).toContain('Added previously');
    expect(markup).not.toContain('Added by');
  });

  it('derives stable keys and resolves collisions', () => {
    const first = derivedConnectionKey('sql-warehouse', 'wh-01', []);
    expect(first).toBe('sql-warehouse-wh-01');
    expect(derivedConnectionKey('sql-warehouse', 'wh-01', [first])).toBe('sql-warehouse-wh-01-2');
  });

  it('validates structured identifiers before submission', () => {
    expect(connectionValueError('schema', 'catalog_only')).toBe('Use catalog.schema.');
    expect(connectionValueError('table', 'catalog.schema')).toBe('Use catalog.schema.name.');
    expect(connectionValueError('volume', 'catalog.schema.volume')).toBe('Use /Volumes/catalog/schema/volume.');
    expect(connectionValueError('table', 'catalog.schema.table')).toBe('');
  });

  it('keeps server provenance on successful create and returns no phantom entry on failure', async () => {
    const persisted = entry({
      id: 'sql-warehouse-wh-01',
      resourceType: 'sql-warehouse',
      kind: 'sql-warehouse',
      value: 'wh-01',
    });
    const successFetch = vi.fn((_url: string, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected a JSON request body');
      expect(JSON.parse(init.body)).toMatchObject({ resourceType: 'sql-warehouse', value: 'wh-01' });
      return Promise.resolve(new Response(JSON.stringify(persisted), { status: 201 }));
    });
    const success = await createDeclaredConnection(
      {
        id: persisted.connection.id,
        label: 'Analytics',
        kind: 'sql-warehouse',
        resourceType: 'sql-warehouse',
        value: 'wh-01',
      },
      successFetch as typeof fetch
    );
    expect(success.ok && success.entry.connection.createdBy).toBe('analyst@example.invalid');

    const failure = await createDeclaredConnection(
      {
        id: 'sql-warehouse-wh-02',
        label: '',
        kind: 'sql-warehouse',
        resourceType: 'sql-warehouse',
        value: 'wh-02',
      },
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ detail: 'Warehouse wh-02 is unavailable.' }), { status: 409 }))
      )
    );
    expect(failure).toEqual({ ok: false, detail: 'Warehouse wh-02 is unavailable.' });
    expect(failure).not.toHaveProperty('entry');
  });

  it('never claims the asset is granted, connected or accessible', () => {
    const markup = renderToStaticMarkup(<DeclaredConnectionsCard entries={[entry()]} onChanged={() => {}} />);
    for (const forbidden of ['grants you', 'now readable', 'access granted']) {
      expect.soft(markup, forbidden).not.toContain(forbidden);
    }
  });

  it('offers only kinds the server will accept', () => {
    for (const option of ADDABLE_KINDS) {
      expect.soft(DECLARABLE_KINDS as readonly string[], option.kind).toContain(option.kind);
    }
  });

  it('offers precise singular resource types', () => {
    expect(ADDABLE_KINDS.slice(0, 3).map((option) => option.label)).toEqual(['Catalog', 'Schema', 'Table or view']);
    const markup = renderToStaticMarkup(<DeclaredConnectionsCard entries={[]} allowMutations onChanged={() => {}} />);
    expect(markup).toContain('+ Add a new connection');
    expect(markup).toContain('data-testid="add-connection-row"');
  });

  it('puts the outlined add-connection row after the declared asset rows', () => {
    const markup = renderToStaticMarkup(
      <DeclaredConnectionsCard entries={[entry()]} allowMutations onChanged={() => {}} />
    );
    expect(markup.indexOf('Title roster')).toBeLessThan(markup.indexOf('data-testid="add-connection-row"'));
    expect(markup).toContain('plane-add-row');
    expect(markup).toContain('plane-add-connection');
    expect(markup).toMatch(/class="plane-add-row" data-testid="add-connection-row"/);
  });

  it('puts removed assets after listed ones', () => {
    const ordered = orderConnections([entry({ id: 'gone', state: 'withdrawn' }), entry({ id: 'here' })]);
    expect(ordered.map((item) => item.connection.id)).toEqual(['here', 'gone']);
  });

  it('never renders a zero count', () => {
    expect(connectionCounts([])).toBe('');
    expect(connectionCounts([entry()])).toBe('1 listed');
    expect(connectionCounts([entry(), entry({ id: 'gone', state: 'withdrawn' })])).toBe('1 listed · 1 removed');
  });

  it('offers to put a removed asset back rather than only reporting it gone', () => {
    const markup = renderToStaticMarkup(
      <DeclaredConnectionsCard
        entries={[entry({ id: 'gone', state: 'withdrawn' })]}
        allowMutations
        onChanged={() => {}}
      />
    );
    expect(markup).toContain('Put back');
  });

  it('offers an administrator a keyboard-reachable permanent removal on every remembered row', () => {
    const markup = renderToStaticMarkup(
      <DeclaredConnectionsCard
        entries={[entry(), entry({ id: 'gone', state: 'withdrawn' })]}
        allowMutations
        onChanged={() => {}}
      />
    );
    expect(markup.match(/aria-label="Remove forever:/g)).toHaveLength(2);
    expect(markup.match(/class="plane-row-forget"/g)).toHaveLength(2);
    expect(markup).toContain('title="Remove forever"');
  });

  it('does not advertise a permanent mutation the server would refuse to a consumer', () => {
    const markup = renderToStaticMarkup(<DeclaredConnectionsCard entries={[entry()]} onChanged={() => {}} />);
    expect(markup).not.toContain('Remove forever');
    expect(markup).not.toContain('plane-row-forget');
  });

  it('states that permanent removal cannot be undone and names the notebook exception', () => {
    expect(forgetConnectionDetail('app')).toMatch(/cannot be undone/i);
    expect(forgetConnectionDetail('notebook')).toMatch(/Publishing the notebook again may add it back/);
  });

  it('says nothing can be changed when the store is not answering', () => {
    const markup = renderToStaticMarkup(
      <DeclaredConnectionsCard entries={[entry()]} storeAvailable={false} onChanged={() => {}} />
    );
    expect(markup).toMatch(/not answering/);
  });

  it('draws no empty wrapper for a read-only empty list', () => {
    const markup = renderToStaticMarkup(<DeclaredConnectionsCard onChanged={() => {}} />);
    expect(markup).toBe('');
  });
});

/**
 * Only Genie spaces browsed. The other four kinds mapped to no picker at all,
 * so choosing one left the reader with the bare text box and no way to find the
 * identifier it wanted. Every kind in the dropdown now reaches a real list.
 */
describe('every addable kind browses', () => {
  it.each([
    ['table', 'tables'],
    ['genie-space', 'genie-spaces'],
    ['catalog', 'catalogs'],
    ['sql-warehouse', 'warehouses'],
    ['volume', 'volumes'],
    ['vector-search-index', 'vector-search-indexes'],
    ['serving-endpoint', 'serving-endpoints'],
  ])('opens the %s picker on the %s list', (kindId, leaf) => {
    const spec = pickerForAddKind(kindId);
    expect(spec).not.toBeNull();
    expect(spec!.levels.at(-1)).toBe(leaf);
  });

  it('leaves no kind in the dropdown without a list behind it', () => {
    for (const option of ADDABLE_KINDS) {
      expect.soft(ADD_CONNECTION_PICKERS[option.browse], option.label).toBeTruthy();
    }
  });

  /**
   * A reader must choose what they are adding before the form asks them to name
   * it. Source order is keyboard order here because the form uses no tabindex
   * overrides and CSS does not reorder its children.
   */
  it('puts resource type before every field whose meaning depends on it', () => {
    const kind = CARD_SOURCE.indexOf('label="Resource type"');
    expect(kind).toBeGreaterThan(0);
    for (const field of ['-identifier`}', '-label`}', '-key`}']) {
      expect.soft(CARD_SOURCE.indexOf(field), field).toBeGreaterThan(kind);
    }
  });

  it('only asks for a separate display name when the workspace identifier is opaque', () => {
    expect(CARD_SOURCE).toContain(
      "const needsDisplayName = chosenKind.id === 'genie-space' || chosenKind.id === 'sql-warehouse'"
    );
    expect(CARD_SOURCE).toMatch(/\{needsDisplayName \? \([\s\S]*Display name \(optional\)/);
  });

  /**
   * An empty catalog browser used to leave a titled panel and a dead Load more
   * action above the manual field. It now disappears from both visual and
   * accessibility order, while the short fallback line remains.
   */
  it('keeps manual entry secondary to user-scoped discovery', () => {
    expect(CARD_SOURCE).toContain("fetch('/api/browse/connection-types')");
    expect(CARD_SOURCE).toContain('Enter an identifier manually');
    expect(CARD_SOURCE).toMatch(/typeChoices\.length > 0 && !manual[\s\S]*<AssetPicker/);
    expect(CARD_SOURCE).toMatch(/\{manual \? \([\s\S]*plane-field ast-mono/);
  });

  it('associates the disabled Add reason with the button that needs it', () => {
    expect(CARD_SOURCE).toContain('aria-describedby={disabledReason ? `${formId}-add-reason` : undefined}');
    expect(CARD_SOURCE).toContain('id={`${formId}-add-reason`}');
    expect(CARD_SOURCE).toMatch(/!value\.trim\(\)[\s\S]*Choose a warehouse first/);
    expect(CARD_SOURCE).not.toMatch(/!id\.trim\(\)[\s\S]*Enter a connection key/);
  });

  /** Two kinds share the catalog chain, so the field ids must still be distinct. */
  it('gives each picker its own field id', () => {
    const fields = Object.values(ADD_CONNECTION_PICKERS).map((spec) => spec.field);
    expect(new Set(fields).size).toBe(fields.length);
  });

  /** Notebooks were hidden from this dropdown, and stay hidden. */
  it('offers no notebook browse here', () => {
    for (const spec of Object.values(ADD_CONNECTION_PICKERS)) {
      expect.soft(spec.levels, spec.field).not.toContain('notebooks');
    }
  });

  /**
   * The volumes list carries a leaf name, because the deployment's own volume
   * setting takes one. A declared connection takes the whole path, and a row
   * holding `checkpoints` alone names nothing that can be reached.
   */
  it('stores a volume as its whole path, not the leaf the list carried', () => {
    expect(addedConnectionValue('volume', 'checkpoints', { catalog: 'analytics', schema: 'player' })).toBe(
      '/Volumes/analytics/player/checkpoints'
    );
    expect(addedConnectionValue('volume', '/Volumes/analytics/player/checkpoints', {})).toBe(
      '/Volumes/analytics/player/checkpoints'
    );
    expect(addedConnectionValue('volume', 'checkpoints', {})).toBe('checkpoints');
  });

  it('stores every other kind exactly as the row offered it', () => {
    expect(addedConnectionValue('table', 'analytics.player.sessions', { catalog: 'analytics' })).toBe(
      'analytics.player.sessions'
    );
    expect(addedConnectionValue('genie-space', '01f19cd4502f1f6dbfb79bf6e63a1b2c')).toBe(
      '01f19cd4502f1f6dbfb79bf6e63a1b2c'
    );
  });

  /** Deriving a label from a minted id is what put hex on the row. */
  it('labels a pick with the name the list showed, never with a fragment of the id', () => {
    expect(addedConnectionLabel('01f19cd4502f1f6dbfb79bf6e63a1b2c', 'Player performance')).toBe('Player performance');
    expect(addedConnectionLabel('01f19cd4502f1f6dbfb79bf6e63a1b2c', '')).toBe('');
    expect(addedConnectionLabel('analytics.player.sessions', '')).toBe('sessions');
  });
});

/**
 * The row printed one string, and for anything picked from a list of Genie
 * spaces that string was the space's hex id. A row titled with a hex id has
 * named nothing.
 */
describe('how a listed asset reads on its row', () => {
  it('knows a minted id from a name', () => {
    expect(isOpaqueAssetId('01f19cd4502f1f6dbfb79bf6e63a1b2c')).toBe(true);
    expect(isOpaqueAssetId('<sql-warehouse-id>')).toBe(true);
    expect(isOpaqueAssetId('analytics.player.sessions')).toBe(false);
    expect(isOpaqueAssetId('Season roster')).toBe(false);
  });

  it('titles the row with the picked name and keeps the id beside it', () => {
    const row = connectionRowView({
      id: 'genie-space-01f1',
      kind: 'genie-space',
      label: 'Player performance',
      value: '01f19cd4502f1f6dbfb79bf6e63a1b2c',
    });
    expect(row.kindLabel).toBe('Genie space');
    expect(row.name).toBe('Player performance');
    expect(row.identifier).toBe('01f19cd4502f1f6dbfb79bf6e63a1b2c');
  });

  it('uses a readable identifier as the name rather than repeating it', () => {
    const row = connectionRowView({
      id: 'roster-table',
      kind: 'unity-catalog',
      label: '',
      value: 'gamesight_share_prod.analytics.title_roster',
    });
    expect(row.name).toBe('gamesight_share_prod.analytics.title_roster');
    expect(row.identifier).toBe('');
  });

  /** The rows in the screenshot: stored with the id as their label. */
  it('never titles a row with a hex id, and says what kind it is instead', () => {
    const row = connectionRowView({
      id: '01f19cd4502f1f6dbfb79bf6e63a1b2c',
      kind: 'genie-space',
      label: '01f19cd4502f1f6dbfb79bf6e63a1b2c',
      value: '01f19cd4502f1f6dbfb79bf6e63a1b2c',
    });
    expect(row.name).toBe('');
    expect(row.kindLabel).toBe('Genie space');
    expect(row.identifier).toMatch(/^01f19cd4502f\u2026$/);
    expect(row.fullIdentifier).toBe('01f19cd4502f1f6dbfb79bf6e63a1b2c');
  });

  it('names the kind of every row it can be handed', () => {
    for (const option of ADDABLE_KINDS) {
      const row = connectionRowView({ id: 'x', kind: option.kind, label: '', value: '' });
      expect.soft(row.kindLabel, option.kind).not.toBe('Connection');
    }
  });

  it('draws the kind and the name on the card, not the hex alone', () => {
    const markup = renderToStaticMarkup(
      <DeclaredConnectionsCard
        entries={[
          entry({
            id: 'genie-space-01f1',
            kind: 'genie-space',
            label: 'Player performance',
            value: '01f19cd4502f1f6dbfb79bf6e63a1b2c',
          }),
        ]}
        allowMutations
        onChanged={() => {}}
      />
    );
    expect(markup).toContain('Genie space');
    expect(markup).toContain('Player performance');
  });
});

describe('what this surface may not say', () => {
  const surfaces = [
    renderToStaticMarkup(<NotebookCard panel={panel()} />),
    renderToStaticMarkup(
      <NotebookCard
        panel={panel({
          comparison: [comparison({ verdict: 'refused', flow: 'refused' }), comparison({ verdict: 'pending' })],
        })}
      />
    ),
    renderToStaticMarkup(
      <DeclaredConnectionsCard entries={[entry(), entry({ id: 'gone', state: 'withdrawn' })]} onChanged={() => {}} />
    ),
  ];

  /** Stripped from nearly every surface of this app. */
  it('carries no em dash', () => {
    for (const markup of surfaces) {
      expect.soft(markup).not.toMatch(/—/);
    }
  });

  /**
   * Nothing anywhere a customer can see may claim the data is generated. There is
   * no field in the deployment that declares it and nothing reads one.
   */
  it('never claims the data is synthetic', () => {
    for (const markup of surfaces) {
      expect.soft(markup).not.toMatch(/synthetic|generated data|fictional|not real data/i);
    }
  });

  it('carries no copy from the view module with an em dash in it', () => {
    for (const text of [
      CONNECTION_SCOPE_NOTE,
      CONNECTION_LIST_TITLE,
      EMPTY_SCOPES_NOTE,
      EMPTY_SCOPES_LABEL,
      comparisonNote(comparison({ verdict: 'pending' })),
      comparisonNote(comparison({ verdict: 'refused', flow: 'refused' })),
      notebookSummary(undefined),
    ]) {
      expect.soft(text, text).not.toMatch(/—/);
    }
  });
});
