import { describe, expect, it } from 'vitest';
import { DEFAULT_JUDGE_ENDPOINT } from './benchmark-contract';
import {
  CURRENT_AGENT_SIDE,
  DEFAULT_BENCHMARK_SETTINGS,
  BenchmarkSettingsSchema,
  compareSides,
  parseBenchmarkSettings,
  suiteIdFromSettings,
} from './benchmark-settings';

describe('benchmark settings contract', () => {
  it('defaults to always-on traces, the POC suite, and the compiled judge', () => {
    expect(parseBenchmarkSettings(DEFAULT_BENCHMARK_SETTINGS)).toEqual(DEFAULT_BENCHMARK_SETTINGS);
    expect(DEFAULT_BENCHMARK_SETTINGS.alwaysOnTraces).toBe(true);
    expect(DEFAULT_BENCHMARK_SETTINGS.evalSetId).toBe('poc-benchmark');
    expect(DEFAULT_BENCHMARK_SETTINGS.judgeEndpoint).toBe(DEFAULT_JUDGE_ENDPOINT);
    expect(DEFAULT_BENCHMARK_SETTINGS.compareSideA).toBe(CURRENT_AGENT_SIDE);
    expect(DEFAULT_BENCHMARK_SETTINGS.compareSideB).toBe('');
  });

  it('fills missing fields so an older stored row still reads', () => {
    const parsed = parseBenchmarkSettings({
      experimentId: '<mlflow-experiment-id>',
      judgeEndpoint: 'databricks-claude-sonnet-4-5',
    });
    expect(parsed.alwaysOnTraces).toBe(true);
    expect(parsed.evalSetId).toBe('poc-benchmark');
    expect(parsed.compareSideA).toBe(CURRENT_AGENT_SIDE);
    expect(parsed.guidelinesText.length).toBeGreaterThan(0);
    expect(parsed.enabledJudges).toEqual(['groundedness', 'relevance', 'guidelines']);
  });

  it('refuses an invented eval set', () => {
    expect(() => BenchmarkSettingsSchema.parse({ ...DEFAULT_BENCHMARK_SETTINGS, evalSetId: 'customer-data' })).toThrow();
  });

  it('treats a blank or matching side B as a single run', () => {
    expect(compareSides({ compareSideA: 'current', compareSideB: '' })).toEqual(['current']);
    expect(compareSides({ compareSideA: 'current', compareSideB: 'current' })).toEqual(['current']);
    expect(compareSides({ compareSideA: 'current', compareSideB: 'other-agent' })).toEqual(['current', 'other-agent']);
  });

  it('sends the saved eval set as the suite id', () => {
    expect(suiteIdFromSettings({ evalSetId: 'held-out-eval' })).toBe('held-out-eval');
    expect(suiteIdFromSettings({ evalSetId: 'poc-benchmark' })).toBe('poc-benchmark');
    expect(suiteIdFromSettings({ evalSetId: 'operator-eval' })).toBe('operator-eval');
  });
});
