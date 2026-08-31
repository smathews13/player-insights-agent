import { z } from 'zod';

export const OrganizationMappingSchema = z
  .object({
    domain: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .transform((value) => value.toLocaleLowerCase()),
    name: z.string().trim().min(1).max(120),
    monogram: z.string().trim().min(1).max(4),
  })
  .strict();

export const OrganizationMappingsSchema = z.array(OrganizationMappingSchema).max(50);
export type OrganizationMapping = z.infer<typeof OrganizationMappingSchema>;

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
    const parsed = OrganizationMappingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
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
  const match = [...BUILT_IN_ORGANIZATIONS, ...mappings]
    .sort((left, right) => right.domain.length - left.domain.length)
    .find((candidate) => domain === candidate.domain || domain.endsWith(`.${candidate.domain}`));
  if (match) return match;
  return { domain, name: domain || 'External', monogram: '•' };
}
