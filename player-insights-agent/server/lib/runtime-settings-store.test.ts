import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_SETTINGS } from '../../shared/runtime-settings';
import {
  forgetRuntimeSettings,
  readRuntimeSettingsDocument,
  writeRuntimeSettingsPatch,
} from './runtime-settings-store';
import { SettingsRevisionConflict } from './versioned-settings-store';

class MemorySettingsDb {
  row: { settings: unknown; revision: number } | null = null;
  failWrite = false;

  readonly lakebase = {
    query: (sql: string, values: unknown[] = []) => {
      if (/^SELECT settings, revision/m.test(sql.trim())) {
        return Promise.resolve({ rows: this.row ? [{ ...this.row }] : [] });
      }
      if (this.failWrite) return Promise.reject(new Error('simulated durable write failure'));
      if (/^INSERT INTO/m.test(sql.trim())) {
        if (this.row) return Promise.resolve({ rows: [] });
        this.row = { settings: JSON.parse(String(values[1])), revision: 1 };
        return Promise.resolve({ rows: [{ ...this.row }] });
      }
      if (/^UPDATE/m.test(sql.trim())) {
        const expected = Number(values[3]);
        if (!this.row || this.row.revision !== expected) return Promise.resolve({ rows: [] });
        this.row = { settings: JSON.parse(String(values[1])), revision: expected + 1 };
        return Promise.resolve({ rows: [{ ...this.row }] });
      }
      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
    },
  };
}

describe('versioned runtime and Appearance settings persistence', () => {
  it('survives a process restart and a different build SHA', async () => {
    const db = new MemorySettingsDb();
    const saved = await writeRuntimeSettingsPatch(db as never, { answer: { takeaway: false } }, 0, 'admin');
    expect(saved.settings.answer.takeaway).toBe(false);

    process.env.PLAYER_INSIGHTS_BUILD_SHA = 'new-build';
    forgetRuntimeSettings();
    const restarted = await readRuntimeSettingsDocument(db as never, { maxAgeMs: 0 });
    expect(restarted.settings.answer.takeaway).toBe(false);
    expect(restarted.revision).toBe(1);
  });

  it('adds a new default without changing an older saved choice', async () => {
    const db = new MemorySettingsDb();
    db.row = {
      settings: {
        ...DEFAULT_RUNTIME_SETTINGS,
        backgroundGraphics: false,
      },
      revision: 1,
    };
    const read = await readRuntimeSettingsDocument(db as never, { maxAgeMs: 0 });
    expect(read.settings.backgroundGraphics).toBe(false);
    expect(read.settings.animations).toBe(true);
  });

  it('preserves unknown newer fields during a partial update', async () => {
    const db = new MemorySettingsDb();
    db.row = {
      settings: {
        ...DEFAULT_RUNTIME_SETTINGS,
        answer: { ...DEFAULT_RUNTIME_SETTINGS.answer, futureAnswerField: 'keep-me' },
        futureRootField: { enabled: true },
      },
      revision: 4,
    };
    await writeRuntimeSettingsPatch(db as never, { answer: { narrative: false } }, 4, 'admin');
    expect(db.row?.settings).toMatchObject({
      answer: { narrative: false, futureAnswerField: 'keep-me' },
      futureRootField: { enabled: true },
    });
  });

  it('protects concurrent partial saves and succeeds after a canonical retry', async () => {
    const db = new MemorySettingsDb();
    await writeRuntimeSettingsPatch(db as never, { loop: { maxSteps: 10 } }, 0, 'first');
    const a = await readRuntimeSettingsDocument(db as never, { maxAgeMs: 0 });
    const b = await readRuntimeSettingsDocument(db as never, { maxAgeMs: 0 });

    await writeRuntimeSettingsPatch(db as never, { appearance: undefined, fontSize: 'l' }, a.revision, 'a');
    await expect(
      writeRuntimeSettingsPatch(db as never, { answer: { charts: false } }, b.revision, 'b')
    ).rejects.toBeInstanceOf(SettingsRevisionConflict);

    const latest = await readRuntimeSettingsDocument(db as never, { maxAgeMs: 0 });
    const retried = await writeRuntimeSettingsPatch(db as never, { answer: { charts: false } }, latest.revision, 'b');
    expect(retried.settings.fontSize).toBe('l');
    expect(retried.settings.answer.charts).toBe(false);
  });

  it('does not announce or cache a failed durable write', async () => {
    const db = new MemorySettingsDb();
    await writeRuntimeSettingsPatch(db as never, { density: 'compact' }, 0, 'admin');
    db.failWrite = true;
    await expect(writeRuntimeSettingsPatch(db as never, { density: 'comfortable' }, 1, 'admin')).rejects.toThrow(
      'simulated durable write failure'
    );
    db.failWrite = false;
    forgetRuntimeSettings();
    expect((await readRuntimeSettingsDocument(db as never, { maxAgeMs: 0 })).settings.density).toBe('compact');
  });
});
