import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_ATTACHED_RESOURCE_MAX_RECORDS,
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
        resources: [
          {
            name: 'postgres',
            postgres: {
              branch: 'projects/player-insights/branches/production',
              database: 'databricks-postgres',
              permission: 'CAN_CONNECT_AND_CREATE',
            },
          },
          {
            name: 'serving-endpoint',
            serving_endpoint: { name: 'player-insights-agent', permission: 'CAN_QUERY' },
          },
          {
            name: 'sql-warehouse',
            sql_warehouse: { id: '9cd123456789abcd', permission: 'CAN_USE' },
          },
        ],
        client_secret: 'never-cross-the-wire',
        authorization: 'Bearer never-cross-the-wire',
      });
    }
    return Promise.reject(new Error('unexpected path'));
  };
}

function readerWithResources(resources: unknown): ControlPlaneReader {
  const base = completeReader();
  return (path, query) => {
    if (path !== `${APPS_PATH}/${INPUT.appName}`) return base(path, query);
    return Promise.resolve({
      url: 'https://player-insights-agent-<workspace-id>.<region>.databricksapps.com',
      service_principal_name: 'Astrolabe application',
      service_principal_client_id: 'abcdefab-0000-4000-8000-000000000000',
      service_principal_id: '9988776655443322',
      resources,
    });
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
        attachedResources: [
          {
            resourceKey: 'postgres',
            resourceType: 'postgres',
            displayIdentifier: 'databricks-postgres',
            permission: 'CAN_CONNECT_AND_CREATE',
            title: 'databricks-postgres · branch projects/player-insights/branches/production',
          },
          {
            resourceKey: 'serving-endpoint',
            resourceType: 'serving_endpoint',
            displayIdentifier: 'player-insights-agent',
            permission: 'CAN_QUERY',
          },
          {
            resourceKey: 'sql-warehouse',
            resourceType: 'sql_warehouse',
            displayIdentifier: '9cd123456789abcd',
            permission: 'CAN_USE',
          },
        ],
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

  it('keeps future bindings in manifest order while safely degrading malformed known resources', async () => {
    const metadata = await readControlPlaneIdentityMetadata(INPUT, {
      read: readerWithResources([
        {
          name: 'vector-index-binding',
          vector_search: {
            index_name: 'must-not-be-read-from-an-unknown-shape',
            permission: 'CAN_QUERY',
            api_token: 'future-secret-must-not-cross',
          },
        },
        { name: 'warehouse-fallback', sql_warehouse: { id: null, permission: { raw: true } } },
        { name: 'serving-fallback', serving_endpoint: 'malformed' },
        { name: '\u0000future-binding\u007f', future_kind: { permission: 'CAN_USE', token: 'nested-secret' } },
        null,
      ]),
      now: 5_000,
    });

    expect(metadata.servicePrincipal.attachedResources).toEqual([
      {
        resourceKey: 'vector-index-binding',
        resourceType: 'vector_search',
        displayIdentifier: 'vector-index-binding',
        permission: 'CAN_QUERY',
      },
      {
        resourceKey: 'warehouse-fallback',
        resourceType: 'sql_warehouse',
        displayIdentifier: 'warehouse-fallback',
        permission: '',
      },
      {
        resourceKey: 'serving-fallback',
        resourceType: 'serving_endpoint',
        displayIdentifier: 'serving-fallback',
        permission: '',
      },
      {
        resourceKey: 'future-binding',
        resourceType: 'future_kind',
        displayIdentifier: 'future-binding',
        permission: 'CAN_USE',
      },
    ]);
    expect(JSON.stringify(metadata)).not.toMatch(
      /must-not-be-read|future-secret|nested-secret|\[object Object\]|attachedResourceCount/i
    );
  });

  it('reports no attached resources when the Apps response omits the collection', async () => {
    const metadata = await readControlPlaneIdentityMetadata(INPUT, {
      read: readerWithResources(undefined),
      now: 6_000,
    });

    expect(metadata.servicePrincipal.attachedResources).toEqual([]);
    expect(metadata.servicePrincipal).not.toHaveProperty('attachedResourceCount');
  });

  it('bounds cached resource metadata without changing manifest order', async () => {
    const resources = Array.from({ length: APP_ATTACHED_RESOURCE_MAX_RECORDS + 5 }, (_, index) => ({
      name: `binding-${index}`,
      future_kind: { permission: 'CAN_USE' },
    }));
    const metadata = await readControlPlaneIdentityMetadata(INPUT, {
      read: readerWithResources(resources),
      now: 7_000,
    });

    expect(metadata.servicePrincipal.attachedResources).toHaveLength(APP_ATTACHED_RESOURCE_MAX_RECORDS);
    expect(metadata.servicePrincipal.attachedResources[0]?.resourceKey).toBe('binding-0');
    expect(
      metadata.servicePrincipal.attachedResources[metadata.servicePrincipal.attachedResources.length - 1]?.resourceKey
    ).toBe(`binding-${APP_ATTACHED_RESOURCE_MAX_RECORDS - 1}`);
  });
});
