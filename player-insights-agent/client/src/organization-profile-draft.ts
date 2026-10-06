import {
  organizationProfileDomain,
  organizationProfileMonogram,
  organizationProfileName,
  type OrganizationMapping,
  type OrganizationProfileRow,
} from '../../shared/organization-mapping';

export function organizationFromRow(row: OrganizationProfileRow): OrganizationMapping {
  return {
    id: `domain:${row.domain}`,
    domain: row.domain,
    domainSuffixes: row.domains,
    name: row.name,
    monogram: row.monogram,
    logoKey: row.logoKey,
    ariaLabel: `Organization: ${row.name}`,
    fallback: 'monogram',
  };
}

/** What stops a draft from being saved, or '' when it can be. Shared by the row editor and the add row. */
export function organizationDraftProblem(draft: { domain?: string; name: string; monogram: string }): string {
  if (draft.domain !== undefined && !organizationProfileDomain(draft.domain)) {
    return 'Enter an email domain such as @example.com.';
  }
  if (!organizationProfileName(draft.name)) return 'Enter an organization name.';
  if (draft.monogram.trim() && !organizationProfileMonogram(draft.monogram)) {
    return 'The short mark is 1 to 4 characters with no spaces.';
  }
  return '';
}
