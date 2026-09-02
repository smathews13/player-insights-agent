import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadExperimentalSettings, saveExperimentalSettings } from './experimental-settings-api';

afterEach(() => vi.unstubAllGlobals());

describe('Experimental settings durable API', () => {
  it('loads a canonical app-global snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            settings: { benchmarkLab: true, egressControls: false, forecasting: true, notebookAgentSync: false },
            revision: 7,
          })
        )
      )
    );
    await expect(loadExperimentalSettings()).resolves.toEqual({
      settings: { benchmarkLab: true, egressControls: false, forecasting: true, notebookAgentSync: false },
      revision: 7,
    });
  });

  it('sends only the changed booleans with the expected revision', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          settings: { benchmarkLab: true, egressControls: false, forecasting: false, notebookAgentSync: false },
          revision: 3,
        })
      )
    );
    vi.stubGlobal('fetch', fetch);
    await saveExperimentalSettings(2, { benchmarkLab: true });
    const body = (fetch.mock.calls[0]?.[1] as RequestInit).body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string)).toEqual({
      revision: 2,
      patch: { benchmarkLab: true },
    });
  });

  it('surfaces a revision conflict as an actionable failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Reload Settings, review the newer values, and try again.' }), {
          status: 409,
        })
      )
    );
    await expect(saveExperimentalSettings(1, { forecasting: true })).rejects.toThrow('Reload Settings');
  });
});
