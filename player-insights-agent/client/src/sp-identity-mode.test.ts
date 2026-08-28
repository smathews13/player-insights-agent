import { describe, expect, it } from 'vitest';
import { EMPTY_SP_IDENTITY } from './identity-settings-api';
import { LEGACY_SP_IDENTITIES_BROWSER_KEY, spIdentityEnabledFromPayload } from './sp-identity-mode';

describe('the deployment-wide SP-identity pivot as the UI reads it', () => {
  it('is off until the payload says exact boolean true', () => {
    expect(spIdentityEnabledFromPayload(undefined)).toBe(false);
    expect(spIdentityEnabledFromPayload(null)).toBe(false);
    expect(spIdentityEnabledFromPayload({})).toBe(false);
    expect(spIdentityEnabledFromPayload(EMPTY_SP_IDENTITY)).toBe(false);
    expect(spIdentityEnabledFromPayload({ ...EMPTY_SP_IDENTITY, enabled: false })).toBe(false);
    for (const enabled of ['true', 'TRUE', 1, '1', 'yes', 'on', { enabled: true }]) {
      expect(spIdentityEnabledFromPayload({ enabled }), JSON.stringify(enabled)).toBe(false);
    }
  });

  it('is on only for the same boolean the server stores as sp-identity-enabled', () => {
    expect(spIdentityEnabledFromPayload({ ...EMPTY_SP_IDENTITY, enabled: true })).toBe(true);
  });

  /**
   * The mismatch: a leftover per-browser key must not be readable as the pivot.
   * Settings used to follow this key while warehouse, Genie, and agent calls
   * followed the server flag.
   */
  it('does not have a browser-preference path back into the pivot', () => {
    expect(LEGACY_SP_IDENTITIES_BROWSER_KEY).toBe('pia.experimental.sp-identities');
    expect(spIdentityEnabledFromPayload({ [LEGACY_SP_IDENTITIES_BROWSER_KEY]: 'true' })).toBe(false);
    expect(spIdentityEnabledFromPayload({ spIdentities: true })).toBe(false);
  });
});
