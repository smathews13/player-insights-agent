import type { CheckSession } from './check-session';
import {
  checkFor,
  hasRemoteEnd,
  indexChecks,
  readConnection,
  SHOW_NOTEBOOK_DECLARATION_EDITOR,
  type ConnectionReading,
  type ResourceRow,
} from './connection-model';
import type { PreflightCheck } from './preflight';
import { CONNECTED_RESOURCES } from '../../shared/deployment-config';

export type ConnectionResourceLoadState = 'loading' | 'ready' | 'error';

/** Stable registry rows while settings has not supplied its canonical rows yet. */
export function connectionPlaceholderReadings(checks: readonly PreflightCheck[] = []): ConnectionReading[] {
  const indexed = indexChecks(checks);
  return CONNECTED_RESOURCES.filter(
    (resource) =>
      resource.namesRemoteObject && (SHOW_NOTEBOOK_DECLARATION_EDITOR || resource.id !== 'notebook-declaration')
  ).map((resource) => {
    const row: ResourceRow = {
      resource,
      configured: '',
      configuredFrom: '',
      actual: '',
      actualObserved: false,
      intended: null,
      intendedAt: '',
      intendedBy: '',
      editable: false,
      changedByLabel: '',
      changedByNote: '',
    };
    return readConnection({ row, check: checkFor(resource, indexed), findings: [] });
  });
}

/**
 * Decide whether one canonical resource row has enough evidence to speak.
 *
 * Settings carries configured identity and most app-side checks, so rows can
 * settle as soon as that response lands. A remote row without an app-side check
 * waits for preflight. An absent optional connection is settled by settings
 * alone; it must not wait forever for a check that correctly does not exist.
 */
export function connectionResourceLoadState(
  reading: ConnectionReading,
  session: CheckSession | null,
  firstLoad = false
): ConnectionResourceLoadState {
  const load = session?.load;
  if (!load) return firstLoad ? 'loading' : 'ready';

  if (load.settings === 'pending') return 'loading';
  if (reading.check) return 'ready';

  if (load.settings === 'error') {
    return load.report === 'pending' ? 'loading' : 'error';
  }

  if (!hasRemoteEnd(reading.row, reading.check)) return 'ready';
  if (load.report === 'pending') return 'loading';
  if (load.report === 'error') return 'error';
  return 'ready';
}

export function connectionLoadErrorLabel(reading: ConnectionReading): string {
  return `Could not load ${reading.resource.label}. Refresh to try again.`;
}
