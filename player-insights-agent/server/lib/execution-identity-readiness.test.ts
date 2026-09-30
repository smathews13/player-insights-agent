import { describe, expect, it } from 'vitest';
import {
  compareExecutionIdentity,
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
            execution_identity: { mode: 'signed_in_user', verified: false },
          },
        },
      })
    ).toBe('service_principal');
  });

  it('reads a successful signed-in identity from a live answer', () => {
    expect(
      observeRuntimeIdentity({
        result: { custom_outputs: { execution_identity: { mode: 'signed_in_user', verified: true } } },
      })
    ).toBe('signed_in_user');
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

  it('fails when a user-auth model answers as the service principal', async () => {
    const verdict = await runIdentityReadinessProbe({
      env: { ENFORCE_IDENTITY_READINESS: 'true', PLAYER_INSIGHTS_USER_AUTHORIZATION: 'true' },
      invoke: ({ userToken }) => {
        expect(userToken).toBeTruthy();
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
    expect(verdict).toMatchObject({ ok: false, reason: 'obo_not_wired', observed: 'service_principal' });
  });

  it('passes when serving rejects the synthetic token as user_credentials', async () => {
    const verdict = await runIdentityReadinessProbe({
      env: { ENFORCE_IDENTITY_READINESS: 'true', PLAYER_INSIGHTS_USER_AUTHORIZATION: 'true' },
      invoke: () =>
        Promise.reject(new Error('model_serving_user_credentials auth: Unable to authenticate using user_credentials')),
    });
    expect(verdict).toMatchObject({ ok: true, reason: 'aligned', observed: 'token_forwarded' });
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
  });
});
