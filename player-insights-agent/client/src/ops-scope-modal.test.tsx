import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OpsScopeModal } from './OpsScopeModal';

const SOURCE = readFileSync(new URL('./OpsScopeModal.tsx', import.meta.url), 'utf8');
const STYLES = readFileSync(new URL('./styles/ops.css', import.meta.url), 'utf8');

describe('the Ops catalog scope modal', () => {
  it('renders a body-level read-only comparison with exact scope states', () => {
    const markup = renderToStaticMarkup(
      <OpsScopeModal
        payload={{
          checkedAt: '2026-09-03T20:00:00.000Z',
          user: { label: 'Signed-in user', provenance: 'obo' },
          app: { label: 'App service principal', provenance: 'app-service-principal' },
          assets: [
            { asset: 'main', type: 'Catalog', userScope: 'in', appScope: 'out' },
            { asset: 'main.analytics.events', type: 'Table', userScope: 'out', appScope: 'in' },
          ],
        }}
        onClose={() => {}}
      />
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('Asset');
    expect(markup).toContain('Type');
    expect(markup).toContain('User scope');
    expect(markup).toContain('App scope');
    expect(markup).toContain('Signed-in user (OBO)');
    expect(markup).toContain('App service principal');
    expect(markup).toContain('In scope');
    expect(markup).toContain('Out of scope');
    expect(markup).not.toMatch(/Reachable|Not checked/);
    expect(markup).toContain('This does not grant access.');
    expect(SOURCE).toContain("import { Dialog } from './Dialog'");
  });

  it('is searchable, paginated, and uses semantic green/red status styles', () => {
    expect(SOURCE).toContain('Search catalog scopes');
    expect(SOURCE).toContain('PAGE_SIZE = 50');
    expect(SOURCE).toContain('Previous');
    expect(SOURCE).toContain('Next');
    expect(STYLES).toMatch(/\.ops-scope-status\[data-scope-status='in'\][^]*var\(--ast-pos-text\)/);
    expect(STYLES).toMatch(/\.ops-scope-status\[data-scope-status='out'\][^]*var\(--ast-neg-text\)/);
  });
});
