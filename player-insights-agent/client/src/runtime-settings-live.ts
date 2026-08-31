/**
 * The saved runtime settings, as one in-memory row the whole app can read.
 *
 * Settings is a modal over Architecture. Saving 200s there used to update the
 * gear and the next Ask, while Architecture kept the numbers it fetched on
 * mount — so Refresh still showed 100. Appearance already adopted the saved
 * row for colours; the loop tiles did not listen.
 *
 * THIS MODULE IS THAT LISTENER. Load once, remember a successful Save, and
 * every mounted reader (Architecture tiles, entity colours) sees the same
 * row without a remount. Refresh re-reads from the server.
 */
import { useEffect, useState } from 'react';

import { fetchWithTimeout } from './fetch-timeout';
import type { RuntimeSettings } from '../../shared/runtime-settings';

type Listener = () => void;

const listeners = new Set<Listener>();

let current: RuntimeSettings | null = null;
let inflight: Promise<RuntimeSettings | null> | null = null;

/** Longer than a healthy Lakebase read, never an unbounded screen wait. */
export const LIVE_RUNTIME_SETTINGS_TIMEOUT_MS = 5_000;

function announce(): void {
  for (const listener of [...listeners]) listener();
}

export function forgetLiveRuntimeSettings(): void {
  current = null;
  inflight = null;
  listeners.clear();
}

export function recalledLiveRuntimeSettings(): RuntimeSettings | null {
  return current;
}

export function subscribeLiveRuntimeSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What Save just wrote. Architecture must show this without refetching. */
export function rememberLiveRuntimeSettings(settings: RuntimeSettings): void {
  if (current === settings) {
    inflight = Promise.resolve(settings);
    return;
  }
  current = settings;
  inflight = Promise.resolve(settings);
  announce();
}

async function fetchLiveRuntimeSettings(): Promise<RuntimeSettings | null> {
  try {
    // Keep the authoritative Zod response boundary, but load it beside this
    // non-blocking fetch rather than in the initial Ask module graph.
    const [response, { runtimeSettingsFromResponse }] = await Promise.all([
      fetchWithTimeout('/api/runtime-settings', {}, LIVE_RUNTIME_SETTINGS_TIMEOUT_MS),
      import('./runtime-settings-api'),
    ]);
    return await runtimeSettingsFromResponse(response, 'loaded');
  } catch {
    return null;
  }
}

export async function loadLiveRuntimeSettings(): Promise<RuntimeSettings | null> {
  if (current) return current;
  inflight ??= fetchLiveRuntimeSettings().then((loaded) => {
    // A Save can land while this GET is still in flight. Do not put the stale
    // row back over the one the operator just wrote.
    if (current) return current;
    if (loaded) {
      current = loaded;
      announce();
    }
    return loaded;
  });
  return inflight;
}

export async function refreshLiveRuntimeSettings(): Promise<RuntimeSettings | null> {
  inflight = fetchLiveRuntimeSettings().then((loaded) => {
    if (loaded) {
      current = loaded;
      announce();
    }
    return loaded;
  });
  return inflight;
}

/**
 * The stored row, kept in step with Save.
 *
 * Null until a read or a save has landed. Architecture draws an em-dash for
 * that, rather than the shared defaults, because a number nobody checked is
 * a claim about the next Ask.
 */
export function useLiveRuntimeSettings(): RuntimeSettings | null {
  const [, bump] = useState(0);
  useEffect(() => subscribeLiveRuntimeSettings(() => bump((count) => count + 1)), []);
  useEffect(() => {
    void loadLiveRuntimeSettings();
  }, []);
  return recalledLiveRuntimeSettings();
}
