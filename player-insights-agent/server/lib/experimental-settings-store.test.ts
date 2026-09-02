import { describe, expect, it } from 'vitest';
import {
  EXPERIMENTAL_SETTINGS_TABLE,
  forgetExperimentalSettings,
  readExperimentalSettings,
  writeExperimentalSettings,
  withoutLegacySpIdentities,
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
      notebookAgentSync: false,
    });
    expect(db.row).toBeNull();
  });

  it('keeps true after restart, redeploy, and a changed build SHA', async () => {
    const db = new MemoryExperimentalDb();
    await writeExperimentalSettings(db as never, { notebookAgentSync: true }, 0, 'admin');
    process.env.PLAYER_INSIGHTS_BUILD_SHA = 'replacement-build';
    forgetExperimentalSettings();
    expect((await readExperimentalSettings(db as never, { maxAgeMs: 0 })).settings.notebookAgentSync).toBe(true);
  });

  it('round-trips true and false distinctly for every visible flag', async () => {
    const db = new MemoryExperimentalDb();
    const on = await writeExperimentalSettings(
      db as never,
      { benchmarkLab: true, egressControls: true, forecasting: true, notebookAgentSync: true },
      0,
      'admin'
    );
    const off = await writeExperimentalSettings(
      db as never,
      { benchmarkLab: false, egressControls: false, forecasting: false, notebookAgentSync: false },
      on.revision,
      'admin'
    );
    expect(off.settings).toEqual({
      benchmarkLab: false,
      egressControls: false,
      forecasting: false,
      notebookAgentSync: false,
    });
  });

  it('drops legacy SP identity pivots without resetting other flags', async () => {
    const db = new MemoryExperimentalDb();
    db.row = {
      settings: {
        benchmarkLab: true,
        egressControls: false,
        forecasting: true,
        notebookAgentSync: true,
        spIdentities: true,
      },
      revision: 7,
    };
    const read = await readExperimentalSettings(db as never, { maxAgeMs: 0 });
    expect(read.settings).toEqual({
      benchmarkLab: true,
      egressControls: false,
      forecasting: true,
      notebookAgentSync: true,
    });
    const saved = await writeExperimentalSettings(db as never, { forecasting: false }, 7, 'admin');
    expect(saved.settings.notebookAgentSync).toBe(true);
    expect(db.row?.settings).not.toHaveProperty('spIdentities');
    expect(withoutLegacySpIdentities({ spIdentities: false, future: 1 })).toEqual({ future: 1 });
  });
});
