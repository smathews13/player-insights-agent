/**
 * Boot-time check that a user-authorization model is not serving as the app SP.
 *
 * A model logged with a UserAuthPolicy, pointed at an endpoint that does not
 * forward `x-forwarded-access-token`, used to answer under the service
 * principal. The agent now refuses that turn, but Ask still needs a process-level
 * verdict so the first real question is not the probe.
 */

export const ENFORCE_IDENTITY_READINESS_ENV = 'ENFORCE_IDENTITY_READINESS';
export const USER_AUTHORIZATION_ENV = 'PLAYER_INSIGHTS_USER_AUTHORIZATION';
export const IDENTITY_READINESS_PROBE_USER = 'readiness-probe@invalid.example';
export const OBO_NOT_WIRED_LOG = 'OBO not wired: x-forwarded-access-token is not reaching the serving endpoint.';

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const FALSEY = new Set(['0', 'false', 'off', 'no']);

export type ModelAuthPolicy = 'signed_in_user' | 'service_principal';
export type RuntimeIdentity = 'signed_in_user' | 'service_principal' | 'token_forwarded' | 'unknown';

export type IdentityReadinessVerdict =
  | {
      ok: true;
      reason: 'aligned' | 'sp_only_model' | 'enforcement_disabled';
      expected: ModelAuthPolicy;
      observed: RuntimeIdentity;
    }
  | { ok: false; reason: 'obo_not_wired' | 'unverified'; expected: ModelAuthPolicy; observed: RuntimeIdentity };

function flag(value: string | undefined): boolean | null {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (TRUTHY.has(normalized)) return true;
  if (FALSEY.has(normalized)) return false;
  return null;
}

export function identityReadinessEnforced(
  env: Record<string, string | undefined> = process.env,
  deployed = env.NODE_ENV === 'production'
): boolean {
  return flag(env[ENFORCE_IDENTITY_READINESS_ENV]) ?? deployed;
}

export function expectedModelAuthPolicy(env: Record<string, string | undefined> = process.env): ModelAuthPolicy {
  const logged = flag(env[USER_AUTHORIZATION_ENV]);
  if (logged === false) return 'service_principal';
  return 'signed_in_user';
}

function customOutputs(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const nested = record.custom_outputs;
  if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  return record;
}

function identityModeFrom(value: unknown): RuntimeIdentity | null {
  const custom = customOutputs(value);
  const identity = custom?.execution_identity;
  if (!identity || typeof identity !== 'object') return null;
  const mode = (identity as Record<string, unknown>).mode;
  if (mode === 'signed_in_user') return 'signed_in_user';
  if (mode === 'service_principal' || mode === 'assigned_service_principal') return 'service_principal';
  return null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.message}\n${error.stack ?? ''}`;
  return String(error ?? '');
}

export function observeRuntimeIdentity(input: { result?: unknown; error?: unknown }): RuntimeIdentity {
  const text = `${errorText(input.error)}\n${typeof input.result === 'string' ? input.result : JSON.stringify(input.result ?? '')}`;
  if (/Unable to authenticate using user_credentials|model_serving_user_credentials/i.test(text)) {
    return 'token_forwarded';
  }
  const custom = customOutputs(input.result);
  const code = typeof custom?.code === 'string' ? custom.code : '';
  const type = typeof custom?.type === 'string' ? custom.type : '';
  const message = typeof custom?.message === 'string' ? custom.message : '';
  const combined = `${message}\n${text}`;
  if (type === 'unavailable' && (code === 'IDENTITY_REQUIRED' || code === 'IDENTITY_MISMATCH')) {
    return 'service_principal';
  }
  if (
    /without working user-authorization credential forwarding|no credential for the signed-in user|no invoker token/i.test(
      combined
    )
  ) {
    return 'service_principal';
  }
  const fromResult = identityModeFrom(input.result);
  if (fromResult) return fromResult;
  return 'unknown';
}

export function compareExecutionIdentity(input: {
  expected: ModelAuthPolicy;
  observed: RuntimeIdentity;
  enforce: boolean;
}): IdentityReadinessVerdict {
  const { expected, observed, enforce } = input;
  if (!enforce) return { ok: true, reason: 'enforcement_disabled', expected, observed };
  if (expected === 'service_principal') return { ok: true, reason: 'sp_only_model', expected, observed };
  if (observed === 'signed_in_user' || observed === 'token_forwarded') {
    return { ok: true, reason: 'aligned', expected, observed };
  }
  if (observed === 'service_principal') return { ok: false, reason: 'obo_not_wired', expected, observed };
  return { ok: false, reason: 'unverified', expected, observed };
}

export function identityProbePayload(): Record<string, unknown> {
  return {
    input: [{ role: 'user', content: 'identity readiness probe' }],
    custom_inputs: {
      identity_mode: 'signed_in_user',
      expected_user: IDENTITY_READINESS_PROBE_USER,
      request_id: 'identity-readiness-probe',
    },
  };
}

export type IdentityProbeInvoke = (input: {
  payload: Record<string, unknown>;
  userToken: string;
}) => Promise<{ result?: unknown; error?: unknown }>;

export function createIdentityReadinessProbe(input: {
  invoke: IdentityProbeInvoke;
  env?: Record<string, string | undefined>;
  deployed?: boolean;
}): { get(): Promise<IdentityReadinessVerdict> } {
  let pending: Promise<IdentityReadinessVerdict> | undefined;
  const env = input.env ?? process.env;
  const get = () => {
    if (!pending) pending = runIdentityReadinessProbe({ invoke: input.invoke, env, deployed: input.deployed });
    return pending;
  };
  return { get };
}

export async function runIdentityReadinessProbe(input: {
  invoke: IdentityProbeInvoke;
  env?: Record<string, string | undefined>;
  deployed?: boolean;
}): Promise<IdentityReadinessVerdict> {
  const env = input.env ?? process.env;
  const enforce = identityReadinessEnforced(env, input.deployed ?? env.NODE_ENV === 'production');
  const expected = expectedModelAuthPolicy(env);
  if (!enforce) return compareExecutionIdentity({ expected, observed: 'unknown', enforce: false });
  if (expected === 'service_principal') {
    return compareExecutionIdentity({ expected, observed: 'unknown', enforce: true });
  }
  try {
    const outcome = await input.invoke({
      payload: identityProbePayload(),
      userToken: 'identity-readiness-synthetic-token',
    });
    const observed = observeRuntimeIdentity(outcome);
    const verdict = compareExecutionIdentity({ expected, observed, enforce: true });
    if (!verdict.ok) console.error(`[identity] ${OBO_NOT_WIRED_LOG} expected=${expected} observed=${observed}`);
    return verdict;
  } catch (error) {
    const observed = observeRuntimeIdentity({ error });
    const verdict = compareExecutionIdentity({ expected, observed, enforce: true });
    if (!verdict.ok) console.error(`[identity] ${OBO_NOT_WIRED_LOG} expected=${expected} observed=${observed}`);
    return verdict;
  }
}

export function identityReadinessHttp(verdict: IdentityReadinessVerdict): {
  status: number;
  body: Record<string, unknown>;
} {
  return {
    status: verdict.ok ? 200 : 503,
    body: {
      schema_version: '1.0.0',
      check: 'execution-identity',
      ok: verdict.ok,
      reason: verdict.reason,
      expected: verdict.expected,
      observed: verdict.observed,
      detail: verdict.ok ? null : OBO_NOT_WIRED_LOG,
    },
  };
}
