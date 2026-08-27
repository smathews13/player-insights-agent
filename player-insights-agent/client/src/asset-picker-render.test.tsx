import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { AssetPickerField, AssetPickerPanel, AssetPickerRow, BrowseGrantPrompt } from './AssetPicker';
import {
  BROWSE_GRANT_PROMPT,
  BROWSE_TYPE_INSTEAD,
  BROWSE_UNAVAILABLE_CHIP,
  NO_NAME_REPORTED,
  PICKER_FIELDS,
  PICKER_TOP,
  pickerForField,
  type AssetPickerSpec,
  type PickerCursor,
} from './asset-picker';
import { browseScopeUnavailableDetail } from '../../shared/browse-contract';
import type { BrowseItem, BrowseResponse } from '../../shared/browse-contract';
import { SINGLE_SCHEMA_LABEL, WHOLE_CATALOG_LABEL } from '../../shared/data-catalog-scope';

/**
 * The browsers as they are composed, rather than as their source reads.
 *
 * This repository has shipped screens that were wrong while every assertion about
 * their source was true, and the failures worth catching here are of exactly that
 * shape: a refusal rendered as an empty list, a Genie space row whose only label
 * is a uuid, and a `data_catalogs` catalog row that offers a whole-catalog grant
 * without saying so. All three are decisions the pure tests cover; all three can
 * also be lost on the way to the screen by a branch that never renders.
 *
 * `renderToStaticMarkup` runs no effects, which is why the panel is rendered with
 * its answer handed to it. `AssetPicker` itself fetches, so from there only the
 * loading state would ever compose.
 */

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, '\u2019')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

function item(over: Partial<BrowseItem> = {}): BrowseItem {
  return { id: '', label: '', secondary: '', expandable: false, ...over };
}

function spec(field: string): AssetPickerSpec {
  const found = pickerForField(field);
  if (!found) throw new Error(`no picker for ${field}`);
  return found;
}

function ok(items: BrowseItem[], over: Partial<Extract<BrowseResponse, { status: 'ok' }>> = {}) {
  return {
    status: 'ok' as const,
    kind: 'catalogs' as const,
    items,
    next_page_token: '',
    path: '',
    ...over,
  };
}

function panel(
  field: string,
  response: BrowseResponse | null,
  over: { cursor?: PickerCursor; current?: string; loading?: boolean; query?: string } = {}
) {
  return render(
    <AssetPickerPanel
      spec={spec(field)}
      cursor={over.cursor ?? PICKER_TOP}
      current={over.current ?? ''}
      response={response}
      loading={over.loading ?? false}
      query={over.query ?? ''}
      onQuery={() => {}}
      onOpen={() => {}}
      onPick={() => {}}
      onRetry={() => {}}
      onMore={() => {}}
    />
  );
}

describe('a list the workspace answered', () => {
  it('draws a row per asset, under a heading naming whose visibility it is', () => {
    const markup = panel('catalog', ok([item({ id: 'analytics', label: 'analytics' })]));
    expect(markup).toContain('data-testid="asset-picker-catalog"');
    expect(text(markup)).toContain('Catalogs your sign-in can see');
    expect(text(markup)).toContain('analytics');
  });

  /**
   * NEVER A BARE ID AS THE ONLY LABEL. This is the whole reason a Genie space
   * picker is worth building: the operator recognises the title and the setting
   * stores an opaque id, so the row has to carry both.
   */
  it('shows a Genie space by title with its id beside it', () => {
    const markup = panel('genie-data', ok([item({ id: '01ef9a2b', label: 'Player data' })], { kind: 'genie-spaces' }));
    const shown = text(markup);
    expect(shown).toContain('Player data');
    expect(shown).toContain('01ef9a2b');
  });

  it('says a warehouse name was not reported rather than dressing the id as one', () => {
    const markup = panel(
      'sql-warehouse',
      ok([item({ id: 'abc123', label: 'abc123', secondary: 'RUNNING' })], { kind: 'warehouses' })
    );
    const shown = text(markup);
    expect(shown).toContain('abc123');
    expect(shown).toContain(NO_NAME_REPORTED);
    expect(shown).toContain('RUNNING');
  });

  it('names an endpoint and reports the task it serves', () => {
    const markup = panel(
      'llm-endpoint',
      ok([item({ id: 'databricks-claude-sonnet', label: 'databricks-claude-sonnet', secondary: 'llm/v1/chat' })], {
        kind: 'serving-endpoints',
      })
    );
    expect(text(markup)).toContain('databricks-claude-sonnet');
    expect(text(markup)).toContain('llm/v1/chat');
  });

  it('offers the way back out of a catalog it opened inside', () => {
    const markup = panel('notebook-declaration', ok([], { kind: 'tables' }), {
      cursor: { catalog: 'analytics', schema: 'player' },
    });
    const shown = text(markup);
    expect(shown).toContain('All catalogs');
    expect(shown).toContain('analytics.player');
  });

  it('rests the button on a row the field already holds', () => {
    const markup = render(
      <AssetPickerRow
        spec={spec('catalog-allowlist')}
        cursor={PICKER_TOP}
        item={item({ id: 'analytics', label: 'analytics' })}
        current="analytics"
        onOpen={() => {}}
        onPick={() => {}}
      />
    );
    expect(markup).toContain('disabled');
  });
});

describe('the data_catalogs browser and its blast radius', () => {
  /**
   * A bare catalog name grants every non-system schema in it. A two-part name
   * grants one. A picker that lets a reader choose between them without saying
   * which is which is the reason a customer ends up unsure what they opened up.
   */
  it('offers a catalog as a whole-catalog scope, and says what that covers', () => {
    const markup = panel('catalog-allowlist', ok([item({ id: 'analytics', label: 'analytics' })]));
    const shown = text(markup);
    expect(shown).toContain('Whole catalog');
    expect(shown).toContain(WHOLE_CATALOG_LABEL);
    // And the door into it, so the narrower pick stays reachable.
    expect(shown).toContain('Open');
  });

  it('offers a schema as this schema only, and says so', () => {
    const markup = panel(
      'catalog-allowlist',
      ok([item({ id: 'player', label: 'player', secondary: 'analytics.player' })], { kind: 'schemas' }),
      { cursor: { catalog: 'analytics', schema: '' } }
    );
    const shown = text(markup);
    expect(shown).toContain('This schema');
    expect(shown).toContain(SINGLE_SCHEMA_LABEL);
    expect(shown).toContain('analytics.player');
  });
});

describe('browsing is unavailable', () => {
  const unavailable: BrowseResponse = {
    status: 'unavailable',
    kind: 'catalogs',
    reason: 'scope_not_carried',
    scope: 'catalog.catalogs:read',
    detail: browseScopeUnavailableDetail('catalog.catalogs:read'),
  };

  /**
   * THE ONE OUTCOME THAT MUST NOT LOOK LIKE THE OTHER TWO. A refusal established
   * nothing about which assets exist, so it may not render as an empty list, and
   * it may not render as a fault either: these scopes are optional and no ask
   * needs them.
   */
  it('offers the permission instead of drawing an empty list', () => {
    const markup = panel('catalog', unavailable);
    const shown = text(markup);
    expect(markup).toContain('data-testid="asset-picker-grant"');
    expect(shown).toContain(BROWSE_GRANT_PROMPT);
    expect(shown).toContain('catalog.catalogs:read');
    // Not the empty-list wording, which would be a claim about the workspace.
    expect(markup).not.toContain('data-testid="asset-picker-empty"');
    expect(shown).not.toMatch(/visible to your sign-in/);
  });

  it('keeps the fallback reachable and says nothing was established', () => {
    expect(text(panel('catalog', unavailable))).toContain(BROWSE_TYPE_INSTEAD);
  });

  it('takes the neutral pill, not the red one a required shortfall gets', () => {
    const markup = panel('catalog', unavailable);
    expect(markup).toContain('ast-pill--neutral');
    expect(markup).not.toContain('ast-pill--neg');
    expect(text(markup)).toContain(BROWSE_UNAVAILABLE_CHIP);
    expect(text(markup)).not.toMatch(/\bMissing\b/);
  });

  it('carries the sentence the server sent rather than a second wording of it', () => {
    const markup = render(
      <BrowseGrantPrompt
        scope="workspace.workspace:read"
        detail={browseScopeUnavailableDetail('workspace.workspace:read')}
      />
    );
    expect(text(markup)).toContain('does not carry');
    expect(text(markup)).toContain('workspace.workspace:read');
  });

  it('offers no retry, because a second attempt changes nothing', () => {
    expect(panel('catalog', unavailable)).not.toContain('Try again');
  });
});

describe('a list that could not be read', () => {
  const failed: BrowseResponse = {
    status: 'failed',
    kind: 'warehouses',
    detail: 'The workspace did not answer in time, so nothing about this list was established.',
    error: 'timeout',
  };

  it('reports the failure and offers a retry, which a refusal does not', () => {
    const markup = panel('sql-warehouse', failed);
    expect(markup).toContain('data-testid="asset-picker-failed"');
    expect(text(markup)).toContain('did not answer in time');
    expect(text(markup)).toContain('Try again');
  });

  it('does not offer a permission, because none was implicated', () => {
    const markup = panel('sql-warehouse', failed);
    expect(markup).not.toContain('data-testid="asset-picker-grant"');
    expect(text(markup)).not.toContain(BROWSE_GRANT_PROMPT);
  });

  it('keeps the typed fallback', () => {
    expect(text(panel('sql-warehouse', failed))).toContain(BROWSE_TYPE_INSTEAD);
  });
});

describe('an empty answer', () => {
  it('says the workspace answered, and does not read as a refusal', () => {
    const markup = panel('sql-warehouse', ok([], { kind: 'warehouses' }));
    const shown = text(markup);
    expect(markup).toContain('data-testid="asset-picker-empty"');
    expect(shown).toContain('No SQL warehouses are visible to your sign-in.');
    expect(markup).not.toContain('data-testid="asset-picker-grant"');
    expect(shown).not.toContain(BROWSE_GRANT_PROMPT);
  });

  it('draws no filter box over a list with nothing in it', () => {
    expect(panel('sql-warehouse', ok([], { kind: 'warehouses' }))).not.toContain('Narrow this list');
  });
});

describe('long lists', () => {
  const many = Array.from({ length: 3 }, (_, index) => item({ id: `analytics.player.t${index}`, label: `t${index}` }));

  it('offers a filter over a list with rows in it', () => {
    expect(panel('notebook-declaration', ok(many, { kind: 'tables' }))).toContain('Narrow this list');
  });

  it('says when the filter hid everything, rather than looking like an empty workspace', () => {
    const markup = panel('notebook-declaration', ok(many, { kind: 'tables' }), { query: 'zzz' });
    const shown = text(markup);
    expect(shown).toContain('Nothing in this list matches what you typed.');
    expect(shown).not.toMatch(/visible to your sign-in/);
  });

  it('offers another page only where the workspace said there is one', () => {
    expect(text(panel('catalog', ok(many, { next_page_token: 'tok' })))).toContain('Load more');
    expect(text(panel('catalog', ok(many)))).not.toContain('Load more');
  });
});

describe('what an editor puts on screen for a field', () => {
  /**
   * Both editors on the Connections page go through this one component, so this
   * is where "the pencil opens a browser rather than only a text box" is
   * decidable from markup. A static render runs no effects, so the browser
   * composes in its pending state, which is exactly what a reader sees for the
   * first moment after the pencil.
   */
  function field(id: string) {
    return render(<AssetPickerField field={id} current="" onPick={() => {}} />);
  }

  it('opens a browser for every field with a list behind it', () => {
    for (const id of PICKER_FIELDS) {
      expect(field(id), id).toContain(`data-testid="asset-picker-${id}"`);
    }
  });

  it('draws nothing for a field with no list behind it', () => {
    // The text box is the whole editor for these, which is honest: a browser
    // over a routing mode or a number would imply a list exists.
    expect(field('llm-gateway')).toBe('');
    expect(field('max-output-tokens')).toBe('');
  });

  it('lets the denylist type box name a pattern', () => {
    expect(text(field('catalog-denylist'))).toContain('Or type a table name or a pattern');
    expect(text(field('catalog-allowlist'))).not.toContain('may be a pattern');
  });

  /**
   * The text box under the browser has to say what it takes.
   *
   * The editors label the input `New value for <label>`, which was enough while
   * typing was the only route in. It is not enough now: the box is the fallback
   * for a sign-in that cannot browse, and on the table fields the shape of the
   * value is the difference between something this app can read and something it
   * cannot. The label is spec copy, so it is asserted against the spec rather
   * than against a second copy of the words.
   */
  it('names what the text box beside each browser takes', () => {
    for (const id of PICKER_FIELDS) {
      const spec = pickerForField(id);
      expect(spec, id).not.toBeNull();
      expect(text(field(id)), id).toContain(spec?.typeLabel);
    }
    expect(text(field('notebook-declaration'))).toContain('three-part table name');
    expect(text(field('sql-warehouse'))).toContain('warehouse id');
  });
});

describe('the copy on screen', () => {
  it('uses no em dash', () => {
    const screens = [
      panel('catalog-allowlist', ok([item({ id: 'analytics', label: 'analytics' })])),
      panel('catalog', {
        status: 'unavailable',
        kind: 'catalogs',
        reason: 'scope_not_carried',
        scope: 'catalog.catalogs:read',
        detail: browseScopeUnavailableDetail('catalog.catalogs:read'),
      }),
      panel('sql-warehouse', ok([], { kind: 'warehouses' })),
    ];
    for (const screen of screens) {
      expect(text(screen)).not.toMatch(/—|–/);
    }
  });
});
