import { describe, expect, it } from 'vitest';
import type { StoredRole } from './user-roster';
import { resolveCanonicalUserIdentity } from './canonical-user-identity';

function row(email: string, setAt = '2026-09-03T12:00:00.000Z'): StoredRole {
  return { email, role: 'consumer', setBy: 'admin@example.test', setAt };
}

describe('canonical signed-in identity', () => {
  it.each([
    ['employee@example.com', 'employee@example.com', 'employee'],
    ['customer.admin@take2games.com', 'customer.admin@take2games.com', 'customer.admin'],
  ])('keeps the trusted complete forwarded address %s', (forwarded, canonicalEmail, displayName) => {
    expect(resolveCanonicalUserIdentity(forwarded, [])).toMatchObject({ canonicalEmail, displayName });
  });

  it('resolves a local part only through one unique Identity-roster address', () => {
    expect(resolveCanonicalUserIdentity('customer.admin', [row('customer.admin@take2games.com')])).toMatchObject({
      canonicalEmail: 'customer.admin@take2games.com',
      displayName: 'customer.admin',
    });
  });

  it('keeps ambiguous and absent local parts unbranded instead of guessing a domain', () => {
    expect(
      resolveCanonicalUserIdentity('shared.user', [
        row('shared.user@example.com'),
        row('shared.user@take2games.com'),
      ]).canonicalEmail
    ).toBeNull();
    expect(
      resolveCanonicalUserIdentity('missing.user', [row('someone.else@example.com')]).canonicalEmail
    ).toBeNull();
  });

  it('does not let roster data replace a complete proxy-authenticated address', () => {
    expect(
      resolveCanonicalUserIdentity('employee@example.com', [row('employee@take2games.com')]).canonicalEmail
    ).toBe('employee@example.com');
  });

  it('changes the revision when canonical roster evidence changes', () => {
    const before = resolveCanonicalUserIdentity('customer.admin', [
      row('customer.admin@take2games.com'),
    ]).identityRevision;
    const after = resolveCanonicalUserIdentity('customer.admin', [
      row('customer.admin@take2games.com', '2026-09-03T13:00:00.000Z'),
    ]).identityRevision;
    expect(after).not.toBe(before);
  });
});
