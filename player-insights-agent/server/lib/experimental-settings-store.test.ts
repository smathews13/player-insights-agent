import { describe, expect, it } from 'vitest';
import {
  EXPERIMENTAL_SETTINGS_TABLE,
  forgetExperimentalSettings,
  readExperimentalSettings,
  readAiGatewayEnabled,
  readGenieMcpEnabled,
  writeExperimentalSettings,
  withoutLegacySpIdentities,
} from './experimental-settings-store';

class MemoryExperimentalDb {
  row: { settings: unknown; revision: number } | null = null;
  failReads = false;
  readonly lakebase = {
    query: (sql: string, values: unknown[] = []) => {
      if (/^SELECT settings, revision/m.test(sql.trim()))
        if (this.failReads) return Promise.reject(new Error('temporary outage'));
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
      aiGateway: false,
      benchmarkLab: false,
      contractObservatory: false,
      egressControls: false,
      forecasting: false,
      genieCodeMcp: false,
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

  it('never falls back to direct after this process observed Gateway enabled', async () => {
    const db = new MemoryExperimentalDb();
    await writeExperimentalSettings(db as never, { aiGateway: true }, 0, 'admin');
    db.failReads = true;
    await expect(readAiGatewayEnabled(db as never)).resolves.toBe(true);
  });

  it('fails Genie MCP closed when the authoritative setting cannot be read', async () => {
    const db = new MemoryExperimentalDb();
    await writeExperimentalSettings(db as never, { genieCodeMcp: true }, 0, 'admin');
    db.failReads = true;
    await expect(readGenieMcpEnabled(db as never)).resolves.toBe(false);
  });

  it('round-trips true and false distinctly for every visible flag', async () => {
    const db = new MemoryExperimentalDb();
    const on = await writeExperimentalSettings(
      db as never,
      {
        aiGateway: true,
        benchmarkLab: true,
        contractObservatory: true,
        egressControls: true,
        forecasting: true,
        genieCodeMcp: true,
        notebookAgentSync: true,
      },
      0,
      'admin'
    );
    const off = await writeExperimentalSettings(
      db as never,
      {
        aiGateway: false,
        benchmarkLab: false,
        contractObservatory: false,
        egressControls: false,
        forecasting: false,
        genieCodeMcp: false,
        notebookAgentSync: false,
      },
      on.revision,
      'admin'
    );
    expect(off.settings).toEqual({
      aiGateway: false,
      benchmarkLab: false,
      contractObservatory: false,
      egressControls: false,
      forecasting: false,
      genieCodeMcp: false,
      notebookAgentSync: false,
    });
  });

  it('drops legacy SP identity pivots without resetting other flags', async () => {
    const db = new MemoryExperimentalDb();
    db.row = {
      settings: {
        aiGateway: true,
        benchmarkLab: true,
        egressControls: false,
        forecasting: true,
        genieCodeMcp: true,
        notebookAgentSync: true,
        spIdentities: true,
      },
      revision: 7,
    };
    const read = await readExperimentalSettings(db as never, { maxAgeMs: 0 });
    expect(read.settings).toEqual({
      aiGateway: true,
      benchmarkLab: true,
      contractObservatory: false,
      egressControls: false,
      forecasting: true,
      genieCodeMcp: true,
      notebookAgentSync: true,
    });
    const saved = await writeExperimentalSettings(db as never, { forecasting: false }, 7, 'admin');
    expect(saved.settings.notebookAgentSync).toBe(true);
    expect(db.row?.settings).not.toHaveProperty('spIdentities');
    expect(withoutLegacySpIdentities({ spIdentities: false, future: 1 })).toEqual({ future: 1 });
  });
});
