/**
 * What the Connections tab says about a notebook and a declared asset.
 *
 * The assertions that matter are about WORDING. This surface has to correct an
 * assumption a customer arrives with, and it has had narrative text stripped from
 * nearly every other surface, so the tests hold both: the scope sentence is present,
 * and nothing here is prose or carries an em dash.
 *
 * Every identifier is invented.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ADDABLE_KINDS,
  CONNECTION_LIST_TITLE,
  CONNECTION_SCOPE_NOTE,
  EMPTY_SCOPES_LABEL,
  EMPTY_SCOPES_NOTE,
  comparisonBadge,
  comparisonNote,
  connectionCounts,
  emptyScopesNote,
  notebookIsBlocked,
  notebookSummary,
  orderConnections,
} from './declared-connection-view';
import { NotebookCard } from './NotebookCard';
import { notebookPathView, persistNotebookPath } from './notebook-card-state';
import { DeclaredConnectionsCard } from './DeclaredConnectionsCard';
import { DECLARABLE_KEYS, DECLARABLE_KINDS } from '../../shared/notebook-declaration';
import type { ConnectionEntry, DeclarationComparisonRow, NotebookPanel } from './connection-model';

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
      Promise.resolve(new Response(JSON.stringify({ path: '/Shared/accepted' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    ) as unknown as typeof fetch;
    await expect(persistNotebookPath('/Shared/accepted', accepted)).resolves.toEqual({
      ok: true,
      path: '/Shared/accepted',
    });
    expect(accepted).toHaveBeenCalledWith(
      '/api/settings/notebook-path',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ path: '/Shared/accepted' }) }),
    );

    const denied = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ detail: 'Choose a notebook, not a workspace folder.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })),
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
  /**
   * The single most important string in the feature. A customer reads "added a
   * connection" as "granted access".
   */
  it('states that listing an asset is not permission to read it', () => {
    expect(CONNECTION_SCOPE_NOTE).toMatch(/Unity Catalog grants/);
    expect(CONNECTION_SCOPE_NOTE).toMatch(/consider/);
    const markup = renderToStaticMarkup(<DeclaredConnectionsCard entries={[entry()]} onChanged={() => {}} />);
    expect(markup).toContain('Unity Catalog grants');
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

  it('starts its extensible picker registry with tables, Genie spaces and catalogs', () => {
    expect(ADDABLE_KINDS.slice(0, 3).map((option) => option.label)).toEqual(['Tables', 'Genie spaces', 'Catalogs']);
    const markup = renderToStaticMarkup(<DeclaredConnectionsCard entries={[]} allowMutations onChanged={() => {}} />);
    expect(markup).toContain('+ Add a new connection');
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

  it('says nothing can be changed when the store is not answering', () => {
    const markup = renderToStaticMarkup(
      <DeclaredConnectionsCard entries={[entry()]} storeAvailable={false} onChanged={() => {}} />
    );
    expect(markup).toMatch(/not answering/);
  });

  it('draws the card with nothing in it rather than disappearing', () => {
    const markup = renderToStaticMarkup(<DeclaredConnectionsCard onChanged={() => {}} />);
    expect(markup).toContain(CONNECTION_LIST_TITLE);
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
