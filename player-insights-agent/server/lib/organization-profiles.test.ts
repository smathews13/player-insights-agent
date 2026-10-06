import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentOrganizationMappings,
  organizationProfileRefresh,
  refreshOrganizationProfiles,
  resetOrganizationProfileCache,
  setCachedOrganizationProfiles,
} from './organization-profiles';

const row = (domain: string, name: string, monogram = 'XX') => ({
  domain,
  name,
  monogram,
  updated_by: 'a@example.com',
  updated_at: new Date('2026-10-06T00:00:00Z'),
});

describe('organization profile cache', () => {
  beforeEach(() => {
    resetOrganizationProfileCache();
    delete process.env.PLAYER_INSIGHTS_ORGANIZATIONS;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('layers stored edits over deployment configuration and built-ins', () => {
    process.env.PLAYER_INSIGHTS_ORGANIZATIONS = JSON.stringify([
      { domain: 'studio.example', name: 'Configured Studio', monogram: 'CS' },
    ]);
    setCachedOrganizationProfiles([
      { domain: 'studio.example', name: 'Edited Studio', monogram: 'ES' },
      { domain: 'take2games.com', name: 'Take-Two Interactive Software', monogram: 'T2' },
    ]);
    const mappings = currentOrganizationMappings();
    expect(mappings.find((entry) => entry.domain === 'studio.example')).toMatchObject({ name: 'Edited Studio' });
    expect(mappings.find((entry) => entry.id === 'acme-interactive')).toMatchObject({
      name: 'Take-Two Interactive Software',
      logoKey: 'acme',
    });
  });

  it('drops stored rows that no longer validate rather than shipping them', async () => {
    const store = {
      query: vi.fn(() =>
        Promise.resolve({
          rows: [row('good.example', 'Good', 'GD'), row('bad domain', 'Bad'), row('ok.example', '<script>')],
        })
      ),
    };
    await refreshOrganizationProfiles(store, true);
    expect(currentOrganizationMappings().filter((entry) => entry.domain.endsWith('.example'))).toHaveLength(1);
  });

  it('keeps the last good copy and warns once while the table is unreadable', async () => {
    setCachedOrganizationProfiles([{ domain: 'kept.example', name: 'Kept', monogram: 'KP' }]);
    const store = { query: vi.fn(() => Promise.reject(new Error('relation does not exist'))) };
    await refreshOrganizationProfiles(store, true);
    await refreshOrganizationProfiles(store, true);
    expect(currentOrganizationMappings().some((entry) => entry.name === 'Kept')).toBe(true);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('waits for the first read, then lets requests through without waiting', async () => {
    let release: () => void = () => undefined;
    const store = {
      query: vi.fn(
        () =>
          new Promise<{ rows: Record<string, unknown>[] }>((resolve) => {
            release = () => resolve({ rows: [row('late.example', 'Late', 'LT')] });
          })
      ),
    };
    const middleware = organizationProfileRefresh(store);
    const first = vi.fn();
    middleware({} as never, {} as never, first);
    expect(first).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    const second = vi.fn();
    middleware({} as never, {} as never, second);
    expect(second).toHaveBeenCalledTimes(1);
    expect(store.query).toHaveBeenCalledTimes(1);
  });
});
