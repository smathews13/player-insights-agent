import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { UserDrilldownLink } from './UserDrilldownLink';
import { normalizedHumanEmail, userOverviewHref } from './user-drilldown';
import { USER_IDENTITY_SURFACES } from './user-identity-surface-registry';

const source = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');

describe('shared user drilldown links', () => {
  it('builds the canonical encoded Monitoring profile URL without carrying another page query', () => {
    expect(userOverviewHref(' Alice+QA@Example.Test ')).toBe('/monitoring?who=alice%2Bqa%40example.test');
    expect(normalizedHumanEmail('system')).toBeNull();
    expect(normalizedHumanEmail('service-principal-id')).toBeNull();
    expect(normalizedHumanEmail('')).toBeNull();
  });

  it('preserves Monitoring browser state and lets router navigation create the Back entry', () => {
    expect(userOverviewHref('alice@example.test', '?range=7d&userSearch=ali')).toBe(
      '/monitoring?range=7d&userSearch=ali&who=alice%40example.test'
    );
  });

  it('renders an admin identity as one real link and a non-admin identity as plain chip content', () => {
    const linked = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/runs?run=1']}>
        <UserDrilldownLink identity="alice@example.test" canOpen />
      </MemoryRouter>
    );
    const plain = renderToStaticMarkup(
      <MemoryRouter>
        <UserDrilldownLink identity="alice@example.test" canOpen={false} />
      </MemoryRouter>
    );

    expect(linked).toContain('href="/monitoring?who=alice%40example.test"');
    expect(linked).toContain('aria-label="Open user overview for alice"');
    expect((linked.match(/<a /g) ?? []).length).toBe(1);
    expect(plain).not.toContain('<a ');
    expect(plain).toContain('alice');
  });

  it('does not link unknown or non-email actors even when access is allowed', () => {
    for (const identity of ['', 'unknown', 'system', 'service-principal-id']) {
      const markup = renderToStaticMarkup(
        <MemoryRouter>
          <UserDrilldownLink identity={identity} canOpen />
        </MemoryRouter>
      );
      expect(markup).not.toContain('<a ');
    }
  });

  it('registers every identity surface and requires the shared component on drilldown surfaces', () => {
    expect(new Set(USER_IDENTITY_SURFACES.map((surface) => surface.id)).size).toBe(USER_IDENTITY_SURFACES.length);
    for (const surface of USER_IDENTITY_SURFACES) {
      expect(surface.policy === 'drilldown' || Boolean(surface.reason)).toBe(true);
      if (surface.policy === 'drilldown') expect(source(surface.file)).toContain('UserDrilldownLink');
    }
  });

  it('keeps direct raw chip imports limited to documented static surfaces and the shared wrapper', () => {
    const directChipFiles = [
      'AccessGate.tsx',
      'FirstOpenGate.tsx',
      'Layout.tsx',
      'MonitoringPage.tsx',
      'UserDrilldownLink.tsx',
    ];
    for (const file of directChipFiles) expect(source(file)).toContain('UserIdentityChip');

    const migrated = [
      'BenchmarkLab.tsx',
      'ConnectionsPage.tsx',
      'DeclaredConnectionsCard.tsx',
      'HomePage.tsx',
      'RunExplorer.tsx',
      'RunHeader.tsx',
      'UserRoleEditor.tsx',
    ];
    for (const file of migrated) expect(source(file)).not.toContain('UserIdentityChip');
  });

  it('defines pointer, hover, focus-visible, and Space activation without dimming links', () => {
    const css = source('styles/shell.css');
    const component = source('UserDrilldownLink.tsx');
    expect(css).toMatch(/\.user-drilldown-link\s*\{[^}]*cursor:\s*pointer/s);
    expect(css).toContain('.user-drilldown-link:hover');
    expect(css).toContain('.user-drilldown-link:focus-visible');
    expect(css).not.toMatch(/\.user-drilldown-link[^{]*\{[^}]*opacity\s*:/s);
    expect(component).toContain("event.key !== ' '");
    expect(component).toContain('event.currentTarget.click()');
  });
});
