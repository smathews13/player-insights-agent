import { createPrivateKey, randomBytes, sign } from 'node:crypto';

import { opensAdminSurfaces, type Role } from '../../shared/user-roster-contract';

export const GENIE_MCP_AUDIENCE = 'player-insights-agent';
export const GENIE_MCP_PURPOSE = 'managed-genie-mcp';
export const GENIE_MCP_TRANSPORT = 'mcp';
export const GENIE_MCP_CAPABILITY_VERSION = 1;
export const GENIE_MCP_CAPABILITY_TTL_SECONDS = 45;
export const GENIE_MCP_PRIVATE_KEY_ENV = 'PLAYER_INSIGHTS_GENIE_MCP_PRIVATE_KEY';
export const GENIE_MCP_SIGNING_WARNING =
  '[genie-mcp] Signing is unavailable; this request will use direct Genie.';

export interface GenieMcpCapabilityPayload {
  aud: typeof GENIE_MCP_AUDIENCE;
  exp: number;
  iat: number;
  jti: string;
  purpose: typeof GENIE_MCP_PURPOSE;
  request_id: string;
  sub: string;
  transport: typeof GENIE_MCP_TRANSPORT;
  v: typeof GENIE_MCP_CAPABILITY_VERSION;
}

export class GenieMcpSigningUnavailable extends Error {
  constructor() {
    super('Genie MCP signing is not configured for this deployment.');
    this.name = 'GenieMcpSigningUnavailable';
  }
}

/** JSON with recursively sorted object keys, shared byte-for-byte with Python. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Unsupported canonical JSON value.');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function issueGenieMcpCapability({
  user,
  requestId,
  privateKeyPem,
  nowSeconds = Math.floor(Date.now() / 1000),
  nonce = randomBytes(18).toString('base64url'),
}: {
  user: string;
  requestId: string;
  privateKeyPem: string;
  nowSeconds?: number;
  nonce?: string;
}): string {
  const subject = user.trim().toLocaleLowerCase('en-US');
  if (!subject || !requestId.trim() || !privateKeyPem.trim()) throw new GenieMcpSigningUnavailable();
  const payload: GenieMcpCapabilityPayload = {
    aud: GENIE_MCP_AUDIENCE,
    exp: nowSeconds + GENIE_MCP_CAPABILITY_TTL_SECONDS,
    iat: nowSeconds,
    jti: nonce,
    purpose: GENIE_MCP_PURPOSE,
    request_id: requestId,
    sub: subject,
    transport: GENIE_MCP_TRANSPORT,
    v: GENIE_MCP_CAPABILITY_VERSION,
  };
  try {
    const body = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
    const signature = sign(null, Buffer.from(body, 'ascii'), createPrivateKey(privateKeyPem)).toString('base64url');
    return `${body}.${signature}`;
  } catch {
    // Key parser details can include supplied PEM fragments. Never carry them
    // into the app log or an HTTP response.
    throw new GenieMcpSigningUnavailable();
  }
}

export function managedGenieMcpCapability({
  enabled,
  role,
  identityMode,
  user,
  requestId,
  privateKeyPem = process.env[GENIE_MCP_PRIVATE_KEY_ENV] ?? '',
  nowSeconds,
  nonce,
}: {
  enabled: boolean;
  role: Role;
  identityMode: string;
  user: string;
  requestId: string;
  privateKeyPem?: string;
  nowSeconds?: number;
  nonce?: string;
}): string | undefined {
  if (!enabled || !opensAdminSurfaces(role) || identityMode !== 'signed_in_user') return undefined;
  try {
    return issueGenieMcpCapability({ user, requestId, privateKeyPem, nowSeconds, nonce });
  } catch (error) {
    if (!(error instanceof GenieMcpSigningUnavailable)) throw error;
    // Fixed text only. Node's key parser can include supplied PEM fragments in
    // its errors, so neither the exception nor the key is interpolated.
    console.warn(GENIE_MCP_SIGNING_WARNING);
    return undefined;
  }
}
