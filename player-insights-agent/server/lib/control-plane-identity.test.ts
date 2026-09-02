import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SCIM_USERS_PATH,
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
};

afterEach(() => {
  forgetControlPlaneIdentityMetadata();
  vi.restoreAllMocks();
});

function completeReader(calls: string[] = []): ControlPlaneReader {
  return (path, query) => {
    calls.push(`${path}:${query?.filter ?? ''}`);
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
        service_principal_name: 'Astrolabe application',
        service_principal_client_id: 'abcdefab-0000-4000-8000-000000000000',
        service_principal_id: '9988776655443322',
        resources: [{ name: 'warehouse' }, { name: 'serving' }],
        client_secret: 'never-cross-the-wire',
        authorization: 'Bearer never-cross-the-wire',
      });
    }
    return Promise.reject(new Error('unexpected path'));
  };
}

describe('Databricks control-plane identity metadata', () => {
  it('reports the matching SCIM user and app deployment context only', async () => {
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
        displayName: 'Astrolabe application',
        applicationId: 'abcdefab-0000-4000-8000-000000000000',
        objectId: '9988776655443322',
        authenticationType: 'OAuth machine-to-machine',
        attachedResourceCount: 2,
        state: 'verified',
      },
    });
  });

  it('returns safe empty user/app metadata after denied lookups without exposing raw errors or secrets', async () => {
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
    expect(metadata.app.workspaceId).toBe('');
    expect(metadata.servicePrincipal.state).toBe('not_reported');
    expect(wire).not.toMatch(/Bearer|token-value|CLIENT_SECRET|password|PERMISSION_DENIED/i);
  });

  it('briefly caches app metadata while isolating each signed-in user', async () => {
    const calls: string[] = [];
    const read = completeReader(calls);
    await readControlPlaneIdentityMetadata(INPUT, { read, now: 10_000 });
    await readControlPlaneIdentityMetadata({ ...INPUT, email: 'other@example.com' }, { read, now: 10_500 });
    await readControlPlaneIdentityMetadata(INPUT, { read, now: 11_000 });

    expect(calls.filter((call) => call.startsWith(`${APPS_PATH}/`))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith(SCIM_USERS_PATH))).toEqual([
      `${SCIM_USERS_PATH}:userName eq ${INPUT.email}`,
      `${SCIM_USERS_PATH}:userName eq other@example.com`,
    ]);
  });

  it('re-reads user metadata at its bounded TTL', async () => {
    const calls: string[] = [];
    const read = completeReader(calls);
    await readControlPlaneIdentityMetadata(INPUT, { read, now: 0 });
    await readControlPlaneIdentityMetadata(INPUT, { read, now: USER_METADATA_TTL_MS });

    expect(calls.filter((call) => call.startsWith(SCIM_USERS_PATH))).toHaveLength(2);
  });

  it('evicts least-recently-used user metadata at the global cardinality cap', async () => {
    const calls: string[] = [];
    const read = completeReader(calls);
    await readControlPlaneIdentityMetadata(INPUT, { read, now: 0 });
    for (let index = 0; index < USER_METADATA_CACHE_MAX_ENTRIES; index += 1) {
      await readControlPlaneIdentityMetadata(
        {
          ...INPUT,
          email: `person-${index}@example.com`,
        },
        { read, now: 1 }
      );
    }
    await readControlPlaneIdentityMetadata(INPUT, { read, now: 2 });

    expect(calls.filter((call) => call === `${SCIM_USERS_PATH}:userName eq ${INPUT.email}`)).toHaveLength(2);
  });

  it('returns only the sanitized application principal fields from the Apps record', async () => {
    const calls: string[] = [];
    const metadata = await readControlPlaneIdentityMetadata(INPUT, { read: completeReader(calls), now: 4_000 });
    const wire = JSON.stringify(metadata);

    expect(calls).not.toContain('/api/2.0/preview/scim/v2/Me:');
    expect(metadata.servicePrincipal.applicationId).toBe('abcdefab-0000-4000-8000-000000000000');
    expect(wire).not.toMatch(/clientSecret|client_secret|authorization|bearer|databasePassword|never-cross-the-wire/i);
  });
});
