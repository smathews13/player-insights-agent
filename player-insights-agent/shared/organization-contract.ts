export type OrganizationLogoKey = 'databricks' | 'acme' | '2k' | 'northwind' | 'monogram' | 'fallback';

export interface OrganizationMapping {
  id: string;
  domain: string;
  domainSuffixes: string[];
  name: string;
  monogram: string;
  logoKey: OrganizationLogoKey;
  ariaLabel: string;
  fallback: 'building' | 'monogram';
}

export interface OrganizationFilterOption extends OrganizationMapping {
  count: number;
}

const ORGANIZATION_KEYS = new Set<keyof OrganizationMapping>([
  'id',
  'domain',
  'domainSuffixes',
  'name',
  'monogram',
  'logoKey',
  'ariaLabel',
  'fallback',
]);
const LEGACY_ORGANIZATION_KEYS = new Set(['domain', 'name', 'monogram']);
const ORGANIZATION_LOGO_KEYS = new Set<OrganizationLogoKey>([
  'databricks',
  'acme',
  '2k',
  'northwind',
  'monogram',
  'fallback',
]);

export function normalizedOrganizationDomain(value: unknown): string {
  if (typeof value !== 'string') return '';
  const domain = value
    .trim()
    .toLocaleLowerCase()
    .replace(/^\.+|\.+$/g, '');
  if (!domain || domain.length > 253 || !domain.includes('.') || /[^a-z0-9.-]/.test(domain)) return '';
  return domain;
}

function normalizedId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const id = value.trim().toLocaleLowerCase();
  return id && id.length <= 120 && /^[a-z0-9][a-z0-9:.-]*$/.test(id) ? id : '';
}

function configuredOrganization(value: unknown): OrganizationMapping | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  const legacy = keys.every((key) => LEGACY_ORGANIZATION_KEYS.has(key));
  const complete = keys.every((key) => ORGANIZATION_KEYS.has(key as keyof OrganizationMapping));
  if (!legacy && !complete) return null;
  if (
    typeof candidate.domain !== 'string' ||
    typeof candidate.name !== 'string' ||
    typeof candidate.monogram !== 'string'
  ) {
    return null;
  }
  const domain = normalizedOrganizationDomain(candidate.domain);
  const name = candidate.name.trim();
  const monogram = candidate.monogram.trim();
  if (!domain || !name || name.length > 120 || !monogram || monogram.length > 4) return null;

  if (legacy) {
    return {
      id: `domain:${domain}`,
      domain,
      domainSuffixes: [domain],
      name,
      monogram,
      logoKey: 'monogram',
      ariaLabel: `Organization: ${name}`,
      fallback: 'monogram',
    };
  }

  const suffixes = Array.isArray(candidate.domainSuffixes)
    ? [...new Set(candidate.domainSuffixes.map(normalizedOrganizationDomain).filter(Boolean))]
    : [];
  const id = normalizedId(candidate.id);
  const logoKey =
    typeof candidate.logoKey === 'string' && ORGANIZATION_LOGO_KEYS.has(candidate.logoKey as OrganizationLogoKey)
      ? (candidate.logoKey as OrganizationLogoKey)
      : null;
  if (
    !id ||
    suffixes.length === 0 ||
    suffixes.length > 30 ||
    !logoKey ||
    candidate.ariaLabel !== `Organization: ${name}` ||
    (candidate.fallback !== 'building' && candidate.fallback !== 'monogram')
  ) {
    return null;
  }
  return {
    id,
    domain,
    domainSuffixes: suffixes,
    name,
    monogram,
    logoKey,
    ariaLabel: candidate.ariaLabel,
    fallback: candidate.fallback,
  };
}

export function sanitizeOrganizationMappings(value: unknown): OrganizationMapping[] {
  if (!Array.isArray(value) || value.length > 50) return [];
  const mappings = value.map(configuredOrganization);
  return mappings.every((mapping): mapping is OrganizationMapping => mapping !== null) ? mappings : [];
}

/**
 * Trust-boundary decoder for represented organization options.
 *
 * Filter options intentionally add one field to the canonical mapping shape.
 * Feeding them through `sanitizeOrganizationMappings` rejects that `count`
 * field as unknown and silently empties the whole menu.
 */
export function sanitizeOrganizationFilterOptions(value: unknown): OrganizationFilterOption[] {
  if (!Array.isArray(value) || value.length > 50) return [];
  const options = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const { count, ...mapping } = entry as Record<string, unknown>;
    const organization = configuredOrganization(mapping);
    if (!organization || typeof count !== 'number' || !Number.isFinite(count)) return null;
    return { ...organization, count: Math.max(0, Math.trunc(count)) };
  });
  return options.every((option): option is OrganizationFilterOption => option !== null) ? options : [];
}
