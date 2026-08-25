import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { identityFromResponse } from './app-state';
import { AdminOnly } from './GatePanel';
import { SettingsPage, SettingsPaneBoundary } from './SettingsPage';
import { roleFrom, type RoleResolution } from './role';

const NORMAL_IDENTITY = { signedInAs: '<your-username>', role: 'admin' };
const FEATURES = { benchmarkLab: false, egressControls: true };

function render(
  section: 'roles' | 'runtime' | 'environment' | 'appearance' | 'egress' | 'experimental' = 'runtime',
  role: RoleResolution = roleFrom(NORMAL_IDENTITY)
) {
  return renderToStaticMarkup(
    <SettingsPage initialSection={section} features={FEATURES} setFeature={() => {}} role={role} />
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
    expect(render('appearance')).toContain('aria-label="Dark"');
    expect(render('appearance')).not.toContain('Quote colors');
    expect(render('egress')).toContain('What can leave this deployment: downloads, copies, and outbound links.');
  });

  it('puts the legacy-deployment tag repair under Experimental', () => {
    const markup = render('experimental');
    expect(markup).toContain('Astrolabe resource tags');
    expect(markup).toContain('system_billing=astrolabe');
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

  it('renders every pane without router outlet context', () => {
    for (const section of ['roles', 'runtime', 'environment', 'appearance', 'egress', 'experimental'] as const) {
      const markup = render(section);
      expect(markup).toContain('data-testid="settings-modal-overlay"');
      expect(markup).not.toContain('This view could not be displayed');
    }
  });

  it('renders Roles for null, undefined, refused, failed, missing-role and service-principal identities', () => {
    const hostileIdentities: unknown[] = [
      null,
      undefined,
      {}, // empty JSON
      { status: 401 },
      { status: 403 },
      { status: 500 },
      { signedInAs: '<your-username>' }, // missing role
      {
        signedInAs: 'service-principal',
        executionIdentity: 'Astrolabe service principal',
        executionMode: 'service-principal',
      },
    ];
    for (const identity of hostileIdentities) {
      const markup = render('roles', roleFrom(identityFromResponse(identity)));
      expect(markup).toContain('<h3>Roles</h3>');
      expect(markup).not.toContain('This view could not be displayed');
    }
  });

  it('falls back inside one pane instead of replacing the whole view', () => {
    const boundary = new SettingsPaneBoundary({ section: 'environment', children: <div>unreachable</div> });
    boundary.state = SettingsPaneBoundary.getDerivedStateFromError();
    const markup = renderToStaticMarkup(<>{boundary.render()}</>);
    expect(markup).toContain('<h3>Environment</h3>');
    expect(markup).toContain('other Settings sections are still available');
    expect(markup).not.toContain('This view could not be displayed');
  });

  /**
   * The crash Sam kept seeing, reproduced where it actually happens.
   *
   * Every test above renders `SettingsPage` on its own with a role handed to it,
   * which is not how the app mounts it. The layout wraps it in `AdminOnly` and
   * draws it as a SIBLING of `<Outlet />`, so `useOutletContext` -- a context
   * whose default value is null -- answers null there. Reading `.role` off that
   * threw in the layout itself, above the per-pane boundary inside Settings, so
   * the route boundary replaced the whole application with "This view could not
   * be displayed". That is why the pane boundary did not help.
   */
  function renderAsLayoutDoes(role: RoleResolution | null) {
    return renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <div>
                {/* The outlet the pages get... */}
                <Outlet context={{ features: FEATURES, setFeature: () => {}, role }} />
                {/* ...and the modal, which is not inside it. */}
                <AdminOnly role={role ?? undefined}>
                  <SettingsPage features={FEATURES} setFeature={() => {}} role={role} />
                </AdminOnly>
              </div>
            }
          >
            <Route index element={<p>ask</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
  }

  it('opens the gear from the layout, outside the outlet, without taking the app down', () => {
    for (const state of ['admin', 'super_admin'] as const) {
      const markup = renderAsLayoutDoes({ state, addedAdminsReadable: true });
      expect(markup).toContain('data-testid="settings-modal-overlay"');
      expect(markup).toContain('<h2 id="settings-title">Settings</h2>');
    }
  });

  it('does not throw when the role it is handed is null, undefined or unresolved', () => {
    for (const role of [null, undefined, { state: 'resolving', addedAdminsReadable: true }] as const) {
      expect(() => renderAsLayoutDoes(role ?? null)).not.toThrow();
    }
  });

  it('survives null features and a null role reaching the page itself', () => {
    for (const features of [null, undefined] as const) {
      for (const role of [null, undefined] as const) {
        const markup = renderToStaticMarkup(<SettingsPage features={features} role={role} />);
        expect(markup).toContain('data-testid="settings-modal-overlay"');
        expect(markup).not.toContain('This view could not be displayed');
      }
    }
  });

  it('reads the role from the outlet when it is given one and is inside it', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={<Outlet context={{ features: FEATURES, setFeature: () => {}, role: roleFrom(NORMAL_IDENTITY) }} />}
          >
            <Route
              index
              element={
                <AdminOnly>
                  <p>admin body</p>
                </AdminOnly>
              }
            />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(markup).toContain('admin body');
  });

  it('keeps Settings behind the gear and opens a pasted deep link as the modal', () => {
    const layout = readFileSync(new URL('Layout.tsx', import.meta.url), 'utf8');
    const app = readFileSync(new URL('App.tsx', import.meta.url), 'utf8');
    expect(layout).not.toContain("entry.to === '/settings'");
    expect(layout).toContain('aria-label="App settings"');
    expect(layout).toContain('onClick={() => setSettingsOpen(true)}');
    expect(layout).toContain("const settingsDeepLink = location.pathname === '/settings'");
    const settingsRoute = app.slice(app.indexOf("path: '/settings'"), app.indexOf("path: '/connections'"));
    expect(settingsRoute).toContain('<AdminOnly>');
    expect(settingsRoute).toContain('<HomePage />');
    expect(settingsRoute).not.toContain('<SettingsPage');
    // The gate outside the outlet must be handed a role rather than reading one.
    expect(layout).toContain('<AdminOnly role={role}>');
  });
});
