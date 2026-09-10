import { describe, expect, it, vi } from 'vitest';
import {
  alignRosterWithAppAccess,
  appAccessPrincipals,
  grantAppUse,
  readAppAccess,
  revokeDirectAppUse,
  type AppAccessOptions,
} from './app-access-roster';
import type { RosterPayload } from '../../shared/user-roster-contract';

const options: AppAccessOptions = {
  host: 'https://workspace.example',
  appName: 'astrolabe',
  userToken: 'obo-token',
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestBody(call: ReturnType<typeof vi.fn<typeof fetch>>, index: number): unknown {
  const body = call.mock.calls[index]?.[1]?.body;
  if (typeof body !== 'string') throw new Error(`Request ${index} carried no JSON string body.`);
  return JSON.parse(body) as unknown;
}

const acl = {
  access_control_list: [
    {
      user_name: 'reader@example.com',
      display_name: 'Reader',
      all_permissions: [{ permission_level: 'CAN_USE', inherited: false }],
    },
    {
      user_name: 'owner@example.com',
      all_permissions: [{ permission_level: 'CAN_MANAGE', inherited: false }],
    },
    {
      group_name: 'Executives',
      all_permissions: [{ permission_level: 'CAN_USE', inherited: true }],
    },
    {
      service_principal_name: 'service-principal-id',
      all_permissions: [{ permission_level: 'CAN_USE', inherited: false }],
    },
  ],
};

const roster: RosterPayload = {
  entries: [
    {
      email: 'owner@example.com',
      role: 'super_admin',
      isDeploymentOwner: true,
      seedFloor: 'consumer',
      setBy: 'seed@example.com',
      setAt: '2026-09-09T00:00:00.000Z',
      isYou: true,
      assignable: ['admin', 'consumer'],
      canRemove: true,
    },
    {
      email: 'pia-only@example.com',
      role: 'admin',
      isDeploymentOwner: false,
      seedFloor: 'consumer',
      setBy: 'owner@example.com',
      setAt: '2026-09-09T00:00:00.000Z',
      isYou: false,
      assignable: ['super_admin', 'consumer'],
      canRemove: true,
    },
  ],
  storedRosterReadable: true,
  roleColumnPresent: true,
  pendingSchemaStatement: '',
  superAdminCount: 1,
  recoveryStatement: '',
};

describe('Databricks App access roster', () => {
  it('overlays PIA roles on explicit App users and adds ACL-only users as consumers', () => {
    const aligned = alignRosterWithAppAccess(roster, {
      available: true,
      principals: appAccessPrincipals(acl),
      message: '',
    });
    expect(aligned.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: 'owner@example.com',
          role: 'super_admin',
          appAccess: 'can_manage',
          canRemove: false,
        }),
        expect.objectContaining({
          email: 'pia-only@example.com',
          role: 'admin',
          appAccess: 'missing',
        }),
        expect.objectContaining({
          email: 'reader@example.com',
          role: 'consumer',
          setBy: 'Databricks App permissions',
          appAccess: 'can_use',
          canRemove: true,
        }),
      ])
    );
    expect(aligned.appAccessPrincipals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'group', name: 'Executives' }),
        expect.objectContaining({ kind: 'service_principal', name: 'service-principal-id' }),
      ])
    );
  });

  it('keeps the PIA roster visible and marks access unknown when the ACL cannot be read', () => {
    const aligned = alignRosterWithAppAccess(roster, {
      available: false,
      principals: [],
      message: 'access-management scope missing',
    });
    expect(aligned.entries).toHaveLength(2);
    expect(aligned.entries.every((entry) => entry.appAccess === 'unknown')).toBe(true);
    expect(aligned.appAccessAvailable).toBe(false);
  });

  it('keeps user, group, and service-principal access separate and records provenance', () => {
    expect(appAccessPrincipals(acl)).toEqual([
      {
        kind: 'group',
        name: 'Executives',
        displayName: 'Executives',
        directPermission: null,
        effectivePermission: 'CAN_USE',
        inherited: true,
      },
      {
        kind: 'service_principal',
        name: 'service-principal-id',
        displayName: 'service-principal-id',
        directPermission: 'CAN_USE',
        effectivePermission: 'CAN_USE',
        inherited: false,
      },
      {
        kind: 'user',
        name: 'owner@example.com',
        displayName: 'owner@example.com',
        directPermission: 'CAN_MANAGE',
        effectivePermission: 'CAN_MANAGE',
        inherited: false,
      },
      {
        kind: 'user',
        name: 'reader@example.com',
        displayName: 'Reader',
        directPermission: 'CAN_USE',
        effectivePermission: 'CAN_USE',
        inherited: false,
      },
    ]);
  });

  it('reads the live App ACL with the forwarded user token', async () => {
    const call = vi.fn<typeof fetch>(() => Promise.resolve(response(acl)));
    const result = await readAppAccess({ ...options, fetchImpl: call });
    expect(result.available).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[0]).toBe('https://workspace.example/api/2.0/permissions/apps/astrolabe');
    expect(call.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(new Headers(call.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer obo-token');
  });

  it('adds direct CAN_USE without upgrading a PIA admin to CAN_MANAGE', async () => {
    const call = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ access_control_list: [] }))
      .mockResolvedValueOnce(
        response({
          access_control_list: [
            {
              user_name: 'new@example.com',
              all_permissions: [{ permission_level: 'CAN_USE', inherited: false }],
            },
          ],
        })
      );
    const result = await grantAppUse({ ...options, fetchImpl: call }, 'NEW@example.com');
    expect(result.kind).toBe('updated');
    const update = call.mock.calls[1];
    expect(update?.[1]?.method).toBe('PATCH');
    expect(requestBody(call, 1)).toEqual({
      access_control_list: [{ user_name: 'new@example.com', permission_level: 'CAN_USE' }],
    });
  });

  it('does not overwrite an existing effective permission', async () => {
    const call = vi.fn(() => Promise.resolve(response(acl)));
    const result = await grantAppUse({ ...options, fetchImpl: call }, 'reader@example.com');
    expect(result.kind).toBe('unchanged');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('adds an explicit user entry when access was only inherited', async () => {
    const inherited = {
      access_control_list: [
        {
          user_name: 'reader@example.com',
          all_permissions: [{ permission_level: 'CAN_USE', inherited: true }],
        },
      ],
    };
    const direct = {
      access_control_list: [
        {
          user_name: 'reader@example.com',
          all_permissions: [
            { permission_level: 'CAN_USE', inherited: true },
            { permission_level: 'CAN_USE', inherited: false },
          ],
        },
      ],
    };
    const call = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(inherited))
      .mockResolvedValueOnce(response(direct));
    const result = await grantAppUse({ ...options, fetchImpl: call }, 'reader@example.com');
    expect(result.kind).toBe('updated');
    expect(call.mock.calls[1]?.[1]?.method).toBe('PATCH');
  });

  it('refuses to downgrade a direct CAN_MANAGE principal', async () => {
    const call = vi.fn(() => Promise.resolve(response(acl)));
    const result = await revokeDirectAppUse({ ...options, fetchImpl: call }, 'owner@example.com');
    expect(result).toMatchObject({ kind: 'refused', status: 409 });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('preserves every other direct ACL entry when removing direct CAN_USE', async () => {
    const after = {
      access_control_list: [
        {
          user_name: 'owner@example.com',
          all_permissions: [{ permission_level: 'CAN_MANAGE', inherited: false }],
        },
        {
          service_principal_name: 'service-principal-id',
          all_permissions: [{ permission_level: 'CAN_USE', inherited: false }],
        },
        {
          group_name: 'Executives',
          all_permissions: [{ permission_level: 'CAN_USE', inherited: true }],
        },
      ],
    };
    const call = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(acl))
      .mockResolvedValueOnce(response(after))
      .mockResolvedValueOnce(response(after));
    const result = await revokeDirectAppUse({ ...options, fetchImpl: call }, 'reader@example.com');
    expect(result.kind).toBe('updated');
    const update = call.mock.calls[1];
    expect(update?.[1]?.method).toBe('PUT');
    expect(requestBody(call, 1)).toEqual({
      access_control_list: [
        { service_principal_name: 'service-principal-id', permission_level: 'CAN_USE' },
        { user_name: 'owner@example.com', permission_level: 'CAN_MANAGE' },
      ],
    });
  });

  it('reports the second authority when inherited access remains', async () => {
    const inherited = {
      access_control_list: [
        {
          user_name: 'reader@example.com',
          all_permissions: [
            { permission_level: 'CAN_USE', inherited: false },
            { permission_level: 'CAN_USE', inherited: true },
          ],
        },
      ],
    };
    const after = {
      access_control_list: [
        {
          user_name: 'reader@example.com',
          all_permissions: [{ permission_level: 'CAN_USE', inherited: true }],
        },
      ],
    };
    const call = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(inherited))
      .mockResolvedValueOnce(response(after))
      .mockResolvedValueOnce(response(after));
    const result = await revokeDirectAppUse({ ...options, fetchImpl: call }, 'reader@example.com');
    expect(result).toMatchObject({ kind: 'refused', status: 409 });
    expect(result.kind === 'refused' ? result.message : '').toMatch(/still inherits/i);
  });

  it('explains the dual authority when Databricks refuses the write', async () => {
    const call = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ access_control_list: [] }))
      .mockResolvedValueOnce(response({ error_code: 'PERMISSION_DENIED' }, 403));
    const result = await grantAppUse({ ...options, fetchImpl: call }, 'new@example.com');
    expect(result).toMatchObject({ kind: 'refused', status: 403 });
    expect(result.kind === 'refused' ? result.message : '').toMatch(/PIA super admin.*CAN MANAGE.*access-management/i);
  });
});
