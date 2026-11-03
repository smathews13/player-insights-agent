import { describe, expect, it } from 'vitest';

import { AuthorizationRefused, refusedTokenEvidence } from './insights-routes';

function tokenWith(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`;
}

describe('refused token evidence', () => {
  it('names the scopes the endpoint wanted, the scopes held, and the issuing client', () => {
    const token = tokenWith({ scope: 'sql serving.serving-endpoints', client_id: 'genie-one-mobile' });
    const message =
      'Provided OAuth token does not have required scopes: genie, ai-gateway [Reqid: 123] on table main.secret.players';
    expect(refusedTokenEvidence(token, message)).toBe(
      'Missing permission scopes: genie, ai-gateway. Token scopes: serving.serving-endpoints, sql. ' +
        'Issued to OAuth client genie-one-mobile.'
    );
  });

  it('says nothing about a token that does not describe itself', () => {
    expect(refusedTokenEvidence('opaque-pat', 'HTTP 403 Forbidden')).toBe('');
  });

  it('appends the evidence to the disclosable sentence without the provider prose', () => {
    const refused = new AuthorizationRefused(
      'USER_NOT_AUTHORIZED',
      'PERMISSION_DENIED on main.secret.players',
      403,
      'Token scopes: sql.'
    );
    expect(refused.disclosable).toBe(
      'The endpoint refused this request under the signed-in user\u2019s own credential. Token scopes: sql.'
    );
    expect(refused.disclosable).not.toContain('main.secret');
  });
});
