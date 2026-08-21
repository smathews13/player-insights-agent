import { describe, expect, it, vi } from 'vitest';
import {
  MANAGER_GRANT_USER_API_SCOPES,
  allowAstrolabeUserApiScopes,
} from './app-user-api-scopes';

const options = {
  host: 'https://workspace.example.com',
  appName: 'astrolabe',
  userToken: 'forwarded-user-token',
};

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('allowAstrolabeUserApiScopes', () => {
  it('adds the required scopes and workspace browse without removing an existing extra', async () => {
    const call = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(answer({ user_api_scopes: ['catalog.tables:read'] }))
      .mockResolvedValueOnce(answer({}));

    const result = await allowAstrolabeUserApiScopes({ ...options, fetchImpl: call });

    expect(result).toEqual({
      kind: 'updated',
      scopes: ['catalog.tables:read', ...MANAGER_GRANT_USER_API_SCOPES],
    });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0][1]?.method).toBe('GET');
    expect(new Headers(call.mock.calls[0][1]?.headers).get('authorization')).toBe(
      'Bearer forwarded-user-token',
    );
    expect(call.mock.calls[1][1]?.method).toBe('PATCH');
    expect(new Headers(call.mock.calls[1][1]?.headers).get('authorization')).toBe(
      'Bearer forwarded-user-token',
    );
    const patchBody = call.mock.calls[1][1]?.body;
    if (typeof patchBody !== 'string') throw new Error('PATCH carried no JSON body');
    const sent: unknown = JSON.parse(patchBody);
    expect(sent).toEqual({
      user_api_scopes: ['catalog.tables:read', ...MANAGER_GRANT_USER_API_SCOPES],
    });
  });

  it('does nothing when every managed scope is already present', async () => {
    const current = [...MANAGER_GRANT_USER_API_SCOPES, 'catalog.tables:read'];
    const call = vi.fn<typeof fetch>().mockResolvedValue(answer({ user_api_scopes: current }));

    await expect(
      allowAstrolabeUserApiScopes({ ...options, fetchImpl: call }),
    ).resolves.toEqual({ kind: 'unchanged', scopes: current });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('uses only the forwarded user token and never creates a service-principal client', async () => {
    const call = vi.fn<typeof fetch>().mockResolvedValue(answer({ user_api_scopes: [] }));

    await allowAstrolabeUserApiScopes({ ...options, fetchImpl: call });

    expect(call).toHaveBeenCalled();
    for (const [, init] of call.mock.calls) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer forwarded-user-token');
    }
  });

  it('turns a missing CAN MANAGE grant into a clear refusal', async () => {
    const call = vi
      .fn<typeof fetch>()
      .mockResolvedValue(answer({ error_code: 'PERMISSION_DENIED', message: 'No CAN MANAGE' }, 403));

    const result = await allowAstrolabeUserApiScopes({ ...options, fetchImpl: call });

    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.message).toContain('Ask someone who can manage this app to open it once');
      expect(result.message).toContain('CAN MANAGE');
    }
  });
});

