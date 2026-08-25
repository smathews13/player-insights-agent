/**
 * Settings Save must reach Architecture without a remount.
 *
 * The gear is a modal over Architecture, so a one-shot fetch on that page
 * kept showing 100 after 200 was saved. Refresh only re-ran the workspace
 * checks. The live store is the wiring those two screens share.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RUNTIME_SETTINGS } from '../../shared/runtime-settings';
import { adoptRuntimeEntityStyles } from './runtime-entity-styles';
import {
  forgetLiveRuntimeSettings,
  loadLiveRuntimeSettings,
  recalledLiveRuntimeSettings,
  rememberLiveRuntimeSettings,
  subscribeLiveRuntimeSettings,
} from './runtime-settings-live';

const SAVED = {
  ...DEFAULT_RUNTIME_SETTINGS,
  loop: { maxSteps: 10, maxToolCalls: 15, maxRunSeconds: 200 },
  answer: {
    ...DEFAULT_RUNTIME_SETTINGS.answer,
    takeawayGuidance: 'Test',
  },
};

afterEach(() => {
  forgetLiveRuntimeSettings();
  vi.unstubAllGlobals();
});

describe('live runtime settings', () => {
  it('publishes a saved 200s budget to subscribers Architecture reads', () => {
    const seen: number[] = [];
    const stop = subscribeLiveRuntimeSettings(() => {
      seen.push(recalledLiveRuntimeSettings()?.loop.maxRunSeconds ?? 0);
    });
    rememberLiveRuntimeSettings(SAVED);
    stop();
    expect(seen).toEqual([200]);
    expect(recalledLiveRuntimeSettings()?.loop).toEqual({
      maxSteps: 10,
      maxToolCalls: 15,
      maxRunSeconds: 200,
    });
    expect(recalledLiveRuntimeSettings()?.answer.takeawayGuidance).toBe('Test');
  });

  it('treats Appearance Save as the same row Architecture will draw', () => {
    adoptRuntimeEntityStyles(SAVED, { setProperty: vi.fn() });
    expect(recalledLiveRuntimeSettings()?.loop.maxRunSeconds).toBe(200);
  });

  it('reuses the remembered row instead of refetching after Save', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    rememberLiveRuntimeSettings(SAVED);
    await expect(loadLiveRuntimeSettings()).resolves.toEqual(SAVED);
    expect(fetch).not.toHaveBeenCalled();
  });
});
