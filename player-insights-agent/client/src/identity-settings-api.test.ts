import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RosterPayload } from '../../shared/user-roster-contract';
import { HumanRosterError, writeHumanRoster } from './identity-settings-api';

const PAYLOAD: RosterPayload = {
  entries: [
    {
      email: 'analyst@example.invalid',
      role: 'consumer',
      seedFloor: 'consumer',
      setBy: 'owner@example.invalid',
      setAt: '2026-08-31T17:00:00.000Z',
      isYou: false,
      assignable: ['admin', 'super_admin'],
      canRemove: true,
    },
  ],
  storedRosterReadable: true,
  roleColumnPresent: true,
  pendingSchemaStatement: '',
  superAdminCount: 1,
  recoveryStatement: '',
};

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('human roster API feedback', () => {
  it('returns the server-confirmed row and keeps the same-origin session attached', async () => {
    const request = vi.fn(() => Promise.resolve(answer(PAYLOAD)));
    vi.stubGlobal('fetch', request);

    await expect(
      writeHumanRoster('/api/users', 'POST', { email: 'analyst@example.invalid', role: 'consumer' })
    ).resolves.toEqual(PAYLOAD);
    expect(request).toHaveBeenCalledWith(
      '/api/users',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' })
    );
  });

  it.each([
    [400, { detail: 'Enter a valid work email.' }, 'invalid', 'Enter a valid work email.'],
    [409, { detail: 'That address already holds that role.' }, 'conflict', 'already holds'],
    [401, { error: 'APP_IDLE_TIMEOUT' }, 'session', 'session expired'],
    [403, { error: 'super_admin_role_required' }, 'authorization', 'not authorized'],
    [503, { error: 'roster_store_unavailable' }, 'unavailable', 'could not save'],
    [503, { error: 'roster_confirmation_unavailable' }, 'unavailable', 'could not confirm the saved role'],
  ] as const)('maps status %s to a concise inline error', async (status, body, kind, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(answer(body, status)))
    );

    const failure = await writeHumanRoster('/api/users', 'POST', {}).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(HumanRosterError);
    expect(failure).toMatchObject({ kind, status });
    expect((failure as Error).message.toLowerCase()).toContain(message.toLowerCase());
  });

  it('distinguishes a network failure from an HTTP refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
    );

    const failure = await writeHumanRoster('/api/users', 'POST', {}).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({ kind: 'network', status: 0 });
    expect((failure as Error).message).toContain('network request failed');
  });
});
