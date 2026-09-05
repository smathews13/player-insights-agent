import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_MANIFEST,
  organizationForEmail,
  organizationsForEmails,
  parseOrganizationMappings,
} from '../../shared/organization-mapping';
import { OrganizationAvatar } from './OrganizationAvatar';
import { OrganizationUserBadge } from './OrganizationUserBadge';
import { ORGANIZATION_LOGOS } from './organization-logos';
import {
  organizationSelectOptions,
  organizationSelectionSummary,
  toggleOrganizationSelection,
} from './UserOrganizationSelect';

const ORGANIZATION_CSS = readFileSync(new URL('./styles/organization-avatar.css', import.meta.url), 'utf8');
const SHELL_CSS = readFileSync(new URL('./styles/shell.css', import.meta.url), 'utf8');
const SETTINGS_CSS = readFileSync(new URL('./styles/settings.css', import.meta.url), 'utf8');
const ACCOUNT_CSS = readFileSync(new URL('./styles/account-menu.css', import.meta.url), 'utf8');
const QUESTION_CSS = readFileSync(new URL('./styles/question-attribution.css', import.meta.url), 'utf8');
const MONITORING_CSS = readFileSync(new URL('./styles/monitoring.css', import.meta.url), 'utf8');
const RESPONSIVE_CSS = readFileSync(new URL('./styles/responsive-monitoring.css', import.meta.url), 'utf8');
const DENSITY_CSS = readFileSync(new URL('./styles/density-monitoring.css', import.meta.url), 'utf8');
const MULTISELECT_SOURCE = [
  readFileSync(new URL('./AppMultiSelect.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./AppMultiSelectMenu.tsx', import.meta.url), 'utf8'),
].join('\n');
const ORGANIZATION_SELECT_SOURCE = readFileSync(new URL('./UserOrganizationSelect.tsx', import.meta.url), 'utf8');
const HOST_SOURCE = {
  account: [
    readFileSync(new URL('./AccountMenu.tsx', import.meta.url), 'utf8'),
    readFileSync(new URL('./AccountMenuPanel.tsx', import.meta.url), 'utf8'),
  ].join('\n'),
  identity: [
    readFileSync(new URL('./IdentityPanel.tsx', import.meta.url), 'utf8'),
    readFileSync(new URL('./UserRoleEditor.tsx', import.meta.url), 'utf8'),
  ].join('\n'),
  monitoring: readFileSync(new URL('./MonitoringPage.tsx', import.meta.url), 'utf8'),
  question: readFileSync(new URL('./QuestionAttributionBubble.tsx', import.meta.url), 'utf8'),
  rail: readFileSync(new URL('./HomePage.tsx', import.meta.url), 'utf8'),
  run: readFileSync(new URL('./RunHeader.tsx', import.meta.url), 'utf8'),
};

function rule(stylesheet: string, selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  expect(start, `${selector} exists`).toBeGreaterThan(-1);
  return stylesheet.slice(start, stylesheet.indexOf('}', start));
}

describe('organization identity assets', () => {
  it('renders each canonical local mark with the manifest label and stable id', () => {
    for (const organization of ORGANIZATION_MANIFEST) {
      const markup = renderToStaticMarkup(<OrganizationAvatar organization={organization} />);
      expect(markup).toContain(`data-organization-id="${organization.id}"`);
      expect(markup).toContain(`aria-label="${organization.ariaLabel}"`);
      expect(markup).toContain(ORGANIZATION_LOGOS[organization.logoKey]);
      expect(markup).toContain('data-organization-mark="raw"');
      expect(markup).toMatch(/roster-organization-mark--logo[^>]*><svg/);
      expect(markup).not.toContain('roster-organization-logo');
      expect(markup).not.toContain('roster-databricks-symbol');
      expect(markup).not.toContain('lucide-user-round');
    }
  });

  it('uses the same derived domain mark instead of a building across public-Git surfaces', () => {
    const markup = renderToStaticMarkup(
      <OrganizationAvatar organization={organizationForEmail('reader@studio2games.example')} />
    );
    expect(markup).toContain('data-organization-id="domain:studio2games.example"');
    expect(markup).toContain('>S2</span>');
    expect(markup).not.toContain('lucide-building-2');
    expect(markup).toContain('roster-organization-mark--monogram');
    expect(markup).toContain('data-organization-mark="raw"');
  });

  it('keeps every organization mark as an unframed transparent fixed icon box', () => {
    const mark = rule(ORGANIZATION_CSS, '.roster-organization-mark');
    expect(mark).toContain('width: 24px');
    expect(mark).toContain('height: 24px');
    expect(mark).toContain('padding: 0');
    expect(mark).toContain('border: 0');
    expect(mark).toContain('border-radius: 0');
    expect(mark).toContain('background: transparent');
    expect(mark).toContain('box-shadow: none');
    expect(rule(ORGANIZATION_CSS, '.roster-organization-mark--logo > svg')).toMatch(
      /width:\s*100%[\s\S]*height:\s*100%/
    );
    expect(ORGANIZATION_CSS).not.toContain('roster-organization-mark--branded');
    expect(ORGANIZATION_CSS).not.toContain('roster-organization-mark--databricks');
    expect(SETTINGS_CSS).not.toMatch(/\.roster-organization-mark(?:\s|,|\{)/);
    expect(ORGANIZATION_CSS).toMatch(
      /@media \(forced-colors: active\)[\s\S]*\.roster-organization-mark[^}]*color:\s*CanvasText/s
    );
    expect(ORGANIZATION_CSS).not.toMatch(
      /@media \(forced-colors: active\)[\s\S]*\.roster-organization-mark[^}]*(?:background|border-color):/s
    );
    expect(MONITORING_CSS).toContain('.monitoring-organization-trigger');
    expect(RESPONSIVE_CSS).toMatch(/\.monitoring-organization-trigger[^}]*width:\s*100%/s);
    expect(DENSITY_CSS).toContain('.app-menu-option');
  });

  it('routes every identity host through the one raw organization mark primitive', () => {
    expect(HOST_SOURCE.account.match(/<OrganizationAvatar/g)).toHaveLength(2);
    expect(HOST_SOURCE.identity.match(/<OrganizationAvatar/g)).toHaveLength(2);
    expect(HOST_SOURCE.monitoring).toMatch(/function AskerMark[\s\S]*?<OrganizationUserBadge/);
    expect(HOST_SOURCE.monitoring.match(/icon=\{<OrganizationAvatar/g)).toHaveLength(3);
    expect(HOST_SOURCE.rail).toMatch(/<OrganizationUserBadge[\s\S]*?className="conversation-owner"/);
    expect(HOST_SOURCE.question).toContain('<OrganizationUserBadge');
    expect(HOST_SOURCE.run).toContain('<QuestionAttributionBubble');
  });

  it('keeps the sole badge boundary outside the raw organization mark', () => {
    expect(rule(SHELL_CSS, '.identity-chip')).toContain('border: 1px solid var(--db-line-strong)');
    expect(rule(ACCOUNT_CSS, '.account-menu-trigger')).toContain('border: 1px solid var(--ast-border-input)');
    expect(rule(QUESTION_CSS, '.question-attribution-surface')).toContain('border: 1px solid var(--ast-border-input)');
    expect(rule(QUESTION_CSS, '.question-attribution-bubble .question-attribution-user.identity-chip')).toContain(
      'border: 0'
    );
    expect(rule(ORGANIZATION_CSS, '.roster-organization-mark')).toContain('border: 0');
  });
});

describe('organization user badges', () => {
  it.each([
    ['<your-username>', 'databricks', '<your-username>'],
    ['producer@take2games.com', 'acme-interactive', 'producer'],
    ['artist@2k.com', '2k', 'artist'],
    ['designer@northwindgames.com', 'northwind-games', 'designer'],
  ])('shows the canonical organization mark and user handle for %s', (email, organizationId, handle) => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <OrganizationUserBadge identity={email} canOpen showArrow />
      </MemoryRouter>
    );
    expect(markup).toContain(`data-organization-id="${organizationId}"`);
    expect(markup).toContain(`>${handle}<`);
    expect(markup).toMatch(/data-organization-mark="raw"[^>]*><svg/);
    expect(markup.indexOf('data-organization-mark="raw"')).toBeLessThan(markup.indexOf('identity-chip-name'));
    expect(markup.match(/data-organization-mark="raw"/g)).toHaveLength(1);
    expect(markup).toContain('identity-chip-link-arrow');
    expect(markup).not.toContain('Asked by');
    expect(markup).not.toContain('lucide-user-round');
    expect(markup).not.toContain(`>${email}<`);
  });

  it('uses the stable unknown-domain monogram without inventing a brand', () => {
    const markup = renderToStaticMarkup(<OrganizationUserBadge identity="reader@studio2games.example" />);
    expect(markup).toContain('data-organization-id="domain:studio2games.example"');
    expect(markup).toContain('>S2</span>');
    expect(markup).toContain('>reader<');
    expect(markup).not.toContain('lucide-user-round');
  });

  it('carries full user and organization detail in tooltip and accessible names', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <OrganizationUserBadge identity="producer@take2games.com" canOpen />
      </MemoryRouter>
    );
    expect(markup).toContain('title="producer@take2games.com · Acme Interactive"');
    expect(markup).toContain(
      'aria-label="Open user overview for User producer@take2games.com; organization Acme Interactive"'
    );
  });
});

describe('User Monitoring organization multiselect', () => {
  const mappings = parseOrganizationMappings(
    JSON.stringify([
      { domain: 'studio.example', name: 'Example Studio', monogram: 'ES' },
      { domain: 'partner.example', name: 'Example Partner', monogram: 'EP' },
    ])
  );
  const organizations = organizationsForEmails(
    ['one@studio.example', 'two@north.studio.example', 'three@partner.example'],
    mappings
  );

  it('uses the concise All, one-name, and N-organizations trigger summaries', () => {
    expect(organizationSelectionSummary([], organizations)).toBe('All organizations');
    expect(organizationSelectionSummary(['domain:studio.example'], organizations)).toBe('Example Studio');
    expect(organizationSelectionSummary(['domain:studio.example', 'domain:partner.example'], organizations)).toBe(
      '2 organizations'
    );
    expect(ORGANIZATION_SELECT_SOURCE).not.toContain('Organization ·');
    expect(ORGANIZATION_SELECT_SOURCE).not.toContain('Organization: ${summary}');
  });

  it('uses the shared portalled non-modal dropdown without locking or shifting the page', () => {
    expect(ORGANIZATION_SELECT_SOURCE).toContain('<AppMultiSelect');
    expect(MULTISELECT_SOURCE).toContain('<PopoverContent');
    expect(MULTISELECT_SOURCE).toContain('without locking');
    expect(MULTISELECT_SOURCE).not.toContain('document.body');
    expect(MULTISELECT_SOURCE).not.toMatch(/<Popover[^>]*modal=/);
    expect(MONITORING_CSS).toMatch(/\.monitoring-users-filter-menu[^}]*scrollbar-gutter:\s*stable/s);
  });

  it('ORs selections within the filter and clears through All', () => {
    expect(toggleOrganizationSelection([], 'domain:studio.example')).toEqual(['domain:studio.example']);
    expect(toggleOrganizationSelection(['domain:studio.example'], 'domain:partner.example')).toEqual([
      'domain:studio.example',
      'domain:partner.example',
    ]);
    expect(
      toggleOrganizationSelection(['domain:studio.example', 'domain:partner.example'], 'domain:studio.example')
    ).toEqual(['domain:partner.example']);
    expect(toggleOrganizationSelection(['domain:studio.example'], '')).toEqual([]);
  });

  it('offers only represented organizations with stable counts and logo content', () => {
    const options = organizationSelectOptions(organizations);
    expect(options.map(({ value, label, count }) => ({ value, label, count }))).toEqual([
      { value: 'domain:partner.example', label: 'Example Partner', count: 1 },
      { value: 'domain:studio.example', label: 'Example Studio', count: 2 },
    ]);
    expect(renderToStaticMarkup(<>{options[1]?.content}</>)).toContain('data-organization-id="domain:studio.example"');
    expect(options[1]?.ariaLabel).toBe('Example Studio, 2 users');
  });

  it('renders an unconfigured digit-domain option with its stable mark and count', () => {
    const options = organizationSelectOptions(organizationsForEmails(['one@studio2games.example']));
    expect(options[0]).toMatchObject({
      value: 'domain:studio2games.example',
      label: 'studio2games.example',
      count: 1,
    });
    expect(renderToStaticMarkup(<>{options[0]?.content}</>)).toContain('>S2</span>');
  });
});
