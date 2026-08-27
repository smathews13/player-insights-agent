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
const SETTINGS_STYLES = readFileSync(new URL('./styles/settings.css', import.meta.url), 'utf8');

function render(
  section: 'roles' | 'identity' | 'runtime' | 'environment' | 'appearance' | 'egress' | 'experimental' = 'runtime',
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
    for (const label of [
      'Roles',
      'Identity',
      'Runtime',
      'Environment',
      'Appearance',
      'Egress controls',
      'Experimental',
    ]) {
      expect(markup).toContain(`>${label}</button>`);
    }
    expect(markup).not.toContain('>Benchmarking</button>');
  });

  it('renders Runtime, Environment, Appearance and Egress as separate selected panes', () => {
    expect(render('runtime')).toContain('<h3>Runtime</h3>');
    expect(render('runtime')).toContain('Loop structure');
    expect(render('environment')).toContain('<h3>Environment</h3>');
    expect(render('appearance')).toContain('<h3>Appearance</h3>');
    expect(render('appearance')).toContain('aria-label="Dark"');
    expect(render('appearance')).toContain('Body text color');
    expect(render('appearance')).toContain('Secondary text color');
    expect(render('appearance')).toContain('aria-label="Font size L"');
    expect(render('appearance')).not.toContain('Quote colors');
    expect(render('egress')).toContain('<h3>Egress controls</h3>');
    expect(render('egress')).not.toContain('What can leave this deployment');
  });

  it('keeps Settings tab titles and drops the grey captions under them', () => {
    const roles = render('roles');
    const identity = render('identity');
    const runtime = render('runtime');
    const appearance = render('appearance');
    const experimental = render('experimental');
    expect(roles).toContain('<h3>Roles</h3>');
    expect(identity).toContain('<h3>Identity</h3>');
    expect(runtime).toContain('<h3>Runtime</h3>');
    expect(appearance).toContain('<h3>Appearance</h3>');
    expect(experimental).toContain('<h3>Experimental</h3>');
    expect(experimental).toContain('Benchmarking');
    for (const markup of [roles, identity, runtime, appearance, experimental]) {
      expect(markup).not.toContain('Who questions run as. Changes save immediately.');
      expect(markup).not.toContain('Identity and deployment roles. Changes save immediately.');
      expect(markup).not.toContain('Live behavior for the next ask.');
      expect(markup).not.toContain('Theme, type, and chip colours');
      expect(markup).not.toContain('Unfinished or internal surfaces, off by default.');
      expect(markup).not.toContain(
        'Shows the Benchmarking tab: evaluation dataset, Genie accuracy, then agent judges.'
      );
    }
  });

  it('puts the legacy-deployment tag repair on Experimental, not Environment', () => {
    const environment = render('environment');
    expect(environment).not.toContain('Astrolabe resource tags');
    expect(environment).not.toContain('Apply Astrolabe tags');

    const experimental = render('experimental');
    expect(experimental).toContain('Astrolabe resource tags');
    expect(experimental).toContain('system_billing=astrolabe');
    expect(experimental).toContain('Apply Astrolabe tags');
    expect(experimental).not.toContain('Astrolabe resource tags · Experimental');
    expect(experimental).not.toContain('retired');
  });

  it('lays Experimental features in a live Feature / Status / Control table', () => {
    const markup = render('experimental');
    expect(markup).toContain('>Feature</th>');
    expect(markup).toContain('>Status</th>');
    expect(markup).toContain('>Control</th>');
    expect(markup).toContain('PII egress judge');
    expect(markup).toContain('Shown');
    expect(markup).toContain('Idle');
    expect(markup).not.toContain('PII egress judge ·');
    expect(markup).not.toContain('SP identities ·');
    expect(markup).not.toContain('Benchmarking ·');
  });

  it('aligns every Experimental row through table cells and one control wrapper', () => {
    const markup = render('experimental');
    expect(markup.match(/class="exp-feature-status"/g) ?? []).toHaveLength(4);
    expect(markup.match(/class="exp-feature-control-inner"/g) ?? []).toHaveLength(4);
    expect(SETTINGS_STYLES).toMatch(
      /\.exp-feature-table th,\s*\.exp-feature-table td \{[^}]*border-bottom:\s*1px solid var\(--border\)/
    );
    expect(SETTINGS_STYLES).toMatch(/\.exp-feature-control-inner \{[^}]*display:\s*flex/);
    expect(SETTINGS_STYLES).toMatch(/\.exp-feature-control \{[^}]*text-align:\s*right/);
    expect(SETTINGS_STYLES).not.toMatch(/\.exp-feature-control \{[^}]*display:\s*(?:inline-)?flex/);
  });

  it('puts a small Experimental badge on each Experimental feature row, not the word in the title', () => {
    const markup = render('experimental');
    const badges = markup.split('experimental-pane-badge').length - 1;
    expect(badges).toBe(4);
    expect(markup).toContain('PII egress judge');
    expect(markup).toContain('SP identities');
    expect(markup).toContain('Astrolabe resource tags');
    expect(markup).toContain('Benchmarking');
    expect(markup).not.toContain('Astrolabe resource tags · Experimental');
  });

  it('puts personas on Identity, grayed until the deployment-wide SP identities pivot is on', () => {
    const off = render('identity');
    expect(off).toContain('data-testid="sp-identity-pane"');
    expect(off).toContain('Turn SP identities on under Experimental');
    expect(off).toContain('disabled=""');
    expect(off).not.toContain('type="password"');
    expect(off).not.toMatch(/secret value/i);
    expect(off).not.toContain('>Save</button>');

    const on = renderToStaticMarkup(
      <SettingsPage
        initialSection="identity"
        features={FEATURES}
        setFeature={() => {}}
        role={roleFrom(NORMAL_IDENTITY)}
        spIdentityEnabled={true}
      />
    );
    expect(on).not.toContain('Each named identity is a Databricks service principal');
    expect(on).not.toContain('People using the app do not pick a persona on Ask');
    expect(on).not.toContain('No personas yet.');
    expect(on).not.toContain('Who runs as which persona');
    expect(on).not.toContain('Administrators assign this');
    expect(on).not.toContain('never the secret itself');
    expect(on).not.toContain('Databricks Apps cannot mint a token for another service principal');
  });

  /**
   * THE MISMATCH Bugbot filed. The Experimental switch used to follow this
   * browser's localStorage while warehouse/Genie/agent calls followed
   * `sp-identity-enabled`. Clearing storage, or another admin turning it on,
   * left the switch Off and the Identity pane grayed while assigned people
   * already ran as service principals.
   */
  it('shows Off and a grayed Identity pane when this browser would have opted in but the server flag is off', () => {
    const experimental = renderToStaticMarkup(
      <SettingsPage
        initialSection="experimental"
        features={FEATURES}
        setFeature={() => {}}
        role={roleFrom(NORMAL_IDENTITY)}
        spIdentityEnabled={false}
      />
    );
    expect(experimental).toContain('SP identities');
    expect(experimental).toContain('Off');
    expect(experimental).not.toContain('data-testid="sp-identity-settings-link"');
    expect(experimental).not.toContain('the whole deployment');
    expect(experimental).not.toContain('go to Identity to assign');

    const identity = renderToStaticMarkup(
      <SettingsPage
        initialSection="identity"
        features={FEATURES}
        setFeature={() => {}}
        role={roleFrom(NORMAL_IDENTITY)}
        spIdentityEnabled={false}
      />
    );
    expect(identity).toContain('Turn SP identities on under Experimental');
    expect(identity).toContain('disabled=""');
  });

  it('shows On and a live Identity pane from the server flag, even when this browser never opted in', () => {
    const experimental = renderToStaticMarkup(
      <SettingsPage
        initialSection="experimental"
        features={FEATURES}
        setFeature={() => {}}
        role={roleFrom(NORMAL_IDENTITY)}
        spIdentityEnabled={true}
      />
    );
    expect(experimental).toContain('SP identities');
    expect(experimental).toContain('On');
    expect(experimental).toContain('data-testid="sp-identity-settings-link"');
    expect(experimental).not.toContain('once enabled');
    expect(experimental).not.toContain('go to Identity to assign');

    const identity = renderToStaticMarkup(
      <SettingsPage
        initialSection="identity"
        features={FEATURES}
        setFeature={() => {}}
        role={roleFrom(NORMAL_IDENTITY)}
        spIdentityEnabled={true}
      />
    );
    expect(identity).not.toContain('Turn SP identities on under Experimental');
    expect(identity).not.toContain('Each named identity is a Databricks service principal');
  });

  it('puts the SP-identities switch on Experimental next to the others', () => {
    const markup = render('experimental');
    expect(markup).toContain('aria-label="Run assigned people as their service principal"');
    expect(markup).not.toContain('People without an assignment still use OAuth');
  });

  it('opens the existing Identity pane from the Experimental SP row, only when On', () => {
    const source = readFileSync(new URL('SettingsPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('data-testid="sp-identity-settings-link"');
    expect(source).toContain("setActive('identity')");
    expect(source).not.toContain('once enabled');
    expect(source).not.toContain('go to Identity to assign');
  });

  it('puts PII egress, SP identities, and resource tags above the benchmarking Candidate cluster', () => {
    const markup = render('experimental');
    const pii = markup.indexOf('PII egress judge');
    const identities = markup.indexOf('SP identities');
    const tags = markup.indexOf('Astrolabe resource tags');
    const benchmarking = markup.indexOf('>Benchmarking<');
    const candidate = markup.indexOf('>Candidate<');
    expect(pii).toBeGreaterThan(-1);
    expect(identities).toBeGreaterThan(pii);
    expect(tags).toBeGreaterThan(identities);
    expect(benchmarking).toBeGreaterThan(tags);
    expect(candidate).toBeGreaterThan(benchmarking);
  });

  it('puts MLflow and bake-off controls on Experimental, disabled while Benchmarking is off', () => {
    const off = render('experimental');
    expect(off).toContain('MLflow experiment');
    expect(off).toContain('Always-on traces');
    expect(off).toContain('Judge model');
    expect(off).toContain('Baseline vs candidate');
    expect(off).not.toContain('Eval set');
    expect(off).toContain('disabled=""');
    expect(off).not.toContain('>Save</button>');

    const on = renderToStaticMarkup(
      <SettingsPage
        initialSection="experimental"
        features={{ benchmarkLab: true, egressControls: true }}
        setFeature={() => {}}
        role={roleFrom(NORMAL_IDENTITY)}
      />
    );
    expect(on).toContain('MLflow experiment');
    expect(on).toContain('>Save</button>');
    expect(on).not.toContain('>Benchmarking</button>');
  });

  it('keeps one active-section Save in the modal footer', () => {
    for (const section of ['runtime', 'appearance', 'egress'] as const) {
      const markup = render(section);
      expect(markup.match(/>Save<\/button>/g) ?? []).toHaveLength(1);
      expect(markup).toContain('>Cancel</button>');
    }
  });

  it('renders every pane without router outlet context', () => {
    for (const section of [
      'roles',
      'identity',
      'runtime',
      'environment',
      'appearance',
      'egress',
      'experimental',
    ] as const) {
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
