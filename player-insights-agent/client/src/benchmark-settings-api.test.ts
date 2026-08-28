import { describe, expect, it } from 'vitest';
import { DEFAULT_BENCHMARK_SETTINGS } from '../../shared/benchmark-settings';
import { benchmarkSettingsFromResponse } from './benchmark-settings-api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('benchmark settings response', () => {
  it('reads the settings object out of a successful payload', async () => {
    const payload = await benchmarkSettingsFromResponse(
      jsonResponse(200, {
        settings: { ...DEFAULT_BENCHMARK_SETTINGS, evalSetId: 'held-out-eval' },
        experimentUrl: 'https://example.databricks.com/ml/experiments/1',
        currentAgentEndpoint: 'player-insights-agent',
        tracesAlwaysOnInAgent: true,
      }),
      'loaded'
    );
    expect(payload.settings.evalSetId).toBe('held-out-eval');
    expect(payload.experimentUrl).toContain('/ml/experiments/1');
    expect(payload.currentAgentEndpoint).toBe('player-insights-agent');
    expect(payload.tracesAlwaysOnInAgent).toBe(true);
  });

  it('keeps a custom judge in the saved response used to refresh Settings', async () => {
    const customJudge = {
      name: 'English',
      guidelines: 'The response must be in English.',
      prompt: 'Score {{response}} for {{question}} in {{conversation}}.',
    };
    const payload = await benchmarkSettingsFromResponse(
      jsonResponse(200, {
        settings: { ...DEFAULT_BENCHMARK_SETTINGS, customJudges: [customJudge] },
      }),
      'saved'
    );

    expect(payload.settings.customJudges).toEqual([customJudge]);
  });

  it('surfaces the server sentence when a save is refused', async () => {
    await expect(
      benchmarkSettingsFromResponse(
        jsonResponse(503, { detail: 'The settings were not saved: permission denied for benchmark_settings.' }),
        'saved'
      )
    ).rejects.toThrow('The settings were not saved: permission denied for benchmark_settings.');
  });
});
