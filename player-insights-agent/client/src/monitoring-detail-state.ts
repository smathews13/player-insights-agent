import type { MonitoringFilters } from './monitoring-filters';

export type PanelLoadState<T> =
  | { status: 'idle'; key: ''; requestId: 0; data: null; error: null }
  | { status: 'loading'; key: string; requestId: number; data: null; error: null }
  | { status: 'ready'; key: string; requestId: number; data: T; error: null }
  | { status: 'error'; key: string; requestId: number; data: null; error: string };

export function idlePanel<T>(): PanelLoadState<T> {
  return { status: 'idle', key: '', requestId: 0, data: null, error: null };
}

function normalizedStamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value.trim();
}

/** Entity plus the exact half-open range whose label is on the panel. */
export function monitoringDetailKey(
  kind: 'question' | 'person',
  entity: string,
  from: string,
  to: string,
  cursor = ''
): string {
  return [kind, entity.trim().toLowerCase(), normalizedStamp(from), normalizedStamp(to), cursor].join('|');
}

export function beginPanelLoad<T>(key: string, requestId: number): PanelLoadState<T> {
  return { status: 'loading', key, requestId, data: null, error: null };
}

export function resolvePanelLoad<T>(
  state: PanelLoadState<T>,
  key: string,
  requestId: number,
  data: T
): PanelLoadState<T> {
  if (state.key !== key || state.requestId !== requestId) return state;
  return { status: 'ready', key, requestId, data, error: null };
}

export function rejectPanelLoad<T>(
  state: PanelLoadState<T>,
  key: string,
  requestId: number,
  error: string
): PanelLoadState<T> {
  if (state.key !== key || state.requestId !== requestId) return state;
  return { status: 'error', key, requestId, data: null, error };
}

/** Never expose data completed for a key other than the one now on the URL. */
export function panelStateForKey<T>(state: PanelLoadState<T>, key: string, nextRequestId: number): PanelLoadState<T> {
  if (!key || state.key === key) return state;
  return { status: 'loading', key, requestId: nextRequestId, data: null, error: null };
}

function rangeParams(from: string, to: string): URLSearchParams {
  return new URLSearchParams({ from: normalizedStamp(from), to: normalizedStamp(to) });
}

export function questionDetailUrl(id: string, from: string, to: string): string {
  return `/api/monitoring/questions/${encodeURIComponent(id)}?${rangeParams(from, to).toString()}`;
}

export function personDetailUrl(
  email: string,
  from: string,
  to: string,
  filters: MonitoringFilters,
  cursor: string
): string {
  const params = rangeParams(from, to);
  params.set('limit', '50');
  if (cursor) params.set('cursor', cursor);
  if (filters.outcome) params.set('outcome', filters.outcome);
  if (filters.feedback) params.set('feedback', filters.feedback);
  if (filters.table) params.set('table', filters.table);
  if (filters.search) params.set('q', filters.search);
  return `/api/monitoring/people/${encodeURIComponent(email)}?${params.toString()}`;
}
