import { describe, expect, it } from 'vitest';

import {
  bindTokenToUser,
  bindingFailure,
  CLOCK_SKEW_SECONDS,
  describeBinding,
  isVerified,
  readTokenClaims,
  sameSubject,
  tokenSubjects,
} from './identity-subject';

const NOW = 1_800_000_000;

/**
 * A JWT with the given claims and a signature nothing reads.
 *
 * Base64url, not base64: a real token uses the URL alphabet and the padding is
 * stripped, and a decoder tested only against padded standard base64 passes
 * here and returns null against every token the platform actually issues.
 */
function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.not-a-signature`;
}

function userToken(claims: Record<string, unknown> = {}) {
  return jwt({ sub: 'alice@acme.example', exp: NOW + 3600, ...claims });
}

describe('reading a token', () => {
  it('reads the claims of a base64url JWT', () => {
    expect(readTokenClaims(jwt({ sub: 'alice@acme.example' }))).toEqual({
      sub: 'alice@acme.example',
    });
  });

  /**
   * An opaque token is not a malformed one. A workspace that issues personal
   * access tokens is a workspace where every request would be refused if this
   * returned anything but null.
   */
  it.each([
    ['a personal access token', 'dapi0123456789abcdef'],
    ['an empty string', ''],
    ['something with the right number of dots and no JSON in it', 'a.b.c'],
    ['a JWT whose payload is an array', jwt([] as unknown as Record<string, unknown>)],
  ])('returns no claims for %s', (_label, token) => {
    expect(readTokenClaims(token)).toBeNull();
  });

  it('collects every subject the token names rather than picking one', () => {
    expect(tokenSubjects(jwt({ sub: '4212345', email: 'alice@acme.example' }))).toEqual([
      '4212345',
      'alice@acme.example',
    ]);
  });

  it('ignores a subject claim that is present and empty', () => {
    expect(tokenSubjects(jwt({ sub: '   ', email: 'alice@acme.example' }))).toEqual(['alice@acme.example']);
  });
});

describe('comparing two identities', () => {
  /**
   * The directory does not agree with itself about casing, and a gate that
   * refuses on it locks out everyone whose address is stored capitalised.
   */
  it('treats a difference of case as the same person', () => {
    expect(sameSubject('Alice@Acme.Example', 'alice@acme.example')).toBe(true);
  });

  it('does not treat a plus-address or another domain as the same person', () => {
    expect(sameSubject('alice+work@acme.example', 'alice@acme.example')).toBe(false);
    expect(sameSubject('alice@elsewhere.example', 'alice@acme.example')).toBe(false);
  });
});

describe('binding a token to the signed-in user', () => {
  it('binds a token issued to the person the request is from', () => {
    const binding = bindTokenToUser(userToken(), 'alice@acme.example', { now: NOW });
    expect(binding).toEqual({ kind: 'bound', subject: 'alice@acme.example' });
    expect(isVerified(binding)).toBe(true);
    expect(bindingFailure(binding)).toBeNull();
  });

  it('binds when the address arrives on a claim other than sub', () => {
    const binding = bindTokenToUser(
      jwt({ sub: '4212345', upn: 'alice@acme.example', exp: NOW + 60 }),
      'alice@acme.example',
      { now: NOW }
    );
    expect(binding.kind).toBe('bound');
  });

  /**
   * The finding the module exists for: the request says one person and the
   * credential belongs to another. Refused rather than run as either.
   */
  it('refuses a token issued to somebody else', () => {
    const binding = bindTokenToUser(userToken({ sub: 'bob@acme.example' }), 'alice@acme.example', { now: NOW });
    expect(binding).toEqual({ kind: 'mismatch', subject: 'bob@acme.example' });
    expect(isVerified(binding)).toBe(false);
    expect(bindingFailure(binding)).toBe('IDENTITY_MISMATCH');
  });

  it('refuses an expired token before it looks at whose it is', () => {
    const binding = bindTokenToUser(
      userToken({ sub: 'bob@acme.example', exp: NOW - 3600 }),
      'alice@acme.example',
      { now: NOW }
    );
    expect(binding.kind).toBe('expired');
    expect(bindingFailure(binding)).toBe('USER_AUTH_REJECTED');
  });

  /**
   * The app container and the OAuth issuer are different machines. A token with
   * seconds left is not an attack, it is NTP.
   */
  it('tolerates a clock difference rather than reporting an outage as an expiry', () => {
    const within = bindTokenToUser(userToken({ exp: NOW - CLOCK_SKEW_SECONDS + 5 }), 'alice@acme.example', {
      now: NOW,
    });
    expect(within.kind).toBe('bound');
    const beyond = bindTokenToUser(userToken({ exp: NOW - CLOCK_SKEW_SECONDS - 5 }), 'alice@acme.example', {
      now: NOW,
    });
    expect(beyond.kind).toBe('expired');
  });

  it('reports an absent token as absent rather than as a mismatch', () => {
    expect(bindTokenToUser(null, 'alice@acme.example').kind).toBe('absent');
    expect(bindTokenToUser('   ', 'alice@acme.example').kind).toBe('absent');
    expect(bindingFailure({ kind: 'absent' })).toBe('IDENTITY_REQUIRED');
  });
});

/**
 * The asymmetry, tested as behaviour rather than trusted to the comment. A
 * subject that cannot be compared is unproven, and a rule that called it wrong
 * would refuse every request in the workspace on a check that had never once
 * fired correctly.
 */
describe('a subject that cannot be compared is unproven, not wrong', () => {
  it.each([
    ['a numeric SCIM id', jwt({ sub: '4212345', exp: NOW + 60 })],
    ['an opaque personal access token', 'dapi0123456789abcdef'],
    ['a JWT with no subject claim at all', jwt({ scope: 'sql', exp: NOW + 60 })],
  ])('does not refuse %s', (_label, token) => {
    const binding = bindTokenToUser(token, 'alice@acme.example', { now: NOW });
    expect(binding.kind).toBe('unverifiable');
    expect(bindingFailure(binding)).toBeNull();
  });

  it('does not let unverifiable count as verified', () => {
    const binding = bindTokenToUser('dapi0123', 'alice@acme.example', { now: NOW });
    expect(isVerified(binding)).toBe(false);
  });

  /**
   * A numeric id beside an address that disagrees is still a mismatch: the
   * address is comparable, and its being wrong is not made ambiguous by an
   * incomparable claim sitting next to it.
   */
  it('still refuses when an incomparable claim sits beside somebody else\u2019s address', () => {
    const binding = bindTokenToUser(
      jwt({ sub: '4212345', email: 'bob@acme.example', exp: NOW + 60 }),
      'alice@acme.example',
      { now: NOW }
    );
    expect(binding).toEqual({ kind: 'mismatch', subject: 'bob@acme.example' });
  });

  it('cannot verify anything when the request resolved no address', () => {
    expect(bindTokenToUser(userToken(), '', { now: NOW }).kind).toBe('unverifiable');
  });
});

describe('what gets written down', () => {
  it('names both addresses on a mismatch, which is the whole finding', () => {
    const binding = bindTokenToUser(userToken({ sub: 'bob@acme.example' }), 'alice@acme.example', { now: NOW });
    const line = describeBinding(binding, 'alice@acme.example');
    expect(line).toContain('alice@acme.example');
    expect(line).toContain('bob@acme.example');
    expect(line).toContain('IDENTITY_MISMATCH');
  });

  /**
   * A token's claims are credentials. The log line is the surface where they
   * would leak, so it is asserted rather than reviewed.
   */
  it('never puts the token or any other claim in the log line', () => {
    const token = userToken({ scope: 'sql dashboards.genie', client_id: 'secret-client' });
    for (const email of ['alice@acme.example', 'bob@acme.example']) {
      const line = describeBinding(bindTokenToUser(token, email, { now: NOW }), email);
      expect(line).not.toContain(token);
      expect(line).not.toContain('secret-client');
      expect(line).not.toContain('dashboards.genie');
    }
  });
});
