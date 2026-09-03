import { useCallback, useEffect, useState } from 'react';

import { isLakebaseMigrationReadiness, type LakebaseMigrationReadiness } from '../../shared/lakebase-migrations';
import { fetchWithTimeout } from './fetch-timeout';
import { forgetMonitoringSession } from './monitoring-session';
import { registerSensitiveStateReset } from './sensitive-state-resets';
import { clearUserSpendTotalCache } from './user-spend-total-cache';

export const LAKEBASE_MIGRATION_CLIENT_TIMEOUT_MS = 18_000;

export interface LakebaseMigrationClientState {
  phase: 'idle' | 'loading' | 'ready' | 'applying' | 'error';
  value: LakebaseMigrationReadiness | null;
  error: string;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let remembered: LakebaseMigrationClientState = { phase: 'idle', value: null, error: '' };
let autoClaimed = false;
let checkFlight: Promise<LakebaseMigrationClientState> | null = null;
let applyFlight: Promise<LakebaseMigrationClientState> | null = null;
let generation = 0;

function announce(): void {
  for (const listener of [...listeners]) listener();
}

function remember(next: LakebaseMigrationClientState): LakebaseMigrationClientState {
  remembered = next;
  announce();
  return next;
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function responseContract(path: string, init: RequestInit = {}): Promise<LakebaseMigrationReadiness> {
  const response = await fetchWithTimeout(
    path,
    {
      credentials: 'same-origin',
      ...init,
      headers: { accept: 'application/json', ...init.headers },
    },
    LAKEBASE_MIGRATION_CLIENT_TIMEOUT_MS
  );
  const body: unknown = await response.json().catch(() => null);
  if (!isLakebaseMigrationReadiness(body)) throw new Error('Lakebase migration status was unavailable.');
  return body;
}

export function resetLakebaseMigrationStatus(): void {
  generation += 1;
  remembered = { phase: 'idle', value: null, error: '' };
  autoClaimed = false;
  checkFlight = null;
  applyFlight = null;
  listeners.clear();
}

registerSensitiveStateReset(resetLakebaseMigrationStatus);

export function recallLakebaseMigrationStatus(): LakebaseMigrationClientState {
  return remembered;
}

export async function checkLakebaseMigrationStatus(): Promise<LakebaseMigrationClientState> {
  if (checkFlight) return checkFlight;
  const requestGeneration = generation;
  remember({ phase: 'loading', value: remembered.value, error: '' });
  const flight = responseContract('/api/admin/lakebase/migrations')
    .then((value) => {
      if (requestGeneration !== generation) return remembered;
      return remember({ phase: 'ready', value, error: '' });
    })
    .catch(() => {
      if (requestGeneration !== generation) return remembered;
      return remember({
        phase: 'error',
        value: remembered.value,
        error: 'Lakebase update status could not be checked. Retry from Connections.',
      });
    })
    .finally(() => {
      if (checkFlight === flight) checkFlight = null;
    });
  checkFlight = flight;
  return flight;
}

export function claimLakebaseMigrationCheck(): boolean {
  if (autoClaimed) return false;
  autoClaimed = true;
  return true;
}

export async function applyLakebaseMigrations(): Promise<LakebaseMigrationClientState> {
  if (applyFlight) return applyFlight;
  const requestGeneration = ++generation;
  remember({ phase: 'applying', value: remembered.value, error: '' });
  const flight = responseContract('/api/admin/lakebase/migrations/apply', { method: 'POST' })
    .then((value) => {
      if (requestGeneration !== generation) return remembered;
      if (value.status === 'up_to_date') {
        // The next Monitoring visit must read the newly created serving tables,
        // not replay the "not migrated" response retained earlier this session.
        forgetMonitoringSession();
        clearUserSpendTotalCache();
      }
      return remember({ phase: 'ready', value, error: '' });
    })
    .catch(() => {
      if (requestGeneration !== generation) return remembered;
      return remember({
        phase: 'error',
        value: remembered.value,
        error: 'Lakebase was not updated. Retry when the app database is available.',
      });
    })
    .finally(() => {
      if (applyFlight === flight) applyFlight = null;
    });
  applyFlight = flight;
  return flight;
}

export function useLakebaseMigrationStatus(enabled: boolean): {
  state: LakebaseMigrationClientState;
  apply: () => Promise<LakebaseMigrationClientState>;
} {
  const [, rerender] = useState(0);
  useEffect(() => subscribe(() => rerender((value) => value + 1)), []);
  useEffect(() => {
    if (enabled && claimLakebaseMigrationCheck()) void checkLakebaseMigrationStatus();
  }, [enabled]);
  const apply = useCallback(() => applyLakebaseMigrations(), []);
  return { state: remembered, apply };
}
