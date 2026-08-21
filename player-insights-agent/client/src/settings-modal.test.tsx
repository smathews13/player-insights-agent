import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { roleFrom } from './role';

const NORMAL_IDENTITY = { signedInAs: '<your-username>', role: 'admin' };

function render(
  section: 'roles' | 'runtime' | 'environment' | 'appearance' | 'egress' | 'experimental' = 'runtime',
  identity: Parameters<typeof roleFrom>[0] = NORMAL_IDENTITY
) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          element={
            <Outlet
              context={{
                features: { benchmarkLab: false, egressControls: true },
                setFeature: () => {},
                role: roleFrom(identity),
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
    // The header is the word Settings and the close button. It used to lecture
    // ("Admin only. Enforced on the server.") under its own title; the roles and
    // the server enforce that, and neither needs announcing.
    expect(markup).not.toContain('Admin only');
    expect(markup).not.toContain('Enforced on the server');
    for (const label of ['Roles', 'Runtime', 'Environment', 'Appearance', 'Egress controls', 'Experimental']) {
      expect(markup).toContain(`>${label}</button>`);
    }
  });

  it('renders Runtime, Environment, Appearance and Egress as separate selected panes', () => {
    expect(render('runtime')).toContain('Live behavior for the next ask.');
    expect(render('environment')).toContain('<h3>Environment</h3>');
    expect(render('appearance')).toContain('Answer entity colors, shared by Ask and Run Explorer.');
    expect(render('egress')).toContain('What can leave this deployment: downloads, copies, and outbound links.');
  });

  it('puts the legacy-deployment tag repair under Experimental', () => {
    const markup = render('experimental');
    expect(markup).toContain('Astrolabe resource tags');
    expect(markup).toContain('astrolabe=true');
    expect(markup).toContain('>Apply Astrolabe tags</button>');
    expect(markup).not.toContain('Admin only');
  });

  it('keeps one active-section Save in the modal footer', () => {
    for (const section of ['runtime', 'appearance', 'egress'] as const) {
      const markup = render(section);
      expect(markup.match(/>Save<\/button>/g) ?? []).toHaveLength(1);
      expect(markup).toContain('>Cancel</button>');
    }
  });

  it('renders a sane Roles pane with null, missing and normal identity payloads', () => {
    for (const identity of [null, {}, NORMAL_IDENTITY]) {
      const markup = render('roles', identity);
      expect(markup).toContain('data-testid="settings-modal-overlay"');
      expect(markup).toContain('<h3>Roles</h3>');
      expect(markup).not.toContain('This view could not be displayed');
    }
  });

  it('keeps Settings behind the gear and opens a pasted deep link as the modal', () => {
    const layout = readFileSync(new URL('Layout.tsx', import.meta.url), 'utf8');
    const app = readFileSync(new URL('App.tsx', import.meta.url), 'utf8');
    expect(layout).not.toContain("entry.to === '/settings'");
    expect(layout).toContain('aria-label="App settings"');
    expect(layout).toContain('onClick={() => setSettingsOpen(true)}');
    expect(layout).toContain("const settingsDeepLink = location.pathname === '/settings'");
    expect(app).toContain("path: '/settings', element: <AdminOnly><HomePage /></AdminOnly>");
    expect(app).not.toContain("path: '/settings', element: <AdminOnly><SettingsPage");
  });
});
