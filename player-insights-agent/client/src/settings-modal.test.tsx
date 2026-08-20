import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { SettingsPage } from './SettingsPage';

function render(section: 'runtime' | 'appearance' | 'egress' = 'runtime') {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          element={
            <Outlet
              context={{
                features: { benchmarkLab: false, egressControls: true },
                setFeature: () => {},
                role: { state: 'admin', addedAdminsReadable: true },
              }}
            />
          }
        >
          <Route path="/" element={<SettingsPage initialSection={section} />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Settings modal', () => {
  it('is a centered modal overlay with the required shell and section rail', () => {
    const markup = render();
    expect(markup).toContain('data-testid="settings-modal-overlay"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('Admin only. Enforced on the server.');
    for (const label of ['Roles', 'Runtime', 'Appearance', 'Egress controls', 'Experimental']) {
      expect(markup).toContain(`>${label}</button>`);
    }
  });

  it('renders Runtime, Appearance and Egress as separate selected panes', () => {
    expect(render('runtime')).toContain('Live behavior for the next ask.');
    expect(render('appearance')).toContain('Answer entity colors, shared by Ask and Run Explorer.');
    expect(render('egress')).toContain('What can leave this deployment: downloads, copies, and outbound links.');
  });

  it('keeps one active-section Save in the modal footer', () => {
    for (const section of ['runtime', 'appearance', 'egress'] as const) {
      const markup = render(section);
      expect(markup.match(/>Save<\/button>/g) ?? []).toHaveLength(1);
      expect(markup).toContain('>Cancel</button>');
    }
  });

  it('uses the tab button for normal opens and home behind a deep link', () => {
    const layout = readFileSync(new URL('Layout.tsx', import.meta.url), 'utf8');
    const app = readFileSync(new URL('App.tsx', import.meta.url), 'utf8');
    expect(layout).toContain("entry.to === '/settings'");
    expect(layout).toContain('onSettingsOpen={() => setSettingsOpen(true)}');
    expect(app).toContain("path: '/settings', element: <AdminOnly><HomePage /></AdminOnly>");
    expect(app).not.toContain("path: '/settings', element: <AdminOnly><SettingsPage");
  });
});
