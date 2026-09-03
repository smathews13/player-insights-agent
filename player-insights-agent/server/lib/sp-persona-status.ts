import {
  spGrantKey,
  spGrantSummary,
  type SpGrant,
  type SpGrantVerification,
  type SpPersona,
  type SpPersonaDefinition,
  type SpPersonaDefinitionStatus,
} from '../../shared/sp-identity';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import { mintPersonaToken } from './sp-token';
import type { SpPersonaStatusRecord } from './sp-identity-store';

const CHECK_DEADLINE_MS = 8_000;
const REQUEST_TIMEOUT_MS = 2_500;
const CHECK_CONCURRENCY = 4;

const UC_SECURABLE: Partial<Record<SpGrant['resourceType'], string>> = {
  CATALOG: 'catalog',
  SCHEMA: 'schema',
  TABLE: 'table',
  FUNCTION: 'function',
  REGISTERED_MODEL: 'registered_model',
  VOLUME: 'volume',
};

const WORKSPACE_ACL: Partial<Record<SpGrant['resourceType'], string>> = {
  SERVING_ENDPOINT: 'serving-endpoints',
  SQL_WAREHOUSE: 'warehouses',
};

export interface SpPersonaStatusCheckDeps {
  mint?: typeof mintPersonaToken;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
  deadlineMs?: number;
  requestTimeoutMs?: number;
}

function defaultStatus(detail: string): SpPersonaDefinitionStatus {
  return {
    connection: { state: 'not_connected', checkedAt: null, detail },
    sync: {
      state: 'not_synced',
      checkedAt: null,
      definitionRevision: null,
      detail: 'Run Check status after the service principal is connected.',
      checks: [],
    },
  };
}

/** Convert persisted evidence into the two badges without inferring from names. */
export function statusForSpPersonaDefinition(
  definition: SpPersonaDefinition,
  persona: SpPersona | null,
  record: SpPersonaStatusRecord | null
): SpPersonaDefinitionStatus {
  if (!persona || persona.definitionId !== definition.id) {
    return defaultStatus('No credential reference is linked to this definition.');
  }
  if (!record?.connectionOk) {
    return {
      ...defaultStatus('The stored credential reference has not passed a token-mint check.'),
      connection: {
        state: 'not_connected',
        checkedAt: record?.checkedAt ?? null,
        detail: 'The stored credential reference has not passed a token-mint check.',
      },
      sync: {
        state: 'not_synced',
        checkedAt: record?.checkedAt ?? null,
        definitionRevision: record?.definitionRevision ?? null,
        detail: record?.detail || 'Fix the connection, then run Check status again.',
        checks: record?.checks ?? [],
      },
    };
  }
  const currentRevision = definition.revision ?? 1;
  const current = record.definitionRevision === currentRevision;
  const allVerified = record.checks.length > 0 && record.checks.every((check) => check.state === 'verified');
  return {
    connection: {
      state: 'connected',
      checkedAt: record.checkedAt,
      detail: 'The stored credential reference minted a service-principal token.',
    },
    sync: {
      state: current && allVerified ? 'synced' : 'not_synced',
      checkedAt: record.checkedAt,
      definitionRevision: record.definitionRevision,
      detail: !current
        ? 'Permissions changed after the last check. Run Check status again.'
        : allVerified
          ? 'Every configured permission was verified under the connected service principal.'
          : record.detail || 'One or more configured permissions could not be verified.',
      checks: record.checks,
    },
  };
}

function unsupported(grant: SpGrant): SpGrantVerification {
  return {
    key: spGrantKey(grant),
    label: spGrantSummary(grant),
    state: 'unsupported',
    nextAction: `Verify ${grant.privilege} in Account Console; this resource has no safe read-only grant probe.`,
  };
}

function privilegesFromEffectivePermissions(body: unknown, principal: string): string[] | null {
  if (!body || typeof body !== 'object') return null;
  const assignments = (body as { privilege_assignments?: unknown }).privilege_assignments;
  if (!Array.isArray(assignments)) return null;
  const entries: unknown[] = assignments;
  const wanted = principal.trim().toLocaleLowerCase();
  const match = entries.find((entry) => {
    const named = (entry as { principal?: unknown }).principal;
    return typeof named === 'string' && named.trim().toLocaleLowerCase() === wanted;
  });
  if (!match) return [];
  const privileges = (match as { privileges?: unknown }).privileges;
  if (!Array.isArray(privileges)) return null;
  return privileges.flatMap((entry) => {
    if (typeof entry === 'string') return [entry.toUpperCase().replace(/_/g, ' ')];
    const named = (entry as { privilege?: unknown }).privilege;
    return typeof named === 'string' ? [named.toUpperCase().replace(/_/g, ' ')] : [];
  });
}

function privilegesFromWorkspaceAcl(body: unknown, principal: string): string[] | null {
  if (!body || typeof body !== 'object') return null;
  const acl = (body as { access_control_list?: unknown }).access_control_list;
  if (!Array.isArray(acl)) return null;
  const entries: unknown[] = acl;
  const wanted = principal.trim().toLocaleLowerCase();
  const match = entries.find((entry) => {
    const named = (entry as { service_principal_name?: unknown }).service_principal_name;
    return typeof named === 'string' && named.trim().toLocaleLowerCase() === wanted;
  });
  if (!match) return [];
  const permissions = (match as { all_permissions?: unknown }).all_permissions;
  if (!Array.isArray(permissions)) return null;
  return permissions.flatMap((entry) => {
    const named = (entry as { permission_level?: unknown }).permission_level;
    return typeof named === 'string' ? [named.toUpperCase().replace(/_/g, ' ')] : [];
  });
}

async function fetchJsonWithin(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; body: unknown; timedOut: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      body: response.ok ? await response.json().catch(() => null) : null,
      timedOut: false,
    };
  } catch {
    return { ok: false, status: 0, body: null, timedOut: controller.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}

async function verifyGrant(input: {
  grant: SpGrant;
  persona: SpPersona;
  token: string;
  host: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<SpGrantVerification> {
  const { grant, persona } = input;
  const ucType = UC_SECURABLE[grant.resourceType];
  const aclType = WORKSPACE_ACL[grant.resourceType];
  if (!ucType && !aclType) return unsupported(grant);
  const path = ucType
    ? `/api/2.1/unity-catalog/effective-permissions/${ucType}/${encodeURIComponent(grant.resource)}?principal=${encodeURIComponent(persona.clientId)}`
    : `/api/2.0/permissions/${aclType}/${encodeURIComponent(grant.resource)}`;
  const response = await fetchJsonWithin(
    `${input.host}${path}`,
    input.token,
    input.fetchImpl,
    Math.max(1, input.timeoutMs)
  );
  const nextAction = response.timedOut
    ? 'Retry Check status; the Databricks permission probe timed out.'
    : response.status === 404
      ? 'Confirm the resource identifier, then retry Check status.'
      : 'Verify this permission in Account Console, then retry Check status.';
  if (!response.ok) {
    return { key: spGrantKey(grant), label: spGrantSummary(grant), state: 'unverified', nextAction };
  }
  const privileges = ucType
    ? privilegesFromEffectivePermissions(response.body, persona.clientId)
    : privilegesFromWorkspaceAcl(response.body, persona.clientId);
  if (privileges === null) {
    return { key: spGrantKey(grant), label: spGrantSummary(grant), state: 'unverified', nextAction };
  }
  const verified = privileges.includes(grant.privilege.toUpperCase()) || privileges.includes('ALL PRIVILEGES');
  return {
    key: spGrantKey(grant),
    label: spGrantSummary(grant),
    state: verified ? 'verified' : 'mismatch',
    nextAction: verified ? '' : `Grant ${grant.privilege} on this resource, then retry Check status.`,
  };
}

async function boundedMap<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        output[index] = await work(values[index]);
      }
    })
  );
  return output;
}

async function settleWithin<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Mint, then verify only grants with exact read-only evidence. Unsupported or
 * unreadable grants remain Not synced; no token or raw provider error escapes.
 */
export async function checkSpPersonaDefinitionStatus(
  definition: SpPersonaDefinition,
  persona: SpPersona,
  deps: SpPersonaStatusCheckDeps = {}
): Promise<SpPersonaStatusRecord> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const checkedAt = new Date(startedAt).toISOString();
  const deadlineMs = deps.deadlineMs ?? CHECK_DEADLINE_MS;
  const minted = await settleWithin(
    (deps.mint ?? mintPersonaToken)(persona, { env: deps.env }),
    Math.min(deadlineMs, 5_000)
  );
  if (!minted?.ok) {
    return {
      definitionId: definition.id,
      checkedAt,
      definitionRevision: definition.revision ?? 1,
      connectionOk: false,
      checks: [],
      detail: minted
        ? 'Token mint failed. Confirm the Application ID, secret reference, and app access to that secret.'
        : 'Token mint timed out. Confirm the secret reference, then retry Check status.',
    };
  }
  const host = normalizeWorkspaceHost((deps.env ?? process.env).DATABRICKS_HOST);
  if (!host) {
    return {
      definitionId: definition.id,
      checkedAt,
      definitionRevision: definition.revision ?? 1,
      connectionOk: true,
      checks: [],
      detail: 'The connection worked, but this app has no workspace URL for permission checks.',
    };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const checks = await boundedMap(
    definition.grants ?? [],
    CHECK_CONCURRENCY,
    async (grant): Promise<SpGrantVerification> => {
      const remaining = deadlineMs - (now() - startedAt);
      if (remaining <= 0) {
        return {
          key: spGrantKey(grant),
          label: spGrantSummary(grant),
          state: 'unverified',
          nextAction: 'Retry Check status; the overall permission-check deadline elapsed.',
        };
      }
      return verifyGrant({
        grant,
        persona,
        token: minted.token,
        host,
        fetchImpl,
        timeoutMs: Math.min(deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, remaining),
      });
    }
  );
  for (const capability of definition.legacyCapabilities ?? []) {
    checks.push({
      key: `legacy:${capability}`,
      label: capability,
      state: 'unsupported',
      nextAction: 'Convert this legacy permission to a structured permission, then retry Check status.',
    });
  }
  const allVerified = checks.length > 0 && checks.every((check) => check.state === 'verified');
  return {
    definitionId: definition.id,
    checkedAt,
    definitionRevision: definition.revision ?? 1,
    connectionOk: true,
    checks,
    detail: allVerified
      ? 'Every configured permission was verified.'
      : 'Connection succeeded, but one or more permissions need action.',
  };
}

export const SP_PERSONA_STATUS_LIMITS = {
  deadlineMs: CHECK_DEADLINE_MS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  concurrency: CHECK_CONCURRENCY,
} as const;
