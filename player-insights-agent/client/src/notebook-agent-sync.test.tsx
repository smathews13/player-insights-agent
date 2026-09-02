import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { NO_EXPERIMENTS } from './experimental-features';
import { NotebookAgentSyncPane } from './NotebookAgentSyncPane';
import { ConnectionsPage } from './ConnectionsPage';
import { notebookAgentSyncTarget } from './notebook-agent-sync-deep-link';
import type { NotebookPanel } from './connection-model';

const panel: NotebookPanel = {
  location: 'catalog.schema.declarations',
  configuredPath: '/Workspace/Shared/agent',
  observedPath: '/Workspace/Shared/agent',
  read: { declaration: null, failure: null, detail: '' },
  comparison: [],
};

function renderPane(): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/connections']}>
      <Routes>
        <Route
          element={
            <Outlet
              context={{
                features: { ...NO_EXPERIMENTS, notebookAgentSync: true },
                setFeature: () => {},
                role: { state: 'admin', addedAdminsReadable: true },
                subject: 'admin@example.test',
              }}
            />
          }
        >
          <Route
            path="/connections"
            element={<NotebookAgentSyncPane notebook={panel} allowMutations onSaved={() => {}} onRefresh={() => {}} />}
          />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function renderConnections(path = '/connections'): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          element={
            <Outlet
              context={{
                features: NO_EXPERIMENTS,
                setFeature: () => {},
                role: { state: 'admin', addedAdminsReadable: true },
                subject: 'admin@example.test',
              }}
            />
          }
        >
          <Route path="/connections" element={<ConnectionsPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Notebook agent sync visibility', () => {
  it('keeps both complete panes behind one off-by-default lazy boundary', () => {
    const page = readFileSync(new URL('./ConnectionsPage.tsx', import.meta.url), 'utf8');
    expect(NO_EXPERIMENTS.notebookAgentSync).toBe(false);
    expect(page).toContain("lazy(() =>\n  import('./NotebookAgentSyncPane')");
    expect(page).toContain('notebookAgentSyncEnabled ? (');
    expect(page).not.toContain("from './NotebookCard'");
    expect(page).not.toContain("from './ApplyDeclarationCard'");
    expect(page).toContain('<Suspense fallback={null}>');
    const markup = renderConnections();
    expect(markup).not.toMatch(/notebook-agent-sync|Browse workspace notebooks|Apply → new model version/);
  });

  it('renders notebook selection and staged apply together when enabled', () => {
    const markup = renderPane();
    expect(markup).toContain('data-testid="notebook-agent-sync"');
    expect(markup).toContain('Browse workspace notebooks');
    expect(markup).toContain('Apply → new model version');
    expect(markup).not.toContain('experimental-pane-badge');
  });

  it('recognizes only links that target the gated panes', () => {
    expect(notebookAgentSyncTarget({ search: '?pane=notebook' })).toBe('notebook');
    expect(notebookAgentSyncTarget({ search: '?action=apply' })).toBe('apply');
    expect(notebookAgentSyncTarget({ hash: '#notebook-agent-sync-apply' })).toBe('apply');
    expect(notebookAgentSyncTarget({ search: '?entity=sql-warehouse' })).toBeNull();
    const page = readFileSync(new URL('./ConnectionsPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('Enable Notebook agent sync in Experimental settings');
    expect(page).not.toMatch(/setFeature\([^)]*notebookAgentSync/);
    expect(renderConnections('/connections?action=apply')).toContain(
      'Enable Notebook agent sync in Experimental settings'
    );
  });

  it('keeps all notebook and apply requests inside the lazy feature modules', () => {
    const page = readFileSync(new URL('./ConnectionsPage.tsx', import.meta.url), 'utf8');
    expect(page).not.toMatch(/api\/settings\/notebook-path|api\/settings\/apply|api\/admin\/model-releases/);
    const routes = readFileSync(new URL('../../server/routes/settings-routes.ts', import.meta.url), 'utf8');
    expect(routes).toContain("error: 'notebook_agent_sync_disabled'");
    expect(routes).toContain('...(notebookSync ? { notebook: await readNotebook');
  });
});
