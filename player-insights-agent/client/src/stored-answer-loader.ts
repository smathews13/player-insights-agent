import { lazy, type LazyExoticComponent } from 'react';

import type StoredAnswerRenderer from './StoredAnswerRenderer';

export type StoredAnswerRendererModule = typeof import('./StoredAnswerRenderer');
type StoredAnswerRendererImporter = () => Promise<StoredAnswerRendererModule>;
export type StoredAnswerRendererPreloader = (() => Promise<StoredAnswerRendererModule>) & {
  peek: () => StoredAnswerRendererModule | null;
};
export type LazyStoredAnswerRenderer = LazyExoticComponent<typeof StoredAnswerRenderer>;

type StoredAnswerHistoryRow = {
  role?: string;
  status?: string | null;
  truncated?: boolean | null;
  duration_ms?: number | null;
};

/**
 * One shared request for the answer-only graph.
 *
 * The rejected request is deliberately forgotten. A transient chunk failure can
 * then be retried while the boundary keeps the stored data in memory, never on
 * screen as unformatted prose. `peek` is the synchronous path after resolution:
 * a later answer does not enter Suspense for an already-loaded module.
 */
export function createStoredAnswerRendererPreloader(
  importer: StoredAnswerRendererImporter = () => import('./StoredAnswerRenderer')
): StoredAnswerRendererPreloader {
  let request: Promise<StoredAnswerRendererModule> | null = null;
  let loaded: StoredAnswerRendererModule | null = null;
  const preload = (() => {
    if (loaded) return Promise.resolve(loaded);
    request ??= importer()
      .catch((error: unknown) => {
        request = null;
        throw error;
      })
      .then((module) => {
        loaded = module;
        return module;
      });
    return request;
  }) as StoredAnswerRendererPreloader;
  preload.peek = () => loaded;
  return preload;
}

export const preloadStoredAnswerRenderer = createStoredAnswerRendererPreloader();

/** Starts prefetch without putting module resolution on the request/SSE path. */
export function startStoredAnswerRendererPreload(
  preload: StoredAnswerRendererPreloader = preloadStoredAnswerRenderer
): void {
  void preload().catch(() => undefined);
}

/**
 * Lets the POST and current stream callback finish before prefetch work begins.
 * Browsers with an idle queue use it; the timer fallback remains fire-and-forget.
 */
export function scheduleStoredAnswerRendererPreload(
  preload: StoredAnswerRendererPreloader = preloadStoredAnswerRenderer,
  schedule: (task: () => void) => void = (task) => {
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      window.requestIdleCallback(task, { timeout: 1_000 });
      return;
    }
    setTimeout(task, 0);
  }
): void {
  if (preload.peek()) return;
  schedule(() => startStoredAnswerRendererPreload(preload));
}

/** Rail summaries and transcript messages both carry proof of a saved answer. */
export function storedHistoryHasAnswers(rows: readonly StoredAnswerHistoryRow[]): boolean {
  return rows.some(
    (row) => row.role === 'assistant' || row.status != null || row.truncated != null || row.duration_ms != null
  );
}

/** Starts one idle prefetch only after a payload proves saved answers exist. */
export function preloadStoredAnswerRendererForHistory(
  rows: readonly StoredAnswerHistoryRow[],
  preload: StoredAnswerRendererPreloader = preloadStoredAnswerRenderer,
  schedule?: (task: () => void) => void
): void {
  if (storedHistoryHasAnswers(rows)) scheduleStoredAnswerRendererPreload(preload, schedule);
}

export function createLazyStoredAnswerRenderer(
  preload: StoredAnswerRendererPreloader = preloadStoredAnswerRenderer
): LazyStoredAnswerRenderer {
  return lazy(preload);
}
