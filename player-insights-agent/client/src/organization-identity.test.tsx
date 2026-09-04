import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_MANIFEST,
  organizationForEmail,
  organizationsForEmails,
  parseOrganizationMappings,
} from '../../shared/organization-mapping';
import { OrganizationAvatar } from './OrganizationAvatar';
import { ORGANIZATION_LOGOS } from './organization-logos';
import {
  organizationSelectOptions,
  organizationSelectionSummary,
  toggleOrganizationSelection,
} from './UserOrganizationSelect';

const ACCOUNT_CSS = readFileSync(new URL('./styles/account-menu.css', import.meta.url), 'utf8');
const MONITORING_CSS = readFileSync(new URL('./styles/monitoring.css', import.meta.url), 'utf8');
const RESPONSIVE_CSS = readFileSync(new URL('./styles/responsive-monitoring.css', import.meta.url), 'utf8');
const DENSITY_CSS = readFileSync(new URL('./styles/density-monitoring.css', import.meta.url), 'utf8');
const MULTISELECT_SOURCE = [
  readFileSync(new URL('./AppMultiSelect.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./AppMultiSelectMenu.tsx', import.meta.url), 'utf8'),
].join('\n');
const ORGANIZATION_SELECT_SOURCE = readFileSync(new URL('./UserOrganizationSelect.tsx', import.meta.url), 'utf8');

describe('organization identity assets', () => {
  it('renders each canonical local mark with the manifest label and stable id', () => {
    for (const organization of ORGANIZATION_MANIFEST) {
      const markup = renderToStaticMarkup(<OrganizationAvatar organization={organization} />);
      expect(markup).toContain(`data-organization-id="${organization.id}"`);
      expect(markup).toContain(`aria-label="${organization.ariaLabel}"`);
      expect(markup).toContain(ORGANIZATION_LOGOS[organization.logoKey]);
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
    expect(markup).not.toContain('roster-organization-mark--branded');
  });

  it('keeps organization marks legible in both themes, compact density, and responsive controls', () => {
    expect(ACCOUNT_CSS).toMatch(/\.roster-organization-mark--branded[^}]*background:\s*var\(--card\)/s);
    expect(ACCOUNT_CSS).toMatch(/\.roster-organization-logo svg[^}]*color:\s*inherit/s);
    expect(ACCOUNT_CSS).toMatch(
      /@media \(forced-colors: active\)[\s\S]*\.roster-organization-mark[^}]*color:\s*CanvasText/s
    );
    expect(MONITORING_CSS).toContain('.monitoring-organization-trigger');
    expect(RESPONSIVE_CSS).toMatch(/\.monitoring-organization-trigger[^}]*width:\s*100%/s);
    expect(DENSITY_CSS).toContain('.app-menu-option');
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
