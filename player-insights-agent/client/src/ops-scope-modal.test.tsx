import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ComponentProps } from 'react';
import { CheckScopesButton, OpsScopeModal } from './OpsScopeModal';

const SOURCE = readFileSync(new URL('./OpsScopeModal.tsx', import.meta.url), 'utf8');
const DIALOG_SOURCE = readFileSync(new URL('./Dialog.tsx', import.meta.url), 'utf8');
const STYLES = readFileSync(new URL('./styles/ops.css', import.meta.url), 'utf8');
const RESPONSIVE = readFileSync(new URL('./styles/responsive-ops.css', import.meta.url), 'utf8');
const DENSITY = readFileSync(new URL('./styles/density-ops.css', import.meta.url), 'utf8');

function props(overrides: Partial<ComponentProps<typeof OpsScopeModal>> = {}): ComponentProps<typeof OpsScopeModal> {
  return {
    rows: [
      { asset: 'main', type: 'Catalog', userScope: 'in', appScope: 'out' },
      { asset: 'main.analytics.events', type: 'Table', userScope: 'out', appScope: 'in' },
    ],
    page: {
      checkedAt: '2026-09-03T20:00:00.000Z',
      user: { label: 'Signed-in user', provenance: 'obo', availability: 'available' },
      app: { label: 'App service principal', provenance: 'app-service-principal', availability: 'available' },
      assets: [],
      nextCursor: 'opaque-cursor',
      moreResults: true,
      capped: false,
    },
    search: '',
    filter: 'all',
    busy: false,
    loadingMore: false,
    failure: '',
    onSearch: () => {},
    onFilter: () => {},
    onMore: () => {},
    onRetry: () => {},
    onClose: () => {},
    ...overrides,
  };
}

describe('the Ops catalog scope modal', () => {
  it('renders a body-level read-only comparison and cursor pagination', () => {
    const markup = renderToStaticMarkup(<OpsScopeModal {...props()} />);
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
    expect(markup).toContain('More results');
    expect(markup).not.toMatch(/Reachable|Not checked|Partial/);
    expect(markup).toContain('This does not grant access.');
    expect(DIALOG_SOURCE).toContain('createPortal(');
    expect(DIALOG_SOURCE).toContain('paddingRight');
    const capped = renderToStaticMarkup(
      <OpsScopeModal
        {...props({
          page: { ...props().page!, nextCursor: null, moreResults: true, capped: true },
        })}
      />
    );
    expect(capped).toContain('More results exist. Narrow the search or type to continue.');
  });

  it('keeps a table shell, compact loader, and close control during the first page', () => {
    const markup = renderToStaticMarkup(<OpsScopeModal {...props({ rows: [], page: null, busy: true })} />);
    expect(markup).toContain('ops-scope-skeleton-row');
    expect(markup).toContain('Checking…');
    expect(markup).toContain('Close Catalog scopes');
    expect(markup).not.toContain('No matching catalog assets.');
    expect(STYLES).toMatch(/\.ops-scope-skeleton-row td\s*\{[^}]*height:/);
    expect(STYLES).toMatch(/\.ops-scope-table-scroll\s*\{[^}]*scrollbar-gutter:\s*stable both-edges/);
  });

  it('shows one-principal failure without hiding completed rows', () => {
    const page = props().page!;
    const markup = renderToStaticMarkup(
      <OpsScopeModal
        {...props({
          page: { ...page, app: { ...page.app, availability: 'unavailable' } },
          rows: [{ asset: 'main', type: 'Catalog', userScope: 'in', appScope: 'unavailable' }],
        })}
      />
    );
    expect(markup).toContain('App service principal — unavailable; retry');
    expect(markup).toContain('Unavailable');
    expect(markup).toContain('Retry unavailable');
    expect(markup).toContain('main');
    expect(markup).not.toContain('No matching catalog assets.');
  });

  it('has server-backed search/type hooks, cancellation, retry, and bounded timeout', () => {
    expect(SOURCE).toContain("params.set('q'");
    expect(SOURCE).toContain("new URLSearchParams({ limit: '50', type:");
    expect(SOURCE).toContain('controllerRef.current?.abort()');
    expect(SOURCE).toContain('CLIENT_TIMEOUT_MS = 12_000');
    const failure = renderToStaticMarkup(
      <OpsScopeModal {...props({ rows: [], page: null, failure: 'The page timed out.' })} />
    );
    expect(failure).toContain('Retry');
    expect(failure).toContain('The page timed out.');
  });

  it('keeps button geometry stable and supports dark/light, density, and responsive layouts', () => {
    const idle = renderToStaticMarkup(<CheckScopesButton busy={false} onClick={() => {}} />);
    const busy = renderToStaticMarkup(<CheckScopesButton busy onClick={() => {}} />);
    expect(idle).toContain('Check scopes');
    expect(busy).toContain('Checking…');
    expect(busy).toContain('ast-flick-slot--button');
    expect(STYLES).toMatch(/\.ops-scope-check-button\s*\{[^}]*width:\s*112px[^}]*min-width:\s*112px/);
    expect(STYLES).toMatch(/\.ops-scope-status\[data-scope-status='in'\][^]*var\(--ast-pos-text\)/);
    expect(STYLES).toMatch(/\.ops-scope-status\[data-scope-status='out'\][^]*var\(--ast-neg-text\)/);
    expect(STYLES).toContain("data-scope-status='unavailable'");
    expect(STYLES).toContain('var(--card)');
    expect(DENSITY).toContain('.ops-scope-skeleton-row td');
    expect(RESPONSIVE).toContain('.ops-scope-filters');
  });
});
