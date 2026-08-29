import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { notifyBenchmarkSettingsSaved, onBenchmarkSettingsSaved } from './benchmark-settings-events';

const SETTINGS = readFileSync(new URL('./BenchmarkSettingsPanel.tsx', import.meta.url), 'utf8');
const LAB = readFileSync(new URL('./BenchmarkLab.tsx', import.meta.url), 'utf8');

describe('Benchmark settings save refresh', () => {
  it('refreshes mounted readers only after a successful save notification', () => {
    const target = new EventTarget();
    const refresh = vi.fn();
    const unsubscribe = onBenchmarkSettingsSaved(refresh, target);

    expect(refresh).not.toHaveBeenCalled();
    notifyBenchmarkSettingsSaved(target);
    expect(refresh).toHaveBeenCalledTimes(1);

    unsubscribe();
    notifyBenchmarkSettingsSaved(target);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('emits after the save response succeeds and makes mounted Benchmark Lab reload settings', () => {
    const parsedSave = SETTINGS.indexOf("benchmarkSettingsFromResponse(response, 'saved')");
    const refreshHook = SETTINGS.indexOf('onRefresh: notifyBenchmarkSettingsSaved', parsedSave);
    const refusedSave = SETTINGS.indexOf('} catch (caught)', parsedSave);

    expect(parsedSave).toBeGreaterThan(-1);
    expect(refreshHook).toBeGreaterThan(parsedSave);
    expect(refreshHook).toBeLessThan(refusedSave);
    expect(LAB).toContain('onBenchmarkSettingsSaved(loadBenchmarkSettings)');
  });
});
