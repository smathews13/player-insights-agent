import { describe, expect, it } from 'vitest';
import {
  SettingsRevisionConflict,
  mergeSettingsPatch,
  readVersionedSettings,
  type VersionedSettingsStore,
} from './versioned-settings-store';

const STORE: VersionedSettingsStore<Record<string, unknown>> = {
  table: 'app.settings',
  key: 'app-global',
  defaults: { enabled: false },
  parse: (value) => value as Record<string, unknown>,
};

describe('versioned settings storage invariants', () => {
  it('deep-merges a partial change without deleting unknown siblings', () => {
    expect(
      mergeSettingsPatch({ answer: { charts: true, future: 'keep' }, futureRoot: 7 }, { answer: { charts: false } })
    ).toEqual({ answer: { charts: false, future: 'keep' }, futureRoot: 7 });
  });

  it('refuses duplicate durable rows rather than choosing one', async () => {
    const client = {
      lakebase: {
        query: () =>
          Promise.resolve({
            rows: [
              { settings: { enabled: true }, revision: 1 },
              { settings: { enabled: false }, revision: 1 },
            ],
          }),
      },
    };
    await expect(readVersionedSettings(client as never, STORE)).rejects.toThrow('More than one durable settings row');
  });

  it('gives revision conflicts an actionable reload instruction', () => {
    expect(new SettingsRevisionConflict().message).toMatch(/Reload Settings/);
  });
});
