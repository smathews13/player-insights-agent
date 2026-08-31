/**
 * Minting an OAuth token for an assigned service-principal persona.
 *
 * Databricks Apps forwards the signed-in user's token. That token cannot mint
 * a credential for a *different* service principal: there is no Apps user
 * scope for it. The only working path is the one Connections already uses for
 * secrets — a scope/key the app's own identity can read — then a client-
 * credentials exchange against the workspace OIDC endpoint.
 *
 * Failures stay on OAuth. This module never invents a token and never logs
 * the secret or the minted bearer.
 */

import { SP_IDENTITY_MINTING_UNAVAILABLE, type SpMintingStatus, type SpPersona } from '../../shared/sp-identity';
import { normalizeWorkspaceHost } from '../../shared/databricks-links';
import { ExpiringLruCache } from './expiring-lru';

export interface SpSecretReader {
  (scope: string, key: string): Promise<string | null>;
}

export interface SpTokenExchange {
  (input: { host: string; clientId: string; clientSecret: string }): Promise<{
    token: string;
    expiresInSeconds: number;
  }>;
}

export interface SpTokenDeps {
  env?: Record<string, string | undefined>;
  now?: () => number;
  readSecret?: SpSecretReader;
  exchange?: SpTokenExchange;
  fetchImpl?: typeof fetch;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export const SP_TOKEN_CACHE_MAX_ENTRIES = 256;
export const SP_TOKEN_CACHE_MAX_TTL_MS = 24 * 60 * 60_000;
const tokenCache = new ExpiringLruCache<CachedToken>(SP_TOKEN_CACHE_MAX_ENTRIES, SP_TOKEN_CACHE_MAX_TTL_MS);
/** Refresh this many ms before the issuer's expiry, so a slow call still lands. */
const EXPIRY_SKEW_MS = 60_000;
const DEFAULT_EXPIRES_IN = 3600;

export function forgetSpTokens(): void {
  tokenCache.clear();
}

export function describeSpTokenMinting(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): SpMintingStatus {
  const host = normalizeWorkspaceHost(env.DATABRICKS_HOST);
  const clientId = (env.DATABRICKS_CLIENT_ID ?? '').trim();
  const clientSecret = (env.DATABRICKS_CLIENT_SECRET ?? '').trim();
  if (!host) {
    return {
      available: false,
      detail:
        'This app does not know its workspace URL, so it cannot exchange a service-principal secret for a token. Questions stay on OAuth.',
    };
  }
  if (!clientId || !clientSecret) {
    return {
      available: false,
      detail:
        'This app has no service-principal credentials of its own, so it cannot read a persona secret from Databricks Secrets. ' +
        SP_IDENTITY_MINTING_UNAVAILABLE,
    };
  }
  return {
    available: true,
    detail: SP_IDENTITY_MINTING_UNAVAILABLE,
  };
}

async function defaultReadSecret(scope: string, key: string): Promise<string | null> {
  const { WorkspaceClient } = await import('@databricks/sdk-experimental');
  const client = new WorkspaceClient({});
  const secret = await client.secrets.getSecret({ scope, key });
  const raw = secret.value;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (raw && typeof raw === 'object' && 'toString' in raw) {
    const decoded = String(raw).trim();
    return decoded || null;
  }
  return null;
}

async function defaultExchange(input: {
  host: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<{ token: string; expiresInSeconds: number }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = `${input.host.replace(/\/$/, '')}/oidc/v1/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: input.clientId,
    client_secret: input.clientSecret,
    scope: 'all-apis',
  });
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`The workspace refused a service-principal token (${response.status}).`);
  }
  let parsed: { access_token?: unknown; expires_in?: unknown };
  try {
    parsed = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };
  } catch {
    throw new Error('The workspace returned an unreadable token response.');
  }
  const token = typeof parsed.access_token === 'string' ? parsed.access_token.trim() : '';
  if (!token) throw new Error('The workspace returned no access token for this service principal.');
  const expiresIn =
    typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in)
      ? parsed.expires_in
      : DEFAULT_EXPIRES_IN;
  return { token, expiresInSeconds: expiresIn };
}

/**
 * A bearer token for this persona, or a reason it could not be minted.
 *
 * Cached per persona until near expiry. The secret is held only for the
 * duration of the exchange and is not written to the cache key.
 */
export async function mintPersonaToken(
  persona: SpPersona,
  deps: SpTokenDeps = {}
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const minting = describeSpTokenMinting(env);
  if (!minting.available) return { ok: false, reason: minting.detail };

  const now = deps.now ?? Date.now;
  const checkedAt = now();
  const cached = tokenCache.get(persona.id, checkedAt);
  if (cached && cached.expiresAtMs - EXPIRY_SKEW_MS > checkedAt) {
    return { ok: true, token: cached.token };
  }

  const host = normalizeWorkspaceHost(env.DATABRICKS_HOST);
  const readSecret = deps.readSecret ?? defaultReadSecret;
  const exchange =
    deps.exchange ??
    ((input: { host: string; clientId: string; clientSecret: string }) =>
      defaultExchange({ ...input, fetchImpl: deps.fetchImpl }));

  try {
    const secret = await readSecret(persona.secretScope, persona.secretKey);
    if (!secret) {
      return {
        ok: false,
        reason:
          `The app could not read the secret ${persona.secretScope}/${persona.secretKey} for ${persona.displayName}. ` +
          'Questions for this person stay on OAuth until the app identity can GET that secret.',
      };
    }
    const minted = await exchange({ host, clientId: persona.clientId, clientSecret: secret });
    const storedAt = now();
    const expiresAtMs = storedAt + Math.max(minted.expiresInSeconds, 60) * 1000;
    tokenCache.set(
      persona.id,
      { token: minted.token, expiresAtMs },
      storedAt,
      Math.min(SP_TOKEN_CACHE_MAX_TTL_MS, Math.max(0, expiresAtMs - EXPIRY_SKEW_MS - storedAt))
    );
    return { ok: true, token: minted.token };
  } catch (error) {
    const message = (error as Error).message || 'The token exchange failed.';
    if (/scope|insufficient|permission|403|401/i.test(message)) {
      return {
        ok: false,
        reason:
          `The app could not mint a token for ${persona.displayName}: ${message} ` + SP_IDENTITY_MINTING_UNAVAILABLE,
      };
    }
    return {
      ok: false,
      reason: `The app could not mint a token for ${persona.displayName}: ${message} Questions stay on OAuth.`,
    };
  }
}
