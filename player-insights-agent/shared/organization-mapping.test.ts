import { describe, expect, it } from 'vitest';
import { organizationForEmail, parseOrganizationMappings } from './organization-mapping';

const mappings = parseOrganizationMappings(
  JSON.stringify([
    { domain: 'example.org', name: 'Example Cooperative', monogram: 'EC' },
    { domain: 'studio.example.org', name: 'Example Studio', monogram: 'ES' },
  ])
);

describe('organization mapping', () => {
  it('always maps Databricks mail to the verified built-in organization', () => {
    expect(organizationForEmail('<your-username>', [])).toEqual({
      domain: 'databricks.com',
      name: 'Databricks',
      monogram: 'DB',
    });
    expect(
      organizationForEmail('person@labs.databricks.com', [
        { domain: 'databricks.com', name: 'Configured initials', monogram: 'XX' },
      ])
    ).toEqual({
      domain: 'databricks.com',
      name: 'Databricks',
      monogram: 'DB',
    });
  });

  it('matches domains case-insensitively and prefers the longest exact suffix', () => {
    expect(organizationForEmail('A@STUDIO.EXAMPLE.ORG', mappings).name).toBe('Example Studio');
    expect(organizationForEmail('a@team.example.org', mappings).name).toBe('Example Cooperative');
  });

  it('uses a neutral local fallback without inferring an affiliation', () => {
    expect(organizationForEmail('person@outside.test', mappings)).toEqual({
      domain: 'outside.test',
      name: 'outside.test',
      monogram: '•',
    });
    expect(organizationForEmail('not-an-email', mappings).name).toBe('External');
  });

  it('fails closed on malformed configuration', () => {
    expect(parseOrganizationMappings('{"domain":"example.org"}')).toEqual([]);
    expect(parseOrganizationMappings('not json')).toEqual([]);
  });
});
