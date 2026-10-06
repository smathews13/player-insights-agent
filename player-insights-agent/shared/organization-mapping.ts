import {
  normalizedOrganizationDomain,
  sanitizeOrganizationMappings,
  type OrganizationFilterOption,
  type OrganizationMapping,
  type OrganizationProfile,
  organizationProfileDomain,
  organizationProfileMonogram,
  organizationProfileName,
} from './organization-contract';

export {
  organizationMappingsFromFilterOptions,
  sanitizeOrganizationFilterOptions,
  sanitizeOrganizationMappings,
  type OrganizationFilterOption,
  type OrganizationLogoKey,
  type OrganizationMapping,
  type OrganizationProfile,
  type OrganizationProfileRow,
  type OrganizationProfilesPayload,
  organizationProfileDomain,
  organizationProfileMonogram,
  organizationProfileName,
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
    name: 'Take-Two Interactive',
    monogram: 'T2',
    logoKey: 'acme',
    ariaLabel: 'Organization: Take-Two Interactive',
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

/**
 * Canonical entries first, then configured ones. A configured entry that reuses a
 * canonical id may relabel it (name, mark, accessible label) and nothing else: the
 * id, domains, logo and fallback stay canonical, so an edited label reaches every
 * reader without a configuration being able to swap a company's logo or claim its
 * domains. Among configured entries the first one for an id wins.
 */
function mergedOrganizationManifest(configured: readonly OrganizationMapping[]): OrganizationMapping[] {
  const byId = new Map<string, OrganizationMapping>(ORGANIZATION_MANIFEST.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  for (const organization of configured) {
    if (seen.has(organization.id)) continue;
    seen.add(organization.id);
    const canonical = byId.get(organization.id);
    byId.set(
      organization.id,
      canonical
        ? {
            ...canonical,
            name: organization.name,
            monogram: organization.monogram,
            ariaLabel: organization.ariaLabel,
          }
        : organization
    );
  }
  return [...byId.values()];
}

/**
 * Lay admin-edited profiles over a merged list.
 *
 * A profile addresses an organization by one of its registered domains. When an
 * entry already registers that exact domain, only its label and mark change; its
 * id, logo and other domains stay, so conversation attribution and filters keep
 * resolving to the same organization. A domain nothing registers becomes a new
 * monogram organization.
 */
export function applyOrganizationProfiles(
  base: readonly OrganizationMapping[],
  profiles: readonly OrganizationProfile[]
): OrganizationMapping[] {
  const result = [...base];
  for (const profile of profiles) {
    const domain = organizationProfileDomain(profile.domain);
    const name = organizationProfileName(profile.name);
    const monogram = organizationProfileMonogram(profile.monogram);
    if (!domain || !name || !monogram) continue;
    const index = result.findIndex((entry) => entry.domainSuffixes.includes(domain));
    if (index >= 0) {
      result[index] = { ...result[index], name, monogram, ariaLabel: `Organization: ${name}` };
    } else {
      result.push({
        id: `domain:${domain}`,
        domain,
        domainSuffixes: [domain],
        name,
        monogram,
        logoKey: 'monogram',
        ariaLabel: `Organization: ${name}`,
        fallback: 'monogram',
      });
    }
  }
  return result;
}

/** Canonical entries plus safe deployment-provided organizations, then admin-edited profiles. */
export function parseOrganizationMappings(
  raw: string | undefined | null,
  profiles: readonly OrganizationProfile[] = []
): OrganizationMapping[] {
  let base: OrganizationMapping[] = [...ORGANIZATION_MANIFEST];
  if (raw?.trim()) {
    try {
      base = mergedOrganizationManifest(sanitizeOrganizationMappings(JSON.parse(raw)));
    } catch {
      base = [...ORGANIZATION_MANIFEST];
    }
  }
  return profiles.length > 0 ? applyOrganizationProfiles(base, profiles) : base;
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

/** Exact domain or dot-boundary suffix match after normalization. */
export function organizationDomainMatchesSuffixes(domain: string, suffixes: readonly string[]): boolean {
  const normalizedDomain = normalizedOrganizationDomain(domain);
  if (!normalizedDomain) return false;
  return suffixes.some((suffix) => {
    const normalizedSuffix = normalizedOrganizationDomain(suffix);
    return Boolean(normalizedSuffix) && suffixMatch(normalizedDomain, normalizedSuffix);
  });
}

/**
 * Case-insensitive longest-suffix resolution.
 *
 * Unknown domains never inherit a nearby brand: only an exact suffix boundary
 * matches.
 */
export function organizationForDomain(
  value: string,
  mappings: readonly OrganizationMapping[] = []
): OrganizationMapping {
  const domain = normalizedOrganizationDomain(value);
  const candidates = mergedOrganizationManifest(sanitizeOrganizationMappings(mappings)).flatMap((organization) =>
    organization.domainSuffixes.map((suffix) => ({ organization, suffix }))
  );
  candidates.sort((left, right) => right.suffix.length - left.suffix.length);
  return (
    candidates.find((candidate) => suffixMatch(domain, candidate.suffix))?.organization ?? unknownOrganization(domain)
  );
}

export function organizationForEmail(
  email: string,
  mappings: readonly OrganizationMapping[] = []
): OrganizationMapping {
  return organizationForDomain(emailDomain(email), mappings);
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

/**
 * Full authoritative suffix set for Feedback's canonical-domain selection.
 * Invalid non-empty values intentionally match nothing rather than disabling
 * the filter.
 */
export function organizationSuffixesForDomainSelection(
  selected: string,
  mappings: readonly OrganizationMapping[] = []
): string[] {
  if (!selected.trim()) return [];
  const domain = normalizedOrganizationDomain(selected);
  if (!domain) return ['__no_matching_organization__'];
  const organization = organizationForDomain(domain, mappings);
  return [...new Set(organization.domainSuffixes.map(normalizedOrganizationDomain).filter(Boolean))];
}
