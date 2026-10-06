/**
 * Organization profiles: the name and mark an email domain resolves to.
 *
 * UNDER `/api/admin`, which the role gate already refuses to consumers, so both
 * administrator ranks may edit and nothing here checks a role. An edit is a row in
 * Lakebase keyed by email domain; it takes effect on the next request and needs no
 * redeploy. Resetting deletes the row and the built-in or deployment label returns.
 */
import { z } from 'zod';
import type { Request, Response } from 'express';
import { recordAdminAction } from '../lib/admin-roles';
import {
  deleteOrganizationProfile,
  readOrganizationProfiles,
  refreshOrganizationProfiles,
  writeOrganizationProfile,
  type StoredOrganizationProfile,
} from '../lib/organization-profiles';
import {
  applyOrganizationProfiles,
  ORGANIZATION_MANIFEST,
  organizationMonogramForDomain,
  organizationProfileDomain,
  organizationProfileMonogram,
  organizationProfileName,
  parseOrganizationMappings,
  type OrganizationMapping,
  type OrganizationProfileRow,
  type OrganizationProfilesPayload,
} from '../../shared/organization-mapping';
import { userEmail, type InsightsAppKit } from './insights-routes';

/** Below the 50-entry decoder limit, leaving room for built-in and deployment entries. */
const MAX_STORED_PROFILES = 40;

const ProfileBody = z.strictObject({
  domain: z.string().max(320),
  name: z.string().max(200),
  monogram: z.string().max(16).optional(),
});

export function organizationProfileRows(
  base: readonly OrganizationMapping[],
  profiles: readonly StoredOrganizationProfile[]
): OrganizationProfileRow[] {
  const effective = applyOrganizationProfiles(base, profiles);
  const builtInIds = new Set(ORGANIZATION_MANIFEST.map((entry) => entry.id));
  return effective.map((entry, index) => {
    const original = index < base.length ? base[index] : null;
    const matching = profiles.filter((profile) => entry.domainSuffixes.includes(profile.domain));
    const latest = [...matching].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return {
      domain: entry.domain,
      domains: [...entry.domainSuffixes],
      name: entry.name,
      monogram: entry.monogram,
      logoKey: entry.logoKey,
      source: !original ? 'admin' : builtInIds.has(entry.id) ? 'built-in' : 'deployment',
      customized: matching.length > 0,
      defaultName: original?.name ?? entry.name,
      updatedBy: latest?.updatedBy ?? '',
      updatedAt: latest?.updatedAt ?? '',
    };
  });
}

export function setupOrganizationRoutes(appkit: InsightsAppKit): void {
  const store = appkit.lakebase;

  async function payload(): Promise<OrganizationProfilesPayload> {
    const profiles = await readOrganizationProfiles(store);
    const base = parseOrganizationMappings(process.env.PLAYER_INSIGHTS_ORGANIZATIONS);
    return { organizations: organizationProfileRows(base, profiles) };
  }

  async function reply(res: Response): Promise<void> {
    await refreshOrganizationProfiles(store, true);
    res.json(await payload());
  }

  function unavailable(res: Response, error: unknown, action: string): void {
    console.error(`[organizations] ${action}:`, (error as Error).message);
    res.status(503).json({
      error: 'organization_profiles_unavailable',
      detail: `${action}. Lakebase is not answering, so nothing was changed.`,
    });
  }

  appkit.server.extend((app) => {
    app.get('/api/admin/organizations', async (_req: Request, res: Response) => {
      try {
        res.json(await payload());
      } catch (error) {
        unavailable(res, error, 'Organizations could not be read');
      }
    });

    app.put('/api/admin/organizations', async (req: Request, res: Response) => {
      const parsed = ProfileBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_organization', detail: 'Send a domain and an organization name.' });
        return;
      }
      const domain = organizationProfileDomain(parsed.data.domain);
      if (!domain) {
        res.status(400).json({
          error: 'invalid_organization_domain',
          detail: 'Enter an email domain such as databricks.com. Letters, digits, dots and hyphens only.',
        });
        return;
      }
      const name = organizationProfileName(parsed.data.name);
      if (!name) {
        res.status(400).json({
          error: 'invalid_organization_name',
          detail: 'Enter an organization name of up to 120 characters, without angle brackets.',
        });
        return;
      }
      const suppliedMonogram = parsed.data.monogram?.trim() ?? '';
      const known = parseOrganizationMappings(process.env.PLAYER_INSIGHTS_ORGANIZATIONS).find((entry) =>
        entry.domainSuffixes.includes(domain)
      );
      const monogram = organizationProfileMonogram(
        suppliedMonogram || known?.monogram || organizationMonogramForDomain(domain)
      );
      if (!monogram) {
        res.status(400).json({
          error: 'invalid_organization_monogram',
          detail: 'The short mark is 1 to 4 characters with no spaces.',
        });
        return;
      }
      const actor = userEmail(req);
      try {
        const existing = await readOrganizationProfiles(store);
        const base = parseOrganizationMappings(process.env.PLAYER_INSIGHTS_ORGANIZATIONS);
        const owner = base.find((entry) => entry.domainSuffixes.includes(domain));
        const siblings = existing.filter((profile) => owner?.domainSuffixes.includes(profile.domain));
        const isNew = !existing.some((profile) => profile.domain === domain);
        if (isNew && !owner && existing.length >= MAX_STORED_PROFILES) {
          res.status(409).json({
            error: 'organization_limit',
            detail: `At most ${MAX_STORED_PROFILES} added organizations are supported. Remove one first.`,
          });
          return;
        }
        await writeOrganizationProfile(store, { domain, name, monogram, actor });
        for (const sibling of siblings) {
          if (sibling.domain !== domain) await deleteOrganizationProfile(store, sibling.domain);
        }
        await recordAdminAction(store, {
          actor,
          action: 'organization-profile-saved',
          subject: domain,
          detail: `${actor} set email domain ${domain} to organization "${name}" (${monogram}).`,
        });
        await reply(res);
      } catch (error) {
        unavailable(res, error, 'The organization could not be saved');
      }
    });

    app.delete('/api/admin/organizations/:domain', async (req: Request, res: Response) => {
      const domain = organizationProfileDomain(req.params.domain ?? '');
      if (!domain) {
        res.status(400).json({ error: 'invalid_organization_domain', detail: 'Enter an email domain.' });
        return;
      }
      const actor = userEmail(req);
      try {
        const existing = await readOrganizationProfiles(store);
        const base = parseOrganizationMappings(process.env.PLAYER_INSIGHTS_ORGANIZATIONS);
        const owner = base.find((entry) => entry.domainSuffixes.includes(domain));
        const doomed = existing.filter(
          (profile) => profile.domain === domain || owner?.domainSuffixes.includes(profile.domain)
        );
        if (doomed.length === 0) {
          res.status(404).json({ error: 'organization_not_edited', detail: 'No admin edit exists for that domain.' });
          return;
        }
        for (const profile of doomed) await deleteOrganizationProfile(store, profile.domain);
        await recordAdminAction(store, {
          actor,
          action: 'organization-profile-reset',
          subject: domain,
          detail: owner
            ? `${actor} reset ${domain} to the ${owner.name} default.`
            : `${actor} removed the organization added for ${domain}.`,
        });
        await reply(res);
      } catch (error) {
        unavailable(res, error, 'The organization could not be reset');
      }
    });
  });
}
