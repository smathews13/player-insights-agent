import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SCIM_ME_PATH,
  SCIM_USERS_PATH,
  SERVICE_PRINCIPAL_METADATA_TTL_MS,
  SERVICE_PRINCIPAL_METADATA_CACHE_MAX_ENTRIES,
  USER_METADATA_TTL_MS,
  USER_METADATA_CACHE_MAX_ENTRIES,
  forgetControlPlaneIdentityMetadata,
  readControlPlaneIdentityMetadata,
  type ControlPlaneReader,
} from './control-plane-identity';
import { APPS_PATH } from './app-metadata';

const INPUT = {
  email: '<your-username>',
  appName: 'player-insights-agent',
  workspaceHost: 'https://dbc-example.cloud.databricks.com',
  applicationId: '071769f1-5623-45b6-a172-c8b0060adf31',
};

afterEach(() => {
  forgetControlPlaneIdentityMetadata();
  vi.restoreAllMocks();
});

function completeReader(calls: string[] = []): ControlPlaneReader {
  return (path, query) => {
    calls.push(`${path}:${query?.filter ?? ''}`);
    if (path === SCIM_ME_PATH) {
      return Promise.resolve({
        id: '9988776655443322',
        applicationId: INPUT.applicationId,
        displayName: 'Astrolabe application service principal',
      });
    }
    if (path === SCIM_USERS_PATH) {
      return Promise.resolve({
        Resources: [
          {
            id: '1122334455667788',
            userName: INPUT.email,
            displayName: 'Example User',
          },
        ],
      });
    }
    if (path === `${APPS_PATH}/${INPUT.appName}`) {
      return Promise.resolve({
        name: INPUT.appName,
        url: 'https://player-insights-agent-<workspace-id>.<region>.databricksapps.com',
      });
    }
    return Promise.reject(new Error('unexpected path'));
  };
}

describe('Databricks control-plane identity metadata', () => {
  it('reports the matching SCIM user, verified app SP, and app deployment context', async () => {
    const metadata = await readControlPlaneIdentityMetadata(INPUT, { read: completeReader(), now: 1_000 });

    expect(metadata).toEqual({
      user: {
        displayName: 'Example User',
        objectId: '1122334455667788',
        state: 'verified',
        readAt: '1970-01-01T00:00:01.000Z',
      },
      app: {
        displayName: 'Astrolabe',
        resourceName: INPUT.appName,
        workspaceHost: INPUT.workspaceHost,
        workspaceId: '<workspace-id>',
      },
      servicePrincipal: {
        displayName: 'Astrolabe application service principal',
        applicationId: INPUT.applicationId,
        objectId: '9988776655443322',
        state: 'verified',
        readAt: '1970-01-01T00:00:01.000Z',
      },
    });
  });

  it('returns Not reported metadata after denied lookups without exposing raw errors or secrets', async () => {
    const read = vi.fn(() =>
      Promise.reject(
        new Error(
          '403 PERMISSION_DENIED authorization: Bearer token-value DATABRICKS_CLIENT_SECRET=do-not-return database-password'
        )
      )
    );
    const metadata = await readControlPlaneIdentityMetadata(INPUT, { read, now: 2_000 });
    const wire = JSON.stringify(metadata);

    expect(metadata.user.state).toBe('not_reported');
    expect(metadata.servicePrincipal).toMatchObject({
      state: 'not_reported',
      displayName: '',
      objectId: '',
      applicationId: INPUT.applicationId,
    });
    expect(metadata.app.workspaceId).toBe('');
    expect(wire).not.toMatch(/Bearer|token-value|CLIENT_SECRET|password|PERMISSION_DENIED/i);
  });

  it('does not trust or derive an SP name when /Me reports a different application id', async () => {
    const read: ControlPlaneReader = (path) => {
      if (path === SCIM_ME_PATH) {
        return Promise.resolve({
          id: 'wrong-object',
          applicationId: 'different-client-id',
          displayName: 'Plausible but wrong principal',
        });
      }
      if (path === SCIM_USERS_PATH) return Promise.resolve({ Resources: [] });
      return Promise.resolve({});
    };
    const metadata = await readControlPlaneIdentityMetadata(INPUT, { read, now: 3_000 });

    expect(metadata.servicePrincipal).toEqual({
      displayName: '',
      applicationId: INPUT.applicationId,
      objectId: '',
      state: 'not_reported',
      readAt: '1970-01-01T00:00:03.000Z',
    });
  });

  it('briefly caches app/SP metadata while isolating each signed-in user', async () => {
    const calls: string[] = [];
    const read = completeReader(calls);
    await readControlPlaneIdentityMetadata(INPUT, { read, now: 10_000 });
    await readControlPlaneIdentityMetadata({ ...INPUT, email: 'other@example.com' }, { read, now: 10_500 });
    await readControlPlaneIdentityMetadata(INPUT, { read, now: 11_000 });

    expect(calls.filter((call) => call.startsWith(SCIM_ME_PATH))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith(`${APPS_PATH}/`))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith(SCIM_USERS_PATH))).toEqual([
      `${SCIM_USERS_PATH}:userName eq ${INPUT.email}`,
      `${SCIM_USERS_PATH}:userName eq other@example.com`,
    ]);
  });

  it('re-reads user and SP metadata at their bounded TTLs', async () => {
    const calls: string[] = [];
    const read = completeReader(calls);
    await readControlPlaneIdentityMetadata(INPUT, { read, now: 0 });
    await readControlPlaneIdentityMetadata(INPUT, { read, now: USER_METADATA_TTL_MS });
    await readControlPlaneIdentityMetadata(INPUT, {
      read,
      now: Math.max(USER_METADATA_TTL_MS, SERVICE_PRINCIPAL_METADATA_TTL_MS),
    });

    expect(calls.filter((call) => call.startsWith(SCIM_USERS_PATH))).toHaveLength(3);
    expect(calls.filter((call) => call.startsWith(SCIM_ME_PATH))).toHaveLength(2);
  });

  it('evicts least-recently-used user and SP metadata at the global cardinality caps', async () => {
    const calls: string[] = [];
    const read = completeReader(calls);
    await readControlPlaneIdentityMetadata(INPUT, { read, now: 0 });
    for (let index = 0; index < USER_METADATA_CACHE_MAX_ENTRIES; index += 1) {
      await readControlPlaneIdentityMetadata(
        {
          ...INPUT,
          email: `person-${index}@example.com`,
          applicationId:
            index < SERVICE_PRINCIPAL_METADATA_CACHE_MAX_ENTRIES
              ? `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
              : INPUT.applicationId,
        },
        { read, now: 1 }
      );
    }
    await readControlPlaneIdentityMetadata(INPUT, { read, now: 2 });

    expect(calls.filter((call) => call === `${SCIM_USERS_PATH}:userName eq ${INPUT.email}`)).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith(SCIM_ME_PATH))).toHaveLength(
      SERVICE_PRINCIPAL_METADATA_CACHE_MAX_ENTRIES + 2
    );
  });
});
