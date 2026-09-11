import { generateKeyPairSync, verify } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  GENIE_MCP_AUDIENCE,
  GENIE_MCP_CAPABILITY_TTL_SECONDS,
  GENIE_MCP_PURPOSE,
  GENIE_MCP_SIGNING_WARNING,
  GenieMcpSigningUnavailable,
  canonicalJson,
  issueGenieMcpCapability,
  managedGenieMcpCapability,
} from './genie-mcp-capability';

function keys(): { privateKeyPem: string; publicKeyPem: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function decode(token: string): { body: string; payload: Record<string, unknown>; signature: Buffer } {
  const [body, encodedSignature] = token.split('.');
  if (!body || !encodedSignature) throw new Error('malformed test token');
  return {
    body,
    payload: JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>,
    signature: Buffer.from(encodedSignature, 'base64url'),
  };
}

describe('Genie MCP app-issued capability', () => {
  it('signs a canonical short-lived request and user-bound Ed25519 capability', () => {
    const { privateKeyPem, publicKeyPem } = keys();
    const token = issueGenieMcpCapability({
      user: 'Admin@Example.com',
      requestId: 'request-123',
      privateKeyPem,
      nowSeconds: 2_000_000_000,
      nonce: 'nonce-for-unit-test-0001',
    });
    const decoded = decode(token);

    expect(decoded.payload).toEqual({
      aud: GENIE_MCP_AUDIENCE,
      exp: 2_000_000_000 + GENIE_MCP_CAPABILITY_TTL_SECONDS,
      iat: 2_000_000_000,
      jti: 'nonce-for-unit-test-0001',
      purpose: GENIE_MCP_PURPOSE,
      request_id: 'request-123',
      sub: 'admin@example.com',
      transport: 'mcp',
      v: 1,
    });
    expect(Buffer.from(decoded.body, 'base64url').toString('utf8')).toBe(canonicalJson(decoded.payload));
    expect(verify(null, Buffer.from(decoded.body, 'ascii'), publicKeyPem, decoded.signature)).toBe(true);
    expect(token).not.toContain('PRIVATE KEY');
  });

  it.each([
    { enabled: false, role: 'admin' as const, identityMode: 'signed_in_user' },
    { enabled: true, role: 'consumer' as const, identityMode: 'signed_in_user' },
    { enabled: true, role: 'super_admin' as const, identityMode: 'assigned_service_principal' },
    { enabled: true, role: 'admin' as const, identityMode: 'signed_in_user', tokenScopes: ['dashboards.genie'] },
  ])('emits nothing for an ineligible request without reading a secret', (request) => {
    expect(
      managedGenieMcpCapability({
        ...request,
        user: 'reader@example.com',
        requestId: 'request-123',
        privateKeyPem: '',
      })
    ).toBeUndefined();
  });

  it('keeps the strict issuer useful to callers that require a signature', () => {
    expect(() =>
      issueGenieMcpCapability({
        user: 'admin@example.com',
        requestId: 'request-123',
        privateKeyPem: '',
      })
    ).toThrowError(GenieMcpSigningUnavailable);
  });

  it.each(['', 'TOP-SECRET-KEY-FRAGMENT'])(
    'falls back to direct Genie with a generic warning when signing is unavailable',
    (privateKeyPem) => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(
          managedGenieMcpCapability({
            enabled: true,
            role: 'admin',
            identityMode: 'signed_in_user',
            user: 'admin@example.com',
            requestId: 'request-123',
            tokenScopes: ['genie'],
            privateKeyPem,
          })
        ).toBeUndefined();
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith(GENIE_MCP_SIGNING_WARNING);
        expect(JSON.stringify(warning.mock.calls)).not.toContain(privateKeyPem || 'PRIVATE KEY');
        expect(JSON.stringify(warning.mock.calls)).not.toContain('not configured');
      } finally {
        warning.mockRestore();
      }
    }
  );
});
