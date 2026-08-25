import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_SCHEMA } from '../../shared/app-schema';
import { DEFAULT_BENCHMARK_SETTINGS } from '../../shared/benchmark-settings';
import {
  BENCHMARK_SETTINGS_TABLE,
  forgetBenchmarkSettings,
  readBenchmarkSettings,
  writeBenchmarkSettings,
} from './benchmark-settings-store';

function client(rows: Record<string, unknown>[] = []) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  return {
    calls,
    lakebase: {
      query: (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return Promise.resolve({ rows });
      },
    },
  };
}

describe('benchmark settings persistence', () => {
  it('qualifies the table with APP_SCHEMA so a non-default schema still hits migrations', () => {
    expect(BENCHMARK_SETTINGS_TABLE).toBe(`${APP_SCHEMA}.benchmark_settings`);
    const source = fs.readFileSync(path.join(__dirname, 'benchmark-settings-store.ts'), 'utf8');
    expect(source).toContain("appTable('benchmark_settings')");
  });

  it('uses current behavior when no override exists', async () => {
    forgetBenchmarkSettings();
    expect(await readBenchmarkSettings(client() as never, { maxAgeMs: 0 })).toEqual(DEFAULT_BENCHMARK_SETTINGS);
  });

  it('prefers a stored valid override and writes JSON atomically', async () => {
    const override = {
      ...DEFAULT_BENCHMARK_SETTINGS,
      evalSetId: 'held-out-eval' as const,
      experimentId: '<mlflow-experiment-id>',
    };
    const reader = client([{ settings: override }]);
    expect((await readBenchmarkSettings(reader as never, { maxAgeMs: 0 })).evalSetId).toBe('held-out-eval');

    const writer = client();
    await writeBenchmarkSettings(writer as never, override, 'admin@example.com');
    expect(writer.calls[0]?.sql).toContain(BENCHMARK_SETTINGS_TABLE);
    expect(writer.calls[0]?.values).toEqual(['effective', JSON.stringify(override), 'admin@example.com']);
  });
});
