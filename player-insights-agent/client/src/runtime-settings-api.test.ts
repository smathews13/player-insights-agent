import { describe, expect, it, vi } from 'vitest';
import { DARK_ENTITY_STYLES, DEFAULT_RUNTIME_SETTINGS, THEME_FONT_COLORS } from '../../shared/runtime-settings';
import {
  RuntimeSettingsDraftConflict,
  runtimeSettingsDocumentFromResponse,
  runtimeSettingsFromResponse,
  saveRuntimeSettingsDraft,
} from './runtime-settings-api';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runtime settings API responses', () => {
  it('returns and validates a complete settings payload', async () => {
    await expect(
      runtimeSettingsFromResponse(json({ settings: DEFAULT_RUNTIME_SETTINGS, revision: 0 }), 'loaded')
    ).resolves.toEqual(DEFAULT_RUNTIME_SETTINGS);
  });

  it('does not default a saved light scheme back to dark on the response path', async () => {
    const light = { ...DEFAULT_RUNTIME_SETTINGS, colorScheme: 'light' as const };
    await expect(runtimeSettingsFromResponse(json({ settings: light, revision: 2 }), 'saved')).resolves.toEqual(light);
  });

  it('sends every theme-owned default when switching a saved dark preference to light', async () => {
    const dark = {
      ...DEFAULT_RUNTIME_SETTINGS,
      colorScheme: 'dark' as const,
      entityStyles: DARK_ENTITY_STYLES,
      fontBodyColor: THEME_FONT_COLORS.dark.body,
      fontMutedColor: THEME_FONT_COLORS.dark.muted,
    };
    const fetcher = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>().mockResolvedValue(
      json({
        settings: DEFAULT_RUNTIME_SETTINGS,
        revision: 2,
        source: 'override',
        canReset: true,
      })
    );

    await expect(
      saveRuntimeSettingsDraft('/api/runtime-settings', dark, DEFAULT_RUNTIME_SETTINGS, 1, fetcher)
    ).resolves.toMatchObject({ settings: DEFAULT_RUNTIME_SETTINGS, revision: 2 });
    const body = fetcher.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') throw new Error('expected JSON request body');
    expect(JSON.parse(body)).toMatchObject({
      revision: 1,
      patch: {
        colorScheme: 'light',
        entityStyles: DEFAULT_RUNTIME_SETTINGS.entityStyles,
        fontBodyColor: THEME_FONT_COLORS.light.body,
        fontMutedColor: THEME_FONT_COLORS.light.muted,
      },
    });
  });

  it('preserves caller preference source and reset capability', async () => {
    await expect(
      runtimeSettingsDocumentFromResponse(
        json({ settings: DEFAULT_RUNTIME_SETTINGS, revision: 2, source: 'override', canReset: true }),
        'loaded'
      )
    ).resolves.toMatchObject({ revision: 2, source: 'override', canReset: true });
  });

  it('surfaces the server detail on a failed save', async () => {
    const response = json(
      {
        error: 'runtime_settings_store_unavailable',
        detail: 'The settings were not saved: permission denied for table runtime_settings',
      },
      503
    );

    await expect(runtimeSettingsFromResponse(response, 'saved')).rejects.toThrow(
      'The settings were not saved: permission denied for table runtime_settings'
    );
  });

  it('distinguishes a malformed success payload from an HTTP failure', async () => {
    await expect(runtimeSettingsFromResponse(json({ settings: {} }), 'loaded')).rejects.toThrow(
      'the server returned an incomplete settings payload'
    );
  });

  it('reports status when a missing route returns HTML', async () => {
    const response = new Response('<!doctype html>', { status: 404, headers: { 'content-type': 'text/html' } });
    await expect(runtimeSettingsFromResponse(response, 'loaded')).rejects.toThrow(
      'answered 404 without an error message'
    );
  });

  it('sends the edited loop values and rebases a disjoint stale revision', async () => {
    const baseline = {
      ...DEFAULT_RUNTIME_SETTINGS,
      loop: { maxSteps: 20, maxToolCalls: 40, maxRunSeconds: 200 },
    };
    const latest = { ...baseline, colorScheme: 'light' as const };
    const saved = { ...latest, loop: DEFAULT_RUNTIME_SETTINGS.loop };
    const fetcher = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(json({ detail: 'stale revision' }, 409))
      .mockResolvedValueOnce(json({ settings: latest, revision: 2 }))
      .mockResolvedValueOnce(json({ settings: saved, revision: 3 }));

    await expect(
      saveRuntimeSettingsDraft('/api/admin/runtime-settings', baseline, DEFAULT_RUNTIME_SETTINGS, 1, fetcher)
    ).resolves.toMatchObject({ settings: saved, revision: 3 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const firstBody = fetcher.mock.calls[0]?.[1]?.body;
    const retryBody = fetcher.mock.calls[2]?.[1]?.body;
    if (typeof firstBody !== 'string' || typeof retryBody !== 'string') throw new Error('expected JSON request bodies');
    expect(JSON.parse(firstBody) as unknown).toEqual({
      revision: 1,
      patch: {
        loop: { maxSteps: 40, maxToolCalls: 80, maxRunSeconds: 600 },
      },
    });
    expect(JSON.parse(retryBody) as unknown).toEqual({
      revision: 2,
      patch: {
        loop: { maxSteps: 40, maxToolCalls: 80, maxRunSeconds: 600 },
      },
    });
  });

  it('keeps a same-field conflicted draft for an explicit second save', async () => {
    const baseline = {
      ...DEFAULT_RUNTIME_SETTINGS,
      loop: { maxSteps: 20, maxToolCalls: 40, maxRunSeconds: 200 },
    };
    const latest = { ...baseline, loop: { ...baseline.loop, maxSteps: 25 } };
    const fetcher = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(json({ detail: 'stale revision' }, 409))
      .mockResolvedValueOnce(json({ settings: latest, revision: 2 }));

    const conflict = await saveRuntimeSettingsDraft(
      '/api/admin/runtime-settings',
      baseline,
      DEFAULT_RUNTIME_SETTINGS,
      1,
      fetcher
    ).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(RuntimeSettingsDraftConflict);
    if (!(conflict instanceof RuntimeSettingsDraftConflict)) throw conflict;
    expect(conflict.latest).toMatchObject({ settings: latest, revision: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
