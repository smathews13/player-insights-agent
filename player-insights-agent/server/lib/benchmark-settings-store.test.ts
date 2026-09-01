import { describe, expect, it } from 'vitest';
import { DEFAULT_BENCHMARK_SETTINGS } from '../../shared/benchmark-settings';
import {
  forgetBenchmarkSettings,
  readBenchmarkSettingsDocument,
  writeBenchmarkSettingsPatch,
} from './benchmark-settings-store';

class MemoryBenchmarkDb {
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

describe('versioned Benchmark settings persistence', () => {
  it('round-trips every Settings field across a new process cache', async () => {
    const db = new MemoryBenchmarkDb();
    const allFields = {
      ...DEFAULT_BENCHMARK_SETTINGS,
      experimentId: '123',
      alwaysOnTraces: false,
      evalSetId: 'held-out-eval' as const,
      compareSideB: 'candidate',
      enabledMultiTurnJudges: ['conversation_completeness'] as const,
      customJudges: [{ name: 'English', guidelines: 'Use English.', prompt: '' }],
    };
    const saved = await writeBenchmarkSettingsPatch(db as never, allFields, 0, 'admin');
    forgetBenchmarkSettings();
    expect(await readBenchmarkSettingsDocument(db as never, { maxAgeMs: 0 })).toEqual(saved);
  });

  it('preserves a newer unknown field when one known field changes', async () => {
    const db = new MemoryBenchmarkDb();
    db.row = {
      settings: { ...DEFAULT_BENCHMARK_SETTINGS, futureJudgePolicy: { threshold: 0.8 } },
      revision: 2,
    };
    await writeBenchmarkSettingsPatch(db as never, { alwaysOnTraces: false }, 2, 'admin');
    expect(db.row?.settings).toMatchObject({
      alwaysOnTraces: false,
      futureJudgePolicy: { threshold: 0.8 },
    });
  });
});
