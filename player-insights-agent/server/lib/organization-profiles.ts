import type { NextFunction, Request, Response } from 'express';
import { APP_SCHEMA } from '../../shared/app-schema';
import {
  organizationProfileDomain,
  organizationProfileMonogram,
  organizationProfileName,
  parseOrganizationMappings,
  type OrganizationMapping,
  type OrganizationProfile,
} from '../../shared/organization-mapping';
import { columnText, normalizeAdminEmail, type AdminStore } from './admin-identity';

export const ORGANIZATION_PROFILES_TABLE = `${APP_SCHEMA}.organization_profiles`;
export const ORGANIZATION_PROFILES_DDL = `CREATE TABLE IF NOT EXISTS ${ORGANIZATION_PROFILES_TABLE} (
  domain TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monogram TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

export interface StoredOrganizationProfile extends OrganizationProfile {
  updatedBy: string;
  updatedAt: string;
}

export async function readOrganizationProfiles(store: AdminStore): Promise<StoredOrganizationProfile[]> {
  const result = await store.query(
    `SELECT domain, name, monogram, updated_by, updated_at FROM ${ORGANIZATION_PROFILES_TABLE} ORDER BY domain ASC`
  );
  return result.rows.flatMap((row) => {
    const domain = organizationProfileDomain(columnText(row.domain));
    const name = organizationProfileName(columnText(row.name));
    const monogram = organizationProfileMonogram(columnText(row.monogram));
    if (!domain || !name || !monogram) return [];
    return [
      {
        domain,
        name,
        monogram,
        updatedBy: normalizeAdminEmail(columnText(row.updated_by)),
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : columnText(row.updated_at),
      },
    ];
  });
}

export async function writeOrganizationProfile(
  store: AdminStore,
  input: OrganizationProfile & { actor: string }
): Promise<void> {
  await store.query(
    `INSERT INTO ${ORGANIZATION_PROFILES_TABLE} (domain, name, monogram, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (domain) DO UPDATE
       SET name = EXCLUDED.name,
           monogram = EXCLUDED.monogram,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
    [input.domain, input.name, input.monogram, normalizeAdminEmail(input.actor)]
  );
}

export async function deleteOrganizationProfile(store: AdminStore, domain: string): Promise<void> {
  await store.query(`DELETE FROM ${ORGANIZATION_PROFILES_TABLE} WHERE domain = $1`, [domain]);
}

/**
 * The profiles every request reads, kept in memory.
 *
 * Resolving an email to an organization happens in a dozen synchronous places, so
 * the stored profiles are loaded ahead of the request that needs them and read
 * from here. A write refreshes this process immediately; another instance picks
 * the change up within REFRESH_MS.
 */
const REFRESH_MS = 15_000;
let cached: readonly OrganizationProfile[] = [];
let loadedAt = 0;
let inflight: Promise<void> | null = null;
let lastWarning = '';

export function cachedOrganizationProfiles(): readonly OrganizationProfile[] {
  return cached;
}

/** The mappings every reader resolves against: built-ins, deployment config, then admin edits. */
export function currentOrganizationMappings(): OrganizationMapping[] {
  return parseOrganizationMappings(process.env.PLAYER_INSIGHTS_ORGANIZATIONS, cached);
}

export function setCachedOrganizationProfiles(profiles: readonly OrganizationProfile[]): void {
  cached = profiles.map(({ domain, name, monogram }) => ({ domain, name, monogram }));
  loadedAt = Date.now();
}

export function resetOrganizationProfileCache(): void {
  cached = [];
  loadedAt = 0;
  inflight = null;
  lastWarning = '';
}

export function refreshOrganizationProfiles(store: AdminStore, force = false): Promise<void> {
  if (!force && loadedAt > 0 && Date.now() - loadedAt < REFRESH_MS) return Promise.resolve();
  if (inflight) return inflight;
  inflight = readOrganizationProfiles(store)
    .then((profiles) => {
      lastWarning = '';
      setCachedOrganizationProfiles(profiles);
    })
    .catch((error) => {
      // Keep serving the last good copy, and wait a full interval before asking
      // again so a missing table is not queried on every request.
      loadedAt = Date.now();
      const message = (error as Error).message;
      if (message !== lastWarning) {
        lastWarning = message;
        console.warn('[organizations] Stored organization profiles could not be read:', message);
      }
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Keeps the in-memory profiles fresh without ever failing a request.
 *
 * The first request waits for the initial read so a freshly started instance does
 * not answer once with unedited labels; after that the refresh runs in the
 * background.
 */
export function organizationProfileRefresh(store: AdminStore) {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    const pending = refreshOrganizationProfiles(store);
    if (loadedAt === 0) void pending.then(() => next());
    else next();
  };
}
