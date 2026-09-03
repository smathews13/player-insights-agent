import {
  normalizedOrganizationDomain,
  sanitizeOrganizationMappings,
  type OrganizationFilterOption,
  type OrganizationMapping,
} from './organization-contract';

export {
  sanitizeOrganizationMappings,
  type OrganizationFilterOption,
  type OrganizationLogoKey,
  type OrganizationMapping,
} from './organization-contract';

/**
 * The canonical, stored organization manifest.
 *
 * Public source carries only the product organization. Customer and partner
 * identities arrive through `PLAYER_INSIGHTS_ORGANIZATIONS`, where longest-
 * suffix matching still lets each deployment add specific organizations.
 */
export const ORGANIZATION_MANIFEST: readonly OrganizationMapping[] = [
  {
    id: 'databricks',
    domain: 'databricks.com',
    domainSuffixes: ['databricks.com'],
    name: 'Databricks',
    monogram: 'DB',
    logoKey: 'databricks',
    ariaLabel: 'Organization: Databricks',
    fallback: 'monogram',
  },
] as const;

function mergedOrganizationManifest(configured: readonly OrganizationMapping[]): OrganizationMapping[] {
  const byId = new Map<string, OrganizationMapping>();
  for (const organization of [...ORGANIZATION_MANIFEST, ...configured]) {
    if (!byId.has(organization.id)) byId.set(organization.id, organization);
  }
  return [...byId.values()];
}

/** Canonical entries plus safe deployment-provided organizations. */
export function parseOrganizationMappings(raw: string | undefined | null): OrganizationMapping[] {
  if (!raw?.trim()) return [...ORGANIZATION_MANIFEST];
  try {
    return mergedOrganizationManifest(sanitizeOrganizationMappings(JSON.parse(raw)));
  } catch {
    return [...ORGANIZATION_MANIFEST];
  }
}

export function emailDomain(email: string): string {
  const at = email.trim().lastIndexOf('@');
  return at >= 0 ? normalizedOrganizationDomain(email.slice(at + 1)) : '';
}

function unknownOrganization(domain: string): OrganizationMapping {
  const name = domain || 'External';
  return {
    id: domain ? `domain:${domain}` : 'external',
    domain,
    domainSuffixes: domain ? [domain] : [],
    name,
    monogram: '•',
    logoKey: 'fallback',
    ariaLabel: `Organization: ${name}`,
    fallback: 'building',
  };
}

function suffixMatch(domain: string, suffix: string): boolean {
  return domain === suffix || domain.endsWith(`.${suffix}`);
}

/**
 * Case-insensitive longest-suffix resolution.
 *
 * Unknown domains never inherit a nearby brand: only an exact suffix boundary
 * matches.
 */
export function organizationForEmail(
  email: string,
  mappings: readonly OrganizationMapping[] = []
): OrganizationMapping {
  const domain = emailDomain(email);
  const candidates = mergedOrganizationManifest(sanitizeOrganizationMappings(mappings)).flatMap((organization) =>
    organization.domainSuffixes.map((suffix) => ({ organization, suffix }))
  );
  candidates.sort((left, right) => right.suffix.length - left.suffix.length);
  return (
    candidates.find((candidate) => suffixMatch(domain, candidate.suffix))?.organization ?? unknownOrganization(domain)
  );
}

/** Organizations represented by the supplied Identity-roster addresses only. */
export function organizationsForEmails(
  emails: readonly string[],
  mappings: readonly OrganizationMapping[] = []
): OrganizationFilterOption[] {
  const represented = new Map<string, OrganizationFilterOption>();
  for (const email of emails) {
    const organization = organizationForEmail(email, mappings);
    const current = represented.get(organization.id);
    if (current) current.count += 1;
    else represented.set(organization.id, { ...organization, count: 1 });
  }
  return [...represented.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  );
}

/** Domain suffixes for represented selected ids; invalid ids intentionally match nothing. */
export function organizationSuffixesForSelection(
  selected: readonly string[],
  represented: readonly OrganizationFilterOption[]
): string[] {
  if (selected.length === 0) return [];
  const available = new Map(represented.map((organization) => [organization.id, organization]));
  const selectedOrganizations = selected.map((id) => available.get(id));
  if (selectedOrganizations.some((organization) => !organization)) return ['__no_matching_organization__'];
  return [
    ...new Set(
      selectedOrganizations
        .flatMap((organization) => organization?.domainSuffixes ?? [])
        .map(normalizedOrganizationDomain)
    ),
  ].filter(Boolean);
}
