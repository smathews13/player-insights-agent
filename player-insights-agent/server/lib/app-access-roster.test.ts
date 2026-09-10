import { describe, expect, it, vi } from 'vitest';
import {
  alignRosterWithAppAccess,
  appAccessPrincipals,
  readAppAccess,
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
          canRemove: true,
        }),
        expect.objectContaining({
          email: 'reader@example.com',
          role: 'consumer',
          setBy: 'Databricks App permissions',
          appAccess: 'can_use',
          canRemove: false,
        }),
      ])
    );
    expect(aligned.entries.map((entry) => entry.email)).toEqual(['owner@example.com', 'reader@example.com']);
    expect(aligned.appAccessPrincipals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'group', name: 'Executives' }),
        expect.objectContaining({ kind: 'service_principal', name: 'service-principal-id' }),
      ])
    );
  });

  it('keeps stored roles visible and marks membership unknown when the App ACL cannot be read', () => {
    const aligned = alignRosterWithAppAccess(roster, {
      available: false,
      principals: [],
      message: 'Databricks denied the membership read.',
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
});
