import { useCallback, useEffect, useRef, useState } from 'react';

import {
  MONITORING_FEEDBACK_PAGE_SIZE,
  MONITORING_FEEDBACK_SCHEMA_REVISION,
  type MonitoringFeedbackPayload,
} from '../../shared/monitoring-feedback-contract';
import { listenForFeedbackChanges } from './feedback-events';
import { beginPanelLoad, idlePanel, type PanelLoadState } from './monitoring-detail-state';

export interface FeedbackBrowserFilters {
  search: string;
  feedback: '' | 'up' | 'down';
  user: string;
  role: string;
  persona: string;
  organization: string;
}

export interface FeedbackBrowserRequest {
  scope: string;
  from: string;
  to: string;
  filters: FeedbackBrowserFilters;
  cursor: string;
}

type Listener = () => void;
const listeners = new Set<Listener>();
const remembered = new Map<string, MonitoringFeedbackPayload>();
const inflight = new Map<string, { controller: AbortController; promise: Promise<void> }>();
let generation = 0;

function announce(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function feedbackBrowserRequestId(request: FeedbackBrowserRequest): string {
  return JSON.stringify({
    scope: request.scope,
    from: request.from,
    to: request.to,
    search: request.filters.search.trim().toLowerCase(),
    feedback: request.filters.feedback,
    user: request.filters.user.trim().toLowerCase(),
    role: request.filters.role,
    persona: request.filters.persona,
    organization: request.filters.organization.trim().toLowerCase(),
    cursor: request.cursor,
    pageSize: MONITORING_FEEDBACK_PAGE_SIZE,
  });
}

export function feedbackBrowserUrl(request: FeedbackBrowserRequest): string {
  const params = new URLSearchParams({
    from: request.from,
    to: request.to,
    limit: String(MONITORING_FEEDBACK_PAGE_SIZE),
  });
  if (request.cursor) params.set('cursor', request.cursor);
  if (request.filters.search) params.set('q', request.filters.search);
  if (request.filters.feedback) params.set('feedback', request.filters.feedback);
  if (request.filters.user) params.set('user', request.filters.user);
  if (request.filters.role) params.set('role', request.filters.role);
  if (request.filters.persona) params.set('persona', request.filters.persona);
  if (request.filters.organization) params.set('organization', request.filters.organization);
  return `/api/monitoring/feedback?${params.toString()}`;
}

function decodeFeedbackPayload(value: unknown): MonitoringFeedbackPayload {
  if (!value || typeof value !== 'object') throw new Error('feedback_payload_missing');
  const payload = value as Partial<MonitoringFeedbackPayload>;
  if (
    payload.schemaRevision !== MONITORING_FEEDBACK_SCHEMA_REVISION ||
    !Array.isArray(payload.rows) ||
    !payload.summary ||
    !payload.filters ||
    !payload.pagination
  ) {
    throw new Error('feedback_payload_stale');
  }
  return payload as MonitoringFeedbackPayload;
}

export function invalidateFeedbackBrowserSession(): void {
  generation += 1;
  for (const read of inflight.values()) read.controller.abort();
  inflight.clear();
  remembered.clear();
  announce();
}

export function forgetFeedbackBrowserSession(): void {
  invalidateFeedbackBrowserSession();
  listeners.clear();
}

async function load(request: FeedbackBrowserRequest, requestId: string): Promise<void> {
  if (remembered.has(requestId) || inflight.has(requestId)) return inflight.get(requestId)?.promise;
  for (const [key, read] of inflight) {
    if (key !== requestId) read.controller.abort();
  }
  const controller = new AbortController();
  const started = generation;
  const promise = fetch(feedbackBrowserUrl(request), { signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error(response.status === 403 ? 'forbidden' : `http_${response.status}`);
      return decodeFeedbackPayload(await response.json());
    })
    .then((payload) => {
      if (!controller.signal.aborted && started === generation) remembered.set(requestId, payload);
    })
    .finally(() => {
      if (inflight.get(requestId)?.controller === controller) inflight.delete(requestId);
      announce();
    });
  inflight.set(requestId, { controller, promise });
  announce();
  return promise;
}

export function useFeedbackBrowser(
  request: FeedbackBrowserRequest,
  enabled: boolean
): {
  state: PanelLoadState<MonitoringFeedbackPayload>;
  retry: () => void;
} {
  const requestId = feedbackBrowserRequestId(request);
  const [, render] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState({ key: '', message: '' });
  const observedGeneration = generation;
  const requestRef = useRef(request);
  useEffect(() => {
    requestRef.current = request;
  }, [request]);
  useEffect(() => subscribe(() => render((value) => value + 1)), []);
  useEffect(() => listenForFeedbackChanges(invalidateFeedbackBrowserSession), []);
  useEffect(() => {
    if (!enabled) return;
    void load(requestRef.current, requestId).catch((failure: unknown) => {
      if (failure instanceof DOMException && failure.name === 'AbortError') return;
      setFailure({
        key: requestId,
        message:
          failure instanceof Error && failure.message === 'forbidden'
            ? 'You do not have access to submitted feedback.'
            : 'Feedback could not be loaded.',
      });
      announce();
    });
  }, [attempt, enabled, observedGeneration, requestId]);

  const retry = useCallback(() => {
    remembered.delete(requestId);
    inflight.get(requestId)?.controller.abort();
    inflight.delete(requestId);
    setFailure({ key: '', message: '' });
    setAttempt((value) => value + 1);
  }, [requestId]);

  if (!enabled) return { state: idlePanel<MonitoringFeedbackPayload>(), retry };
  const payload = remembered.get(requestId);
  if (payload) {
    return {
      state: { status: 'ready', key: requestId, requestId: 0, data: payload, error: null },
      retry,
    };
  }
  if (failure.key === requestId && failure.message) {
    return {
      state: { status: 'error', key: requestId, requestId: 0, data: null, error: failure.message },
      retry,
    };
  }
  return { state: beginPanelLoad<MonitoringFeedbackPayload>(requestId, 0), retry };
}
