import { describe, expect, it } from 'vitest';
import {
  compareExecutionIdentity,
  createIdentityReadinessProbe,
  expectedModelAuthPolicy,
  identityReadinessEnforced,
  observeRuntimeIdentity,
  runIdentityReadinessProbe,
} from './execution-identity-readiness';

describe('compareExecutionIdentity', () => {
  it.each([
    {
      expected: 'signed_in_user' as const,
      observed: 'signed_in_user' as const,
      enforce: true,
      ok: true,
      reason: 'aligned',
    },
    {
      expected: 'signed_in_user' as const,
      observed: 'token_forwarded' as const,
      enforce: true,
      ok: true,
      reason: 'aligned',
    },
    {
      expected: 'signed_in_user' as const,
      observed: 'service_principal' as const,
      enforce: true,
      ok: false,
      reason: 'obo_not_wired',
    },
    {
      expected: 'signed_in_user' as const,
      observed: 'unknown' as const,
      enforce: true,
      ok: false,
      reason: 'unverified',
    },
    {
      expected: 'service_principal' as const,
      observed: 'service_principal' as const,
      enforce: true,
      ok: true,
      reason: 'sp_only_model',
    },
    {
      expected: 'signed_in_user' as const,
      observed: 'service_principal' as const,
      enforce: false,
      ok: true,
      reason: 'enforcement_disabled',
    },
  ])('$expected x $observed enforce=$enforce → $reason', (row) => {
    expect(compareExecutionIdentity(row)).toMatchObject({ ok: row.ok, reason: row.reason });
  });
});

describe('observeRuntimeIdentity', () => {
  it('treats Model Serving user_credentials 400 as proof the token was forwarded', () => {
    expect(
      observeRuntimeIdentity({
        error: new Error('model_serving_user_credentials auth: Unable to authenticate using user_credentials'),
      })
    ).toBe('token_forwarded');
  });

  it('treats an identity-gate refusal as the serving principal, not the requested mode', () => {
    expect(
      observeRuntimeIdentity({
        result: {
          custom_outputs: {
            type: 'unavailable',
            code: 'IDENTITY_REQUIRED',
            message: 'no invoker token',
            execution_identity: { mode: 'signed_in_user', verified: false },
          },
        },
      })
    ).toBe('service_principal');
  });

  it('keeps a bare identity-required response retryable when it names no missing credential', () => {
    expect(
      observeRuntimeIdentity({
        result: { custom_outputs: { type: 'unavailable', code: 'IDENTITY_REQUIRED' } },
      })
    ).toBe('unknown');
  });

  it('reads a successful signed-in identity from a live answer', () => {
    expect(
      observeRuntimeIdentity({
        result: { custom_outputs: { execution_identity: { mode: 'signed_in_user', verified: true } } },
      })
    ).toBe('signed_in_user');
  });

  it('treats a fake-user mismatch with signed-in-user evidence as aligned OBO', () => {
    expect(
      observeRuntimeIdentity({
        result: {
          custom_outputs: {
            type: 'unavailable',
            code: 'IDENTITY_MISMATCH',
            execution_identity: { mode: 'signed_in_user', verified: true },
          },
        },
      })
    ).toBe('token_forwarded');
  });
});

describe('runIdentityReadinessProbe', () => {
  it('does not invoke serving when enforcement is off', async () => {
    let invoked = 0;
    const verdict = await runIdentityReadinessProbe({
      env: { ENFORCE_IDENTITY_READINESS: 'false', PLAYER_INSIGHTS_USER_AUTHORIZATION: 'true' },
      invoke: () => {
        invoked += 1;
        return Promise.resolve({});
      },
    });
    expect(invoked).toBe(0);
    expect(verdict).toMatchObject({ ok: true, reason: 'enforcement_disabled' });
  });

  it('does not invoke serving for an SP-only logged model', async () => {
    let invoked = 0;
    const verdict = await runIdentityReadinessProbe({
      env: { ENFORCE_IDENTITY_READINESS: 'true', PLAYER_INSIGHTS_USER_AUTHORIZATION: 'false', NODE_ENV: 'production' },
      invoke: () => {
        invoked += 1;
        return Promise.resolve({});
      },
    });
    expect(invoked).toBe(0);
    expect(verdict).toMatchObject({ ok: true, reason: 'sp_only_model' });
  });

  it('treats the deliberate fake-user mismatch as OBO proof regardless of echoed mode', async () => {
    const verdict = await runIdentityReadinessProbe({
      env: { ENFORCE_IDENTITY_READINESS: 'true', PLAYER_INSIGHTS_USER_AUTHORIZATION: 'true' },
      invoke: ({ forwardedUserToken }) => {
        expect(forwardedUserToken).toBeTruthy();
        return Promise.resolve({
          result: {
            custom_outputs: {
              type: 'unavailable',
              code: 'IDENTITY_MISMATCH',
              execution_identity: { mode: 'service_principal', verified: false },
            },
          },
        });
      },
    });
    expect(verdict).toMatchObject({ ok: true, reason: 'aligned', observed: 'token_forwarded' });
  });

  it('passes when serving rejects the synthetic token as user_credentials', async () => {
    const verdict = await runIdentityReadinessProbe({
      env: { ENFORCE_IDENTITY_READINESS: 'true', PLAYER_INSIGHTS_USER_AUTHORIZATION: 'true' },
      invoke: () =>
        Promise.reject(new Error('model_serving_user_credentials auth: Unable to authenticate using user_credentials')),
    });
    expect(verdict).toMatchObject({ ok: true, reason: 'aligned', observed: 'token_forwarded' });
  });

  it('retries an inconclusive cold-start probe instead of caching it for the process lifetime', async () => {
    let attempts = 0;
    const probe = createIdentityReadinessProbe({
      env: { ENFORCE_IDENTITY_READINESS: 'true', PLAYER_INSIGHTS_USER_AUTHORIZATION: 'true' },
      invoke: () => {
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? {}
            : {
                result: {
                  custom_outputs: {
                    type: 'unavailable',
                    code: 'IDENTITY_MISMATCH',
                    execution_identity: { mode: 'signed_in_user', verified: true },
                  },
                },
              }
        );
      },
    });

    await expect(probe.get()).resolves.toMatchObject({ ok: false, reason: 'unverified' });
    await expect(probe.get()).resolves.toMatchObject({ ok: true, reason: 'aligned' });
    expect(attempts).toBe(2);
  });

  it('retries a missing-invoker verdict instead of caching a lifetime outage', async () => {
    let attempts = 0;
    const probe = createIdentityReadinessProbe({
      env: { ENFORCE_IDENTITY_READINESS: 'true', PLAYER_INSIGHTS_USER_AUTHORIZATION: 'true' },
      invoke: () => {
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? {
                result: {
                  custom_outputs: {
                    type: 'unavailable',
                    code: 'IDENTITY_REQUIRED',
                    message: 'no invoker token',
                  },
                },
              }
            : {
                result: {
                  custom_outputs: {
                    type: 'unavailable',
                    code: 'IDENTITY_MISMATCH',
                  },
                },
              }
        );
      },
    });

    await expect(probe.get()).resolves.toMatchObject({ ok: false, reason: 'obo_not_wired' });
    await expect(probe.get()).resolves.toMatchObject({ ok: true, reason: 'aligned' });
    expect(attempts).toBe(2);
  });
});

describe('env defaults', () => {
  it('enforces in production unless explicitly flipped off', () => {
    expect(identityReadinessEnforced({ NODE_ENV: 'production' }, true)).toBe(true);
    expect(identityReadinessEnforced({ NODE_ENV: 'production', ENFORCE_IDENTITY_READINESS: 'false' }, true)).toBe(
      false
    );
    expect(identityReadinessEnforced({ NODE_ENV: 'test' }, false)).toBe(false);
  });

  it('treats unset user-authorization as a user-auth model', () => {
    expect(expectedModelAuthPolicy({})).toBe('signed_in_user');
    expect(expectedModelAuthPolicy({ PLAYER_INSIGHTS_USER_AUTHORIZATION: 'false' })).toBe('service_principal');
    expect(expectedModelAuthPolicy({ PLAYER_INSIGHTS_USER_AUTHORIZATION: '1' })).toBe('service_principal');
    expect(expectedModelAuthPolicy({ PLAYER_INSIGHTS_USER_AUTHORIZATION: 'yes' })).toBe('service_principal');
  });
});
