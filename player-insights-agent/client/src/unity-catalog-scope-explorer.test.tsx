import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UnityCatalogScopeExplorer, unityCatalogExplorerValue } from './UnityCatalogScopeExplorer';

const SOURCE = readFileSync(new URL('./UnityCatalogScopeExplorer.tsx', import.meta.url), 'utf8');

describe('the Unity Catalog scope explorer', () => {
  it('uses the shared body-level dialog with one close action and no confirm footer', () => {
    const markup = renderToStaticMarkup(
      <UnityCatalogScopeExplorer
        dialogId="scope-explorer"
        busy={false}
        scopeState={() => ({ label: 'Available', selectable: true })}
        onAdd={() => Promise.resolve({ ok: true, detail: '' })}
        onClose={() => {}}
      />
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('id="scope-explorer"');
    expect(markup).toContain('Add Unity Catalog asset');
    expect(markup).toContain('aria-label="Close Add Unity Catalog asset"');
    expect(markup).not.toMatch(/Search loaded results|Select catalog|Load more|>Cancel</);
    expect(SOURCE).toContain("import { Dialog } from './Dialog'");
  });

  it('keeps hierarchy expansion separate from immediate selection', () => {
    expect(SOURCE).toContain('role="treeitem"');
    expect(SOURCE).toContain("role={kind === 'catalogs' ? 'tree' : 'group'}");
    expect(SOURCE).toContain('className="uc-explorer-expand"');
    expect(SOURCE).toContain('onClick={() => setExpanded((shown) => !shown)}');
    expect(SOURCE).toContain('role="checkbox"');
    expect(SOURCE).toContain('void onAdd(selection).then((result) =>');
    expect(SOURCE.match(/onAdd\(selection\)/g)).toHaveLength(1);
  });

  it('derives each canonical resource value only from its hierarchy level', () => {
    expect(unityCatalogExplorerValue('catalog', 'analytics', '')).toBe('analytics');
    expect(unityCatalogExplorerValue('schema', 'player', 'analytics')).toBe('analytics.player');
    expect(unityCatalogExplorerValue('table', 'analytics.player.sessions', 'analytics')).toBe(
      'analytics.player.sessions'
    );
  });

  it('automatically advances bounded pages without exposing a manual paging action', () => {
    expect(SOURCE).toContain('while (!controller.signal.aborted)');
    expect(SOURCE).toContain('response.pagination.page >= response.pagination.page_limit');
    expect(SOURCE).toContain('seenTokens.has(nextToken)');
    expect(SOURCE).toContain('mergeBrowseItems(items, response.items)');
    expect(SOURCE).toContain('controller.abort()');
    expect(SOURCE).not.toContain('Load more');
  });

  it('shows row-local save and rollback feedback while preserving multi-add', () => {
    expect(SOURCE).toContain('setSaving(true)');
    expect(SOURCE).toContain('if (!result.ok) setError(result.detail)');
    expect(SOURCE).toContain('setSaving(false)');
    expect(SOURCE).toContain("saving ? 'Saving…' : state.label");
    expect(SOURCE).toContain('state.selectable');
    expect(SOURCE).not.toMatch(/onAdd\(selection\)[\s\S]{0,120}onClose/);
  });
});
