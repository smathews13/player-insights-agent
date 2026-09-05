import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { identityFromResponse } from './app-state';
import { AdminOnly } from './GatePanel';
import { SettingsPage, SettingsPaneBoundary } from './SettingsPage';
import { roleFrom, type RoleResolution } from './role';

const NORMAL_IDENTITY = { signedInAs: '<your-username>', role: 'admin' };
const FEATURES = { benchmarkLab: false, egressControls: true, forecasting: false, notebookAgentSync: false };
const SETTINGS_STYLES = readFileSync(new URL('./styles/settings.css', import.meta.url), 'utf8');
const SETTINGS_RESPONSIVE_STYLES = readFileSync(new URL('./styles/responsive-settings.css', import.meta.url), 'utf8');
const SETTINGS_DENSITY_STYLES = readFileSync(new URL('./styles/density-settings.css', import.meta.url), 'utf8');
const SETTINGS_SECTIONS_SOURCE = readFileSync(new URL('./settings-sections.ts', import.meta.url), 'utf8');

function render(
  section: 'identity' | 'runtime' | 'environment' | 'appearance' | 'egress' | 'experimental' = 'runtime',
  role: RoleResolution = roleFrom(NORMAL_IDENTITY),
  initialAccessGuideAvailable?: boolean
) {
  return renderToStaticMarkup(
    <SettingsPage
      initialSection={section}
      features={FEATURES}
      setFeature={() => {}}
      role={role}
      initialAccessGuideAvailable={initialAccessGuideAvailable}
    />
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
    for (const label of ['Identity', 'Runtime', 'Environment', 'Appearance', 'Egress controls', 'Experimental']) {
      expect(markup).toContain(`>${label}</span>`);
    }
    expect(markup).not.toContain('>Roles</button>');
    expect(markup).not.toContain('>Benchmarking</button>');
  });

  it('renders each typed Settings icon before its visible tab label', () => {
    const markup = render();
    const nav = markup.slice(
      markup.indexOf('<nav class="settings-rail"'),
      markup.indexOf('</nav>', markup.indexOf('<nav class="settings-rail"'))
    );
    const buttons = nav.match(/<button[\s\S]*?<\/button>/g) ?? [];
    const tabs = [
      ['identity', 'lucide-badge-check', 'Identity'],
      ['runtime', 'lucide-gauge', 'Runtime'],
      ['environment', 'lucide-server-cog', 'Environment'],
      ['appearance', 'lucide-palette', 'Appearance'],
      ['egress', 'lucide-network', 'Egress controls'],
      ['experimental', 'lucide-flask-conical', 'Experimental'],
    ] as const;

    expect(buttons).toHaveLength(tabs.length);
    tabs.forEach(([section, iconClass, label], index) => {
      const button = buttons[index] ?? '';
      expect(button, label).toContain(iconClass);
      expect(button, label).toContain(`settings-section-icon--${section}`);
      expect(button, label).toContain('aria-hidden="true"');
      expect(button, label).toContain(`class="settings-section-label">${label}</span>`);
      expect(button.indexOf('settings-section-icon'), label).toBeLessThan(button.indexOf('settings-section-label'));
    });

    expect(SETTINGS_SECTIONS_SOURCE).toContain('satisfies Record<SettingsSection, LucideIcon>');
  });

  it('keeps icon geometry and color coupled to every rail interaction and narrow layout', () => {
    expect(SETTINGS_STYLES).toMatch(
      /\.settings-section-icon \{[^}]*width:\s*16px[^}]*height:\s*16px[^}]*color:\s*currentColor[^}]*stroke-width:\s*1\.75/s
    );
    expect(SETTINGS_STYLES).toMatch(
      /\.settings-rail button \{[^}]*display:\s*inline-flex[^}]*align-items:\s*center[^}]*gap:\s*8px/s
    );
    expect(SETTINGS_STYLES).toMatch(
      /\.settings-rail button:hover:not\(:disabled\):not\(\.active\) \{[^}]*color:\s*var\(--foreground\)/s
    );
    expect(SETTINGS_STYLES).toMatch(
      /\.settings-rail button:focus-visible \{[^}]*outline:\s*2px solid var\(--ring\)[^}]*color:\s*var\(--foreground\)/s
    );
    expect(SETTINGS_STYLES).toMatch(/\.settings-rail button:disabled \{[^}]*color:\s*var\(--muted-foreground\)/s);
    expect(SETTINGS_STYLES).toMatch(
      /\.settings-rail button\.active \{[^}]*background:\s*var\(--card\)[^}]*color:\s*var\(--foreground\)/s
    );
    expect(SETTINGS_RESPONSIVE_STYLES).toMatch(
      /@media \(max-width:\s*800px\)[\s\S]*?\.settings-rail \{[^}]*display:\s*flex[^}]*overflow-x:\s*auto[\s\S]*?\.settings-rail button \{[^}]*flex:\s*none[^}]*white-space:\s*nowrap/
    );
    expect(SETTINGS_DENSITY_STYLES).toMatch(
      /html\[data-density='compact'\] \.settings-section-icon \{[^}]*width:\s*14px[^}]*height:\s*14px/
    );
  });

  it('renders Runtime, Environment, Appearance and Egress as separate selected panes', () => {
    expect(render('runtime')).toContain('<h3>Runtime</h3>');
    expect(render('runtime')).toContain('Loop structure');
    expect(render('environment')).toContain('<h3>Environment</h3>');
    expect(render('appearance')).toContain('<h3>Appearance</h3>');
    expect(render('appearance')).toContain('aria-label="Dark mode"');
    expect(render('appearance')).toContain('Body text color');
    expect(render('appearance')).toContain('Secondary text color');
    expect(render('appearance')).toContain('aria-label="Font size L"');
    expect(render('appearance')).not.toContain('Quote colors');
    expect(render('egress')).toContain('<h3>Egress controls</h3>');
    expect(render('egress')).not.toContain('What can leave this deployment');
  });

  it('keeps Settings tab titles and drops the grey captions under them', () => {
    const identity = render('identity');
    const runtime = render('runtime');
    const appearance = render('appearance');
    const experimental = render('experimental');
    expect(identity).toContain('<h3>Identity</h3>');
    expect(identity).toContain('Human roles and admins');
    expect(identity).toContain('SP Personas');
    expect(identity).not.toContain('SP user roles');
    expect(runtime).toContain('<h3>Runtime</h3>');
    expect(appearance).toContain('<h3>Appearance</h3>');
    expect(experimental).toContain('<h3>Experimental</h3>');
    expect(experimental).toContain('Benchmarking');
    for (const markup of [identity, runtime, appearance, experimental]) {
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
    expect(environment).not.toContain('Resource tags');
    expect(environment).not.toContain('Apply tags');

    const experimental = render('experimental');
    expect(experimental).toContain('Resource tags');
    expect(experimental).toContain('Applies billing attribution tags to supported Databricks resources.');
    expect(experimental).toContain('Apply tags');
    expect(experimental).not.toContain('Resource tags · Experimental');
    expect(experimental).not.toContain('retired');
  });

  it('lays Experimental features in a live Feature / Status / Control table', () => {
    const markup = render('experimental');
    expect(markup).toContain('>Feature</th>');
    expect(markup).toContain('>Status</th>');
    expect(markup).toContain('>Control</th>');
    expect(markup).toContain('Egress controls panel');
    expect(markup).toContain('>On</span>');
    expect(markup).toContain('>Off</span>');
    expect(markup).toContain('Idle');
    expect(markup).not.toContain('Egress controls panel ·');
    expect(markup).not.toContain('SP identities ·');
    expect(markup).toContain('Forecasting');
    expect(markup).not.toContain('Benchmarking ·');
    expect(markup).toContain('aria-label="Show Ops forecasting"');
  });

  it('gives every Experimental feature one concise capability sentence', () => {
    const markup = render('experimental');
    const tableStart = markup.indexOf('<table class="exp-feature-table"');
    const featureTable = markup.slice(tableStart, markup.indexOf('</table>', tableStart) + '</table>'.length);
    for (const description of [
      'Configures approved outbound network destinations for app requests.',
      'Selects the agent notebook and applies staged agent versions.',
      'Applies billing attribution tags to supported Databricks resources.',
      'Projects 7- and 30-day costs from configurable usage assumptions.',
      'Runs repeatable evaluation suites against saved test questions.',
    ]) {
      expect(featureTable).toContain(description);
    }
    expect(featureTable.match(/class="settings-row-note"/g) ?? []).toHaveLength(5);
  });

  it('aligns every Experimental row through table cells and one control wrapper', () => {
    const markup = render('experimental');
    expect(markup.match(/class="exp-feature-status"/g) ?? []).toHaveLength(5);
    expect(markup.match(/class="exp-feature-control-inner"/g) ?? []).toHaveLength(5);
    expect(markup.match(/class="exp-feature-status-column"/g) ?? []).toHaveLength(1);
    expect(markup.match(/class="exp-feature-control-column"/g) ?? []).toHaveLength(1);
    expect(SETTINGS_STYLES).toMatch(
      /\.exp-feature-table th,\s*\.exp-feature-table td \{[^}]*border-bottom:\s*1px solid var\(--border\)/
    );
    expect(SETTINGS_STYLES).toMatch(/\.exp-feature-table \{[^}]*table-layout:\s*fixed/);
    expect(SETTINGS_STYLES).toMatch(/\.exp-feature-status-column \{[^}]*width:\s*92px/);
    expect(SETTINGS_STYLES).toMatch(/\.exp-feature-control-column \{[^}]*width:\s*140px/);
    expect(SETTINGS_STYLES).toMatch(/\.exp-feature-control-inner \{[^}]*display:\s*flex/);
    expect(SETTINGS_STYLES).toMatch(/\.exp-feature-control \{[^}]*text-align:\s*right/);
    expect(SETTINGS_STYLES).not.toMatch(/\.exp-feature-control \{[^}]*display:\s*(?:inline-)?flex/);
  });

  it('puts a distinct icon, title, then one shared Experimental badge on every feature', () => {
    const markup = render('experimental');
    const badges = markup.split('experimental-pane-badge').length - 1;
    expect(badges).toBe(5);
    const rows = markup.match(/<tr(?: [^>]*)?>[\s\S]*?<\/tr>/g) ?? [];
    for (const [feature, kind, iconName] of [
      ['Egress controls panel', 'egress-controls', 'lucide-network'],
      ['Notebook agent sync', 'notebook-agent-sync', 'lucide-notebook-tabs'],
      ['Resource tags', 'resource-tags', 'lucide-tags'],
      ['Forecasting', 'forecasting', 'lucide-trending-up'],
      ['Benchmarking', 'benchmarking', 'lucide-flask-conical'],
    ] as const) {
      const row = rows.find((candidate) => candidate.includes(`>${feature}</span>`));
      expect(row, feature).toBeDefined();
      expect(row?.match(/class="exp-feature-name"/g) ?? [], feature).toHaveLength(1);
      expect(row?.match(/experimental-pane-badge/g) ?? [], feature).toHaveLength(1);
      expect(row?.match(/class="settings-row-note"/g) ?? [], feature).toHaveLength(1);
      expect(row, feature).toContain(iconName);
      expect(row, feature).toContain('aria-hidden="true"');
      const icon = row?.indexOf(`exp-feature-icon--${kind}`) ?? -1;
      const title = row?.indexOf(`>${feature}</span>`) ?? -1;
      const badge = row?.indexOf('experimental-pane-badge') ?? -1;
      expect(icon, feature).toBeGreaterThan(-1);
      expect(icon, feature).toBeLessThan(title);
      expect(title, feature).toBeLessThan(badge);
    }
    expect(SETTINGS_STYLES).toMatch(/\.exp-feature-name \{[^}]*display:\s*inline-flex[^}]*align-items:\s*center/);
    expect(SETTINGS_STYLES).toMatch(
      /\.exp-feature-label \{[^}]*display:\s*inline-flex[^}]*flex-wrap:\s*wrap[^}]*align-items:\s*center/
    );
    expect(SETTINGS_STYLES).toMatch(
      /\.exp-feature-icon \{[^}]*width:\s*16px[^}]*height:\s*16px[^}]*color:\s*var\(--ast-text-secondary\)/
    );
    expect(markup).not.toContain('Resource tags · Experimental');
  });

  it('shows the access guide once on Environment for each current admin rank and never on Identity', () => {
    for (const state of ['admin', 'super_admin'] as const) {
      const role = { state, addedAdminsReadable: true };
      const environment = render('environment', role, true);
      const identity = render('identity', role, true);
      expect(environment.match(/Access points and operating guide/g) ?? [], state).toHaveLength(1);
      expect(identity, state).not.toContain('Access points and operating guide');
    }
  });

  it('does not render the guide for a consumer even when availability is known', () => {
    const consumer = render('environment', { state: 'consumer', addedAdminsReadable: true }, true);
    expect(consumer).not.toContain('Access points and operating guide');
    expect(consumer).not.toContain('/api/admin/access-guide');
  });

  it('keeps SP Persona mappings on Identity and removes their Experimental pivot', () => {
    const identity = render('identity');
    const experimental = render('experimental');
    expect(identity).toContain('data-testid="sp-identity-pane"');
    expect(identity).toContain('SP Personas');
    expect(identity).not.toContain('Turn SP identities on under Experimental');
    expect(identity).not.toContain('type="password"');
    expect(experimental).not.toMatch(/SP identities|sp-identity-settings-link/);
  });

  it('adds Notebook agent sync with concise non-automatic copy', () => {
    const markup = render('experimental');
    expect(markup).toContain('Notebook agent sync');
    expect(markup).toContain('Selects the agent notebook and applies staged agent versions.');
    expect(markup).toContain('aria-label="Enable Notebook agent sync"');
    expect(markup).not.toMatch(/automatically|changes models merely/i);
  });

  it('puts egress controls, Notebook agent sync, and resource tags above benchmarking', () => {
    const markup = render('experimental');
    const pii = markup.indexOf('Egress controls panel');
    const notebook = markup.indexOf('Notebook agent sync');
    const tags = markup.indexOf('Resource tags');
    const benchmarking = markup.indexOf('>Benchmarking<');
    const addJudge = markup.indexOf('Add this custom judge');
    expect(pii).toBeGreaterThan(-1);
    expect(notebook).toBeGreaterThan(pii);
    expect(tags).toBeGreaterThan(notebook);
    expect(benchmarking).toBeGreaterThan(tags);
    expect(addJudge).toBeGreaterThan(benchmarking);
  });

  it('puts MLflow and bake-off controls on Experimental, disabled while Benchmarking is off', () => {
    const off = render('experimental');
    expect(off).toContain('MLflow experiment');
    expect(off).toContain('Always-on traces');
    expect(off).toContain('Judge model');
    expect(off).not.toContain('Baseline vs candidate');
    expect(off).not.toContain('Eval set');
    expect(off).toContain('disabled=""');
    expect(off).toContain('class="sr-only">Save</span>');

    const on = renderToStaticMarkup(
      <SettingsPage
        initialSection="experimental"
        features={{ benchmarkLab: true, egressControls: true, forecasting: false, notebookAgentSync: false }}
        setFeature={() => {}}
        role={roleFrom(NORMAL_IDENTITY)}
      />
    );
    expect(on).toContain('MLflow experiment');
    expect(on).toContain('class="sr-only">Save</span>');
    expect(on).not.toContain('>Benchmarking</button>');
  });

  it('keeps one active-section Save and Cancel in the modal footer on every tab', () => {
    for (const section of ['runtime', 'appearance', 'experimental', 'identity', 'environment', 'egress'] as const) {
      const markup = render(section);
      expect(markup.match(/class="sr-only">Save<\/span>/g) ?? []).toHaveLength(1);
      expect(markup).toContain('>Cancel</button>');
    }
  });

  it('renders every pane without router outlet context', () => {
    for (const section of ['identity', 'runtime', 'environment', 'appearance', 'egress', 'experimental'] as const) {
      const markup = render(section);
      expect(markup).toContain('data-testid="settings-modal-overlay"');
      expect(markup).not.toContain('This view could not be displayed');
    }
  });

  it('renders Identity for null, undefined, refused, failed, missing-role and service-principal identities', () => {
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
        executionMode: 'service-principal',
      },
    ];
    for (const identity of hostileIdentities) {
      const markup = render('identity', roleFrom(identityFromResponse(identity)));
      expect(markup).toContain('<h3>Identity</h3>');
      expect(markup).toContain('Human roles and admins');
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
    expect(layout).toContain('setSettingsOpen(true)');
    expect(layout).toContain('void refreshExperimental()');
    expect(layout).toContain("const settingsDeepLink = location.pathname === '/settings'");
    const settingsRoute = app.slice(app.indexOf("path: '/settings'"), app.indexOf("path: '/connections'"));
    expect(settingsRoute).toContain('<AdminOnly>');
    expect(settingsRoute).toContain('<HomePage />');
    expect(settingsRoute).not.toContain('<SettingsPage');
    // The gate outside the outlet must be handed a role rather than reading one.
    expect(layout).toContain('<AdminOnly role={role}>');
  });
});
