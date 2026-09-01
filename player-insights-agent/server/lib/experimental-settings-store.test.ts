import { describe, expect, it } from 'vitest';
import {
  EXPERIMENTAL_SETTINGS_TABLE,
  forgetExperimentalSettings,
  readExperimentalSettings,
  writeExperimentalSettings,
} from './experimental-settings-store';

class MemoryExperimentalDb {
  row: { settings: unknown; revision: number } | null = null;
  readonly lakebase = {
    query: (sql: string, values: unknown[] = []) => {
      if (/^SELECT settings, revision/m.test(sql.trim()))
        return Promise.resolve({ rows: this.row ? [{ ...this.row }] : [] });
      if (/^INSERT INTO/m.test(sql.trim())) {
        if (this.row) return Promise.resolve({ rows: [] });
        this.row = { settings: JSON.parse(String(values[1])), revision: 1 };
        return Promise.resolve({ rows: [{ ...this.row }] });
      }
      if (/^UPDATE/m.test(sql.trim())) {
        if (!this.row || this.row.revision !== Number(values[3])) return Promise.resolve({ rows: [] });
        this.row = { settings: JSON.parse(String(values[1])), revision: this.row.revision + 1 };
        return Promise.resolve({ rows: [{ ...this.row }] });
      }
      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
    },
  };
}

describe('deployment-wide Experimental settings', () => {
  it('uses a stable app-global row and defaults only when it is absent', async () => {
    const db = new MemoryExperimentalDb();
    expect(EXPERIMENTAL_SETTINGS_TABLE).toMatch(/\.experimental_settings$/);
    expect((await readExperimentalSettings(db as never, { maxAgeMs: 0 })).settings).toEqual({
      benchmarkLab: false,
      egressControls: false,
      forecasting: false,
    });
    expect(db.row).toBeNull();
  });

  it('keeps true after restart, redeploy, and a changed build SHA', async () => {
    const db = new MemoryExperimentalDb();
    await writeExperimentalSettings(db as never, { benchmarkLab: true }, 0, 'admin');
    process.env.PLAYER_INSIGHTS_BUILD_SHA = 'replacement-build';
    forgetExperimentalSettings();
    expect((await readExperimentalSettings(db as never, { maxAgeMs: 0 })).settings.benchmarkLab).toBe(true);
  });

  it('round-trips true and false distinctly for every visible flag', async () => {
    const db = new MemoryExperimentalDb();
    const on = await writeExperimentalSettings(
      db as never,
      { benchmarkLab: true, egressControls: true, forecasting: true },
      0,
      'admin'
    );
    const off = await writeExperimentalSettings(
      db as never,
      { benchmarkLab: false, egressControls: false, forecasting: false },
      on.revision,
      'admin'
    );
    expect(off.settings).toEqual({ benchmarkLab: false, egressControls: false, forecasting: false });
  });
});
