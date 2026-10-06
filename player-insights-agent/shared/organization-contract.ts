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

/** An admin-edited label for one email domain. The logo of a built-in organization is kept. */
export interface OrganizationProfile {
  domain: string;
  name: string;
  monogram: string;
}

/** One organization as the Identity editor lists it. */
export interface OrganizationProfileRow {
  /** The domain the row is edited and reset by. */
  domain: string;
  /** Every email domain that resolves to this organization. */
  domains: string[];
  name: string;
  monogram: string;
  logoKey: OrganizationLogoKey;
  /** Where the organization comes from: shipped with the app, set by the deployment, or added by an admin. */
  source: 'built-in' | 'deployment' | 'admin';
  /** True while an admin edit is in force, so the row can be reset. */
  customized: boolean;
  /** The label without the admin edit, for built-in and deployment organizations. */
  defaultName: string;
  updatedBy: string;
  updatedAt: string;
}

export interface OrganizationProfilesPayload {
  organizations: OrganizationProfileRow[];
}

/** Accepts `databricks.com`, `@example.com` or a pasted address; stores the bare domain. */
export function organizationProfileDomain(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf('@');
  return normalizedOrganizationDomain(at >= 0 ? trimmed.slice(at + 1) : trimmed);
}

function hasControlOrMarkup(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || char === '<' || char === '>') return true;
  }
  return false;
}

export function organizationProfileName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const name = value.replace(/\s+/g, ' ').trim();
  return name.length > 0 && name.length <= 120 && !hasControlOrMarkup(name) ? name : '';
}

/** The mark drawn when a profile has no logo: 1 to 4 visible characters, uppercased. */
export function organizationProfileMonogram(value: unknown): string {
  if (typeof value !== 'string') return '';
  const monogram = value.trim();
  return monogram.length > 0 && monogram.length <= 4 && !/\s/.test(monogram) && !hasControlOrMarkup(monogram)
    ? monogram.toLocaleUpperCase()
    : '';
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
    !suffixes.includes(domain) ||
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
  return options.filter((option): option is OrganizationFilterOption => option !== null);
}

/**
 * Project represented filter options back across the mapping trust boundary.
 *
 * Only filter options that already passed the strict transport decoder are
 * projected, and `count` is removed before the canonical mapping decoder runs.
 */
export function organizationMappingsFromFilterOptions(value: unknown): OrganizationMapping[] {
  const mappings = sanitizeOrganizationFilterOptions(value).map(
    ({ id, domain, domainSuffixes, name, monogram, logoKey, ariaLabel, fallback }) => ({
      id,
      domain,
      domainSuffixes,
      name,
      monogram,
      logoKey,
      ariaLabel,
      fallback,
    })
  );
  return sanitizeOrganizationMappings(mappings);
}
