import {
  normalizedOrganizationDomain,
  sanitizeOrganizationMappings,
  type OrganizationFilterOption,
  type OrganizationMapping,
} from './organization-contract';

export {
  sanitizeOrganizationFilterOptions,
  sanitizeOrganizationMappings,
  type OrganizationFilterOption,
  type OrganizationLogoKey,
  type OrganizationMapping,
} from './organization-contract';

/**
 * The canonical, stored organization manifest.
 *
 * Root suffixes cover legitimate subdomains while longest-suffix matching lets
 * a deployment add a more specific organization deliberately. These records
 * are the one identity vocabulary used by the account and Monitoring surfaces,
 * and by compact conversation attribution.
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
  {
    id: 'acme-interactive',
    domain: 'take2games.com',
    domainSuffixes: ['take2games.com'],
    name: 'Acme Interactive',
    monogram: 'T2',
    logoKey: 'acme',
    ariaLabel: 'Organization: Acme Interactive',
    fallback: 'monogram',
  },
  {
    id: '2k',
    domain: '2k.com',
    domainSuffixes: ['2k.com'],
    name: 'Contoso',
    monogram: 'Contoso',
    logoKey: '2k',
    ariaLabel: 'Organization: Contoso',
    fallback: 'monogram',
  },
  {
    id: 'northwind-games',
    domain: 'northwindgames.com',
    domainSuffixes: ['northwindgames.com', 'northwindnewengland.com', 'northwindlondon.com'],
    name: 'Northwind Games',
    monogram: 'R*',
    logoKey: 'northwind',
    ariaLabel: 'Organization: Northwind Games',
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

/** Stable, privacy-safe mark for an unconfigured registrable-domain label. */
export function organizationMonogramForDomain(domain: string): string {
  const parts = normalizedOrganizationDomain(domain).split('.').filter(Boolean);
  const label = parts.length > 1 ? parts[parts.length - 2] : (parts[0] ?? '');
  const digitLeading = label.match(/^(\d+)[^a-z]*([a-z])/i);
  if (digitLeading) return `${digitLeading[1]}${digitLeading[2]}`.slice(0, 4).toLocaleUpperCase();
  const alpha = label.match(/[a-z]/i)?.[0] ?? '';
  const digits = label.match(/\d+/)?.[0] ?? '';
  if (alpha && digits) return `${alpha}${digits}`.slice(0, 4).toLocaleUpperCase();
  const letters = label.match(/[a-z0-9]/gi) ?? [];
  const tldInitial = parts[parts.length - 1]?.match(/[a-z0-9]/i)?.[0] ?? '';
  return `${letters[0] ?? 'E'}${letters[1] ?? (tldInitial || 'X')}`.slice(0, 4).toLocaleUpperCase();
}

function unknownOrganization(domain: string): OrganizationMapping {
  const name = domain || 'External';
  return {
    id: domain ? `domain:${domain}` : 'external',
    domain,
    domainSuffixes: domain ? [domain] : [],
    name,
    monogram: domain ? organizationMonogramForDomain(domain) : '•',
    logoKey: domain ? 'monogram' : 'fallback',
    ariaLabel: `Organization: ${name}`,
    fallback: domain ? 'monogram' : 'building',
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

/**
 * Every organization represented by the full roster, with counts from the
 * roster slice surviving the other active facets. Zero-count options remain so
 * a narrowed result never removes the control needed to switch organizations.
 */
export function organizationOptionsForEmails(
  representedEmails: readonly string[],
  countedEmails: readonly string[],
  mappings: readonly OrganizationMapping[] = []
): OrganizationFilterOption[] {
  const represented = new Map<string, OrganizationFilterOption>();
  for (const email of representedEmails) {
    const organization = organizationForEmail(email, mappings);
    if (!represented.has(organization.id)) represented.set(organization.id, { ...organization, count: 0 });
  }
  for (const email of countedEmails) {
    const organization = organizationForEmail(email, mappings);
    const current = represented.get(organization.id);
    if (current) current.count += 1;
  }
  return [...represented.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  );
}

/** Organizations represented by the supplied Identity-roster addresses only. */
export function organizationsForEmails(
  emails: readonly string[],
  mappings: readonly OrganizationMapping[] = []
): OrganizationFilterOption[] {
  return organizationOptionsForEmails(emails, emails, mappings);
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
