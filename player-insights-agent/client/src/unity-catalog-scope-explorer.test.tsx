import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  UnityCatalogScopeExplorer,
  toggledUnityCatalogSelection,
  unityCatalogExplorerValue,
  unityCatalogSelectionKey,
} from './UnityCatalogScopeExplorer';

const SOURCE = readFileSync(new URL('./UnityCatalogScopeExplorer.tsx', import.meta.url), 'utf8');

describe('the Unity Catalog scope explorer', () => {
  it('uses the shared body-level dialog with search and staged Save controls', () => {
    const markup = renderToStaticMarkup(
      <UnityCatalogScopeExplorer
        dialogId="scope-explorer"
        busy={false}
        declared={[]}
        scopeState={() => ({ label: 'Available', selectable: true })}
        onSave={() => Promise.resolve({ ok: true, detail: '' })}
        onClose={() => {}}
      />
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('id="scope-explorer"');
    expect(markup).toContain('Add Unity Catalog asset');
    expect(markup).toContain('aria-label="Close Add Unity Catalog asset"');
    expect(markup).toContain('placeholder="Search catalogs, schemas, and tables"');
    expect(markup).toContain('>Cancel<');
    expect(markup).toContain('>Save<');
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Save</);
    expect(markup).not.toMatch(/Search loaded results|Select catalog|Load more/);
    expect(SOURCE).toContain("import { Dialog } from './Dialog'");
  });

  it('keeps hierarchy expansion separate from staged selection', () => {
    expect(SOURCE).toContain('role="treeitem"');
    expect(SOURCE).toContain("role={kind === 'catalogs' ? 'tree' : 'group'}");
    expect(SOURCE).toContain('className="uc-explorer-expand"');
    expect(SOURCE).toContain('onClick={() => setExpanded((shown) => !shown)}');
    expect(SOURCE).toContain('role="checkbox"');
    expect(SOURCE).toContain('onClick={() => onToggle(selection)}');
    expect(SOURCE).not.toContain('onAdd(selection)');
  });

  it('selects and unselects by normalized logical identity without writing', () => {
    const selection = { resourceType: 'schema' as const, value: 'Main.<your profile>', label: '<your profile>' };
    const selected = toggledUnityCatalogSelection(new Map(), selection);
    expect(selected.has('schema:main.<your profile>')).toBe(true);
    expect(toggledUnityCatalogSelection(selected, selection).size).toBe(0);
    expect(unityCatalogSelectionKey(selection)).toBe('schema:main.<your profile>');
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

  it('writes only once from Save and preserves staged rows on failure', () => {
    expect(SOURCE).toContain('void onSave([...staged.values()])');
    expect(SOURCE).toContain('if (result.ok) return');
    expect(SOURCE).toContain('setError(result.detail)');
    expect(SOURCE).toContain('if (submitGate.current) return');
    expect(SOURCE).toContain('disabled={staged.size === 0 || submitting || busy}');
    expect(SOURCE).toContain('state.selectable');
    expect(SOURCE.match(/onSave\(/g)).toHaveLength(1);
    expect(SOURCE).not.toMatch(/onToggle[\s\S]{0,160}(fetch|onSave)/);
  });

  it('uses server-backed search and unions persisted declarations into both views', () => {
    expect(SOURCE).toContain('/api/browse/unity-catalog/search?q=');
    expect(SOURCE).toContain('inferredDeclaredItems(kind, cursor, declared)');
    expect(SOURCE).toContain('...declared.filter((item) => localSearchMatch(item.value, query))');
    expect(SOURCE).toContain('More results may be available. Refine the search.');
  });
});
