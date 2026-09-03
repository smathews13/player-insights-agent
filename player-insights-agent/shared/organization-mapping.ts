export interface OrganizationMapping {
  domain: string;
  name: string;
  monogram: string;
}

const ORGANIZATION_KEYS = new Set<keyof OrganizationMapping>(['domain', 'name', 'monogram']);

function organizationMapping(value: unknown): OrganizationMapping | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !ORGANIZATION_KEYS.has(key as keyof OrganizationMapping))) return null;
  if (
    typeof candidate.domain !== 'string' ||
    typeof candidate.name !== 'string' ||
    typeof candidate.monogram !== 'string'
  ) {
    return null;
  }
  const domain = candidate.domain.trim().toLocaleLowerCase();
  const name = candidate.name.trim();
  const monogram = candidate.monogram.trim();
  if (!domain || domain.length > 253 || !name || name.length > 120 || !monogram || monogram.length > 4) return null;
  return { domain, name, monogram };
}

export function sanitizeOrganizationMappings(value: unknown): OrganizationMapping[] {
  if (!Array.isArray(value) || value.length > 50) return [];
  const mappings = value.map(organizationMapping);
  return mappings.every((mapping): mapping is OrganizationMapping => mapping !== null) ? mappings : [];
}

/**
 * Organizations for which the application has a verified, committed brand mark.
 *
 * Deployment-provided mappings still supply labels for every other known
 * organization. Databricks is built in because rendering its configured "DB"
 * monogram while the official mark is already shipped with the client makes the
 * same company look like an unknown tenant.
 */
const BUILT_IN_ORGANIZATIONS: readonly OrganizationMapping[] = [
  { domain: 'databricks.com', name: 'Databricks', monogram: 'DB' },
];

export function parseOrganizationMappings(raw: string | undefined | null): OrganizationMapping[] {
  if (!raw?.trim()) return [];
  try {
    return sanitizeOrganizationMappings(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function emailDomain(email: string): string {
  const at = email.trim().lastIndexOf('@');
  return at >= 0
    ? email
        .slice(at + 1)
        .trim()
        .toLocaleLowerCase()
    : '';
}

export function organizationForEmail(email: string, mappings: readonly OrganizationMapping[]): OrganizationMapping {
  const domain = emailDomain(email);
  const builtIn = BUILT_IN_ORGANIZATIONS.find(
    (candidate) => domain === candidate.domain || domain.endsWith(`.${candidate.domain}`)
  );
  if (builtIn) return builtIn;

  const match = sanitizeOrganizationMappings(mappings)
    .sort((left, right) => right.domain.length - left.domain.length)
    .find((candidate) => domain === candidate.domain || domain.endsWith(`.${candidate.domain}`));
  if (match) return match;
  return { domain, name: domain || 'External', monogram: '•' };
}
