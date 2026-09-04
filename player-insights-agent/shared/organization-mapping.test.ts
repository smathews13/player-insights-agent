import { describe, expect, it } from 'vitest';
import {
  ORGANIZATION_MANIFEST,
  organizationForEmail,
  organizationMonogramForDomain,
  organizationOptionsForEmails,
  organizationsForEmails,
  organizationSuffixesForSelection,
  parseOrganizationMappings,
  sanitizeOrganizationFilterOptions,
} from './organization-mapping';

const mappings = parseOrganizationMappings(
  JSON.stringify([
    { domain: 'example.org', name: 'Example Cooperative', monogram: 'EC' },
    { domain: 'studio.example.org', name: 'Example Studio', monogram: 'ES' },
  ])
);

describe('organization mapping', () => {
  it('stores canonical ids, suffixes, local logo keys, labels and safe fallbacks', () => {
    expect(
      ORGANIZATION_MANIFEST.map(({ id, name, domain, logoKey, fallback }) => ({ id, name, domain, logoKey, fallback }))
    ).toEqual([
      {
        id: 'databricks',
        name: 'Databricks',
        domain: 'databricks.com',
        logoKey: 'databricks',
        fallback: 'monogram',
      },
    ]);
    for (const organization of ORGANIZATION_MANIFEST) {
      expect(organization.domainSuffixes).toContain(organization.domain);
      expect(organization.ariaLabel).toBe(`Organization: ${organization.name}`);
    }
  });

  it('matches domains case-insensitively and prefers the longest exact suffix', () => {
    expect(organizationForEmail('A@STUDIO.EXAMPLE.ORG', mappings).name).toBe('Example Studio');
    expect(organizationForEmail('a@team.example.org', mappings).name).toBe('Example Cooperative');
  });

  it.each([['leader@labs.databricks.com', 'databricks']])('maps public product subdomains for %s', (email, id) => {
    expect(organizationForEmail(email, []).id).toBe(id);
  });

  it('uses a domain-derived mark without inferring a legal affiliation', () => {
    expect(organizationForEmail('person@outside.test', mappings)).toMatchObject({
      id: 'domain:outside.test',
      domain: 'outside.test',
      name: 'outside.test',
      monogram: 'OU',
      logoKey: 'monogram',
      fallback: 'monogram',
    });
    expect(organizationForEmail('person@notexample.org', mappings).id).toBe('domain:notexample.org');
    expect(organizationForEmail('not-an-email', mappings).name).toBe('External');
  });

  it('derives compact digit-aware marks from neutral registrable labels', () => {
    expect(organizationMonogramForDomain('studio2games.example')).toBe('S2');
    expect(organizationMonogramForDomain('north.studio2games.example')).toBe('S2');
    expect(organizationMonogramForDomain('2k.example')).toBe('Contoso');
    expect(organizationMonogramForDomain('outside.test')).toBe('OU');
  });

  it('lets an explicit deployment overlay win over the derived mark', () => {
    const configured = parseOrganizationMappings(
      JSON.stringify([{ domain: 'studio2games.example', name: 'Configured Studio', monogram: 'CS' }])
    );
    expect(organizationForEmail('reader@north.studio2games.example', configured)).toMatchObject({
      name: 'Configured Studio',
      monogram: 'CS',
      fallback: 'monogram',
    });
  });

  it('fails closed on malformed configuration', () => {
    expect(parseOrganizationMappings('{"domain":"example.org"}')).toEqual(ORGANIZATION_MANIFEST);
    expect(parseOrganizationMappings('not json')).toEqual(ORGANIZATION_MANIFEST);
    const parsed = parseOrganizationMappings(
      JSON.stringify([{ domain: 'partner.example', name: 'Example Partner', monogram: 'EP', token: 'secret' }])
    );
    expect(parsed).toEqual(ORGANIZATION_MANIFEST);
    expect(
      organizationForEmail('person@partner.example', [{ domain: undefined, name: 'Malformed', monogram: 'M' }] as never)
    ).toMatchObject({ id: 'domain:partner.example', domain: 'partner.example', name: 'partner.example' });
  });

  it('derives represented filter options and rejects unrepresented selections', () => {
    const represented = organizationsForEmails(
      ['one@studio.example.org', 'two@example.org', 'three@outside.test'],
      mappings
    );
    expect(represented.map(({ id, count }) => ({ id, count }))).toEqual([
      { id: 'domain:example.org', count: 1 },
      { id: 'domain:studio.example.org', count: 1 },
      { id: 'domain:outside.test', count: 1 },
    ]);
    expect(organizationSuffixesForSelection(['domain:studio.example.org'], represented)).toEqual([
      'studio.example.org',
    ]);
    expect(organizationSuffixesForSelection(['not-in-roster'], represented)).toEqual(['__no_matching_organization__']);
  });

  it('always maps product-domain roster users and keeps zero-count facets available', () => {
    const roster = [
      'one@example.com',
      'two@engineering.databricks.com',
      'three@example.com',
      'four@labs.databricks.com',
    ];
    expect(organizationsForEmails(roster)).toEqual([expect.objectContaining({ id: 'databricks', count: 4 })]);
    expect(organizationOptionsForEmails(roster, [])).toEqual([expect.objectContaining({ id: 'databricks', count: 0 })]);
  });

  it('decodes counted filter options without weakening mapping validation', () => {
    const option = { ...organizationsForEmails(['one@example.com'])[0], count: 4 };
    expect(sanitizeOrganizationFilterOptions([option])).toEqual([
      expect.objectContaining({ id: 'databricks', count: 4 }),
    ]);
    expect(sanitizeOrganizationFilterOptions([{ ...option, count: '4' }])).toEqual([]);
    expect(sanitizeOrganizationFilterOptions([{ ...option, secret: 'not accepted' }])).toEqual([]);
  });
});
