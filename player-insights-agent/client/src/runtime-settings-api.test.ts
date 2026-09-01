import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_SETTINGS } from '../../shared/runtime-settings';
import { runtimeSettingsFromResponse } from './runtime-settings-api';

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
});
