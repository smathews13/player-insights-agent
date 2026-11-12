import { describe, expect, it, vi } from 'vitest';

import type { DecisionStore } from './deployment-decisions';
import { IDENTITY_CARRYOVER_DECISION, recordIdentityCarryover, restoreIdentityCarryover } from './identity-carryover';
import { ownsPreferenceDefaults } from './preference-default-owner';

const GIT_DEPLOY = { LAKEBASE_ENDPOINT: 'projects/example/branches/production' };

function storeWith(value: string | null) {
  const calls: { text: string; params: unknown[] }[] = [];
  const store: DecisionStore = {
    query: vi.fn((text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      return Promise.resolve({ rows: text.startsWith('SELECT') && value !== null ? [{ value }] : [] });
    }),
  };
  return { store, calls };
}

const RECORDED = JSON.stringify({
  PLAYER_INSIGHTS_ADMIN_GROUP: 'Example_Admins',
  PLAYER_INSIGHTS_CONSUMER_GROUPS: 'Example_Users,Example_Execs',
  PLAYER_INSIGHTS_SUPER_ADMINS: 'owner@example.test',
  PLAYER_INSIGHTS_PREFERENCE_DEFAULT_OWNER: 'designer@example.test',
});

describe('identity configuration carryover', () => {
  it('restores every key a Git deploy leaves empty', async () => {
    const { store } = storeWith(RECORDED);
    const env: Record<string, string | undefined> = {
      ...GIT_DEPLOY,
      PLAYER_INSIGHTS_ADMIN_GROUP: '',
      PLAYER_INSIGHTS_CONSUMER_GROUPS: '  ',
    };

    await expect(restoreIdentityCarryover(store, env)).resolves.toBe(4);
    expect(env).toMatchObject({
      PLAYER_INSIGHTS_ADMIN_GROUP: 'Example_Admins',
      PLAYER_INSIGHTS_CONSUMER_GROUPS: 'Example_Users,Example_Execs',
      PLAYER_INSIGHTS_SUPER_ADMINS: 'owner@example.test',
      PLAYER_INSIGHTS_PREFERENCE_DEFAULT_OWNER: 'designer@example.test',
    });
  });

  it('keeps a value the artifact states instead of the record', async () => {
    const { store } = storeWith(RECORDED);
    const env: Record<string, string | undefined> = { ...GIT_DEPLOY, PLAYER_INSIGHTS_ADMIN_GROUP: 'New_Admins' };

    await expect(restoreIdentityCarryover(store, env)).resolves.toBe(3);
    expect(env.PLAYER_INSIGHTS_ADMIN_GROUP).toBe('New_Admins');
  });

  it('merges stated values over the record so silent keys keep their value', async () => {
    const { store, calls } = storeWith(RECORDED);
    const env = { ...GIT_DEPLOY, PLAYER_INSIGHTS_ADMIN_GROUP: 'New_Admins' };

    await expect(recordIdentityCarryover(store, env)).resolves.toBe(true);
    const write = calls.find((call) => call.text.startsWith('INSERT'));
    expect(write?.params[0]).toBe(IDENTITY_CARRYOVER_DECISION);
    expect(JSON.parse(String(write?.params[1]))).toEqual({
      ...JSON.parse(RECORDED),
      PLAYER_INSIGHTS_ADMIN_GROUP: 'New_Admins',
    });
  });

  it('never touches the store on a local run', async () => {
    const { store, calls } = storeWith(RECORDED);
    const env: Record<string, string | undefined> = { PLAYER_INSIGHTS_ADMIN_GROUP: 'Local_Admins' };

    await expect(restoreIdentityCarryover(store, env)).resolves.toBe(0);
    await expect(recordIdentityCarryover(store, env)).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('ignores an unreadable record', async () => {
    const { store } = storeWith('not json');
    const env: Record<string, string | undefined> = { ...GIT_DEPLOY };

    await expect(restoreIdentityCarryover(store, env)).resolves.toBe(0);
    expect(env.PLAYER_INSIGHTS_SUPER_ADMINS).toBeUndefined();
  });
});

describe('preference default owner', () => {
  it('follows the configured owner and names nobody when none is configured', () => {
    const previous = process.env.PLAYER_INSIGHTS_PREFERENCE_DEFAULT_OWNER;
    process.env.PLAYER_INSIGHTS_PREFERENCE_DEFAULT_OWNER = 'designer@example.test';
    try {
      expect(ownsPreferenceDefaults(' DESIGNER@example.test ')).toBe(true);
      expect(ownsPreferenceDefaults('someone@example.test')).toBe(false);
      delete process.env.PLAYER_INSIGHTS_PREFERENCE_DEFAULT_OWNER;
      expect(ownsPreferenceDefaults('designer@example.test')).toBe(false);
      expect(ownsPreferenceDefaults('')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PLAYER_INSIGHTS_PREFERENCE_DEFAULT_OWNER;
      else process.env.PLAYER_INSIGHTS_PREFERENCE_DEFAULT_OWNER = previous;
    }
  });
});
